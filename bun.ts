import { createCheckoutServices, createHandler, runHourlyMaintenance } from "./main.ts";
import { bunServiceOptions, openCheckoutKv, withBunIngress } from "./src/bun_runtime.ts";
import type { Kv } from "./src/kv.ts";

export function startCheckoutServer(options: { kv?: Kv; port?: number; hostname?: string } = {}) {
  const kv = options.kv ?? openCheckoutKv();
  const services = createCheckoutServices(kv, bunServiceOptions);
  const handler = createHandler(services);
  try {
    const server = Bun.serve({
      port: options.port ?? parsePort(process.env.PORT),
      hostname: options.hostname,
      fetch(request, server) {
        return handler(withBunIngress(request, server.requestIP(request)?.address ?? ""));
      },
    });
    let running: Promise<void> | undefined;
    const intervalMs = Number(process.env.CHECKOUT_MAINTENANCE_INTERVAL_MS ?? "");
    const interval =
      Number.isSafeInteger(intervalMs) && intervalMs > 0
        ? setInterval(() => {
            if (running) return;
            running = runHourlyMaintenance(services)
              .catch((error) => console.error("checkout_maintenance_failed", error))
              .finally(() => {
                running = undefined;
              });
          }, intervalMs)
        : undefined;
    return {
      server,
      services,
      async close() {
        if (interval) clearInterval(interval);
        await server.stop(true);
        await running;
        kv.close();
      },
    };
  } catch (error) {
    kv.close();
    throw error;
  }
}

function parsePort(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8000;
}

if (import.meta.main) {
  const app = startCheckoutServer();
  console.log(`Ubiquity Checkout: ${app.server.url}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
}
