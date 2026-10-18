import { createCheckoutServices, createHandler, deliverOutbox, withPeerAddress } from "./main.ts";
import { UbqKv } from "./src/ubq_kv.ts";
import { createWorkerTransport } from "./src/worker_transport.ts";
import { WorkerBudgetError, WorkerRequestBudget } from "./src/worker_budget.ts";
import { maintenanceChainAt, reconcileInvoiceBatch } from "./src/reconciliation_batch.ts";

function services(env: Env, budget: WorkerRequestBudget) {
  if (!env.CHECKOUT_KV_SERVICE_TOKEN) throw new Error("checkout_kv_not_configured");
  const network = budget.wrap(fetch);
  const storage = budget.wrap((input, init) => env.UOS_KV.fetch(input, init));
  const kv = new UbqKv({
    url: "https://kv.ubq.fi",
    token: env.CHECKOUT_KV_SERVICE_TOKEN,
    fetchImpl: storage,
  });
  return createCheckoutServices(kv, {
    ...createWorkerTransport(network),
    assetFetcher: (request) => {
      budget.reserve();
      return env.ASSETS.fetch(request);
    },
    fetch: network,
    discovery: { budget, deadline: Date.now() + 20_000 },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const budget = new WorkerRequestBudget(24, request.signal);
      // Edge requests never supply local socket authority, regardless of Host.
      const response = await createHandler(services(env, budget))(withPeerAddress(request, ""));
      return identifyRelease(response, env);
    } catch {
      console.error(JSON.stringify({ message: "checkout_worker_unavailable" }));
      return identifyRelease(Response.json({ error: "service_unavailable" }, { status: 503 }), env);
    }
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const deadline = Date.now() + 20_000;
    const budget = new WorkerRequestBudget(24, AbortSignal.timeout(20_000));
    const app = services(env, budget);
    const chainId = maintenanceChainAt(controller.scheduledTime);
    try {
      // Prioritize one durable delivery; unattempted entries retain their retry state.
      await deliverOutbox(app, deadline, 1);
      await reconcileInvoiceBatch(app, chainId);
    } catch (error) {
      if (!(error instanceof WorkerBudgetError) && !budgetExpired(error)) throw error;
      console.log(JSON.stringify({ message: "checkout_maintenance_yielded" }));
    }
  },
} satisfies ExportedHandler<Env>;

function budgetExpired(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function identifyRelease(response: Response, env: Env): Response {
  response.headers.set("x-uos-runtime", "cloudflare-workers");
  response.headers.set("x-uos-version", env.UOS_VERSION.id);
  return response;
}
