import { createDemoEnvironment } from "./server.ts";

const DEMO_HOST = "127.0.0.1";
const DEMO_PORT = 8010;

const environment = await createDemoEnvironment();
const server = Deno.serve(
  {
    hostname: DEMO_HOST,
    port: DEMO_PORT,
    onListen: () => {
      console.log(`Ubiquity Checkout Anvil demo: http://${DEMO_HOST}:${DEMO_PORT}`);
      console.log("Press Ctrl+C to stop the demo and its local Base fork.");
    },
  },
  environment.handler,
);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.shutdown();
  await environment.close();
}

Deno.addSignalListener("SIGINT", () => {
  void close();
});
Deno.addSignalListener("SIGTERM", () => {
  void close();
});

await server.finished.finally(() => environment.close());
