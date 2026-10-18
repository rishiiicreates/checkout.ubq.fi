import { createDemoEnvironment, type DemoEnvironment } from "./server.ts";

const DEMO_HOST = "127.0.0.1";
const DEMO_PORT = 8010;

export async function startDemoServer(
  environment: DemoEnvironment,
  serve: typeof Bun.serve = Bun.serve,
) {
  try {
    return serve({ hostname: DEMO_HOST, port: DEMO_PORT, fetch: environment.handler });
  } catch (error) {
    await environment.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const environment = await createDemoEnvironment();
  const server = await startDemoServer(environment);
  console.log(`Ubiquity Checkout Anvil demo: ${server.url}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.stop(true);
    await environment.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
}

if (import.meta.main) await main();
