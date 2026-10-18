import { readFile } from "node:fs/promises";
import { AUTH_HUB_ORIGIN, LOCAL_PEER_HEADER } from "../src/admin_auth.ts";
import { createRequire } from "node:module";
import type { SigningKeyRecord } from "../src/jws.ts";
import { deepStrictEqual as equal, ok } from "node:assert/strict";
import { resolve } from "node:path";
import { createCheckoutServices } from "../main.ts";
import { UbqKv } from "../src/ubq_kv.ts";
import { verifyCompactJws } from "../src/jws.ts";
import { fixtureScript } from "./worker_fixture.ts";

// The published Miniflare 5 beta declarations reference unpublished internal packages.
// Keep this supported Node control-plane boundary narrow; production Worker types
// are generated and checked separately, and this complete API path runs below.
type HarnessWorker = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  scheduled(options: { cron: string; scheduledTime: number }): Promise<unknown>;
};
type HarnessRuntime = { getWorker(name: string): Promise<HarnessWorker>; dispose(): Promise<void> };
type MiniflareModule = {
  Miniflare: new (options: Record<string, unknown>) => HarnessRuntime;
  convertV4MiniflareOptions(options: Record<string, unknown>): Record<string, unknown>;
};
const loaded: unknown = createRequire(resolve("package.json"))("miniflare");
function isMiniflareModule(value: unknown): value is MiniflareModule {
  return Boolean(
    value &&
    typeof value === "object" &&
    "Miniflare" in value &&
    typeof value.Miniflare === "function" &&
    "convertV4MiniflareOptions" in value &&
    typeof value.convertV4MiniflareOptions === "function",
  );
}
if (!isMiniflareModule(loaded)) throw new Error("miniflare_control_plane_missing");
const { Miniflare, convertV4MiniflareOptions } = loaded;
const path = process.argv[2];
if (!path) throw new Error("worker_bundle_required");
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "checkout",
        modules: true,
        script: await readFile(path, "utf8"),
        compatibilityDate: "2026-10-18",
        compatibilityFlags: ["global_fetch_strictly_public", "no_cots_on_external_fetch"],
        bindings: {
          CHECKOUT_KV_SERVICE_TOKEN: "offline-service-token",
          UOS_VERSION: {
            id: "offline-worker-version",
            tag: "offline",
            timestamp: "2026-10-18T00:00:00.000Z",
          },
        },
        serviceBindings: { UOS_KV: "fixture" },
        outboundService: "fixture",
        assets: { directory: resolve("public"), binding: "ASSETS", run_worker_first: true },
      },
      {
        name: "fixture",
        modules: true,
        script: fixtureScript,
        compatibilityDate: "2026-10-18",
      },
    ],
  }),
);
try {
  const store = await mf.getWorker("fixture");
  const worker = await mf.getWorker("checkout");
  const kv = new UbqKv({
    url: "https://kv.invalid",
    token: "offline-service-token",
    fetchImpl: async (input, init) => {
      const response = await store.fetch(input, {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: typeof init.body === "string" ? init.body : undefined,
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    },
  });
  const seed = createCheckoutServices(kv, { resolveDns: async () => ["93.184.216.34"] });
  await seed.payment.configureChain(8453, {
    enabled: true,
    treasuryAddress: "0x1111111111111111111111111111111111111111",
  });
  await seed.payment.publishCatalogVersion({ merchantId: "merchant-a" }, "worker-v1", {
    currency: "USD",
    products: [
      {
        productId: "pack:worker",
        label: "Worker",
        kind: "credit_pack",
        priceCents: 500,
        enabled: true,
      },
    ],
  });
  await seed.merchantAuth.upsertMerchant({
    id: "merchant-a",
    name: "Offline merchant",
    settlementWebhookUrl: "https://merchant.example/events",
  });
  const { token } = await seed.merchantAuth.createKey({
    merchantId: "merchant-a",
    label: "Offline fixture",
  });
  const jwks = await seed.payment.jwks();
  const activeKey = ["uos_checkout", "v1", "jws", "active"];
  const legacySigning = (await kv.get<SigningKeyRecord>(activeKey)).value;
  await store.fetch("https://kv.invalid/kv/set", {
    method: "POST",
    headers: { authorization: "Bearer offline-service-token", "content-type": "application/json" },
    body: JSON.stringify({ key: activeKey, value: legacySigning }),
  });
  const beforeReads = (await (await store.fetch("https://fixture.invalid/stats")).json()) as {
    writes: number;
  };
  const health = await worker.fetch("https://checkout.ubq.fi/api/health");
  equal(await health.json(), { status: "ready" });
  equal(health.headers.get("x-uos-runtime"), "cloudflare-workers");
  equal(health.headers.get("x-uos-version"), "offline-worker-version");
  for (const origin of ["https://checkout.ubq.fi", "http://localhost:8787"]) {
    const session = await worker.fetch(`${origin}/api/v1/admin/session`, {
      headers: { [LOCAL_PEER_HEADER]: "127.0.0.1", "cf-connecting-ip": "127.0.0.1" },
    });
    equal(((await session.json()) as { authenticated: boolean }).authenticated, false);
    equal(
      (
        await worker.fetch(`${origin}/api/v1/admin/overview`, {
          headers: { [LOCAL_PEER_HEADER]: "127.0.0.1" },
        })
      ).status,
      401,
    );
  }
  const index = await worker.fetch("https://checkout.ubq.fi/");
  equal(index.status, 200);
  ok((await index.text()).includes("Ubiquity Checkout"));
  ok(index.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
  for (const asset of ["/styles.css", "/app.js", "/index.html"]) {
    const response = await worker.fetch(`https://checkout.ubq.fi${asset}`);
    equal(response.status, 200);
    ok((await response.text()).length > 100);
  }
  const head = await worker.fetch("https://checkout.ubq.fi/app.js", { method: "HEAD" });
  equal(head.status, 200);
  equal(await head.text(), "");
  equal((await worker.fetch("https://checkout.ubq.fi/unknown")).status, 404);
  equal(
    (await worker.fetch("https://checkout.ubq.fi/deliver", { method: "POST", body: "{}" })).status,
    404,
  );
  const login = await worker.fetch("https://checkout.ubq.fi/api/auth/login", {
    redirect: "manual",
  });
  equal(login.status, 302);
  ok(login.headers.get("location")?.startsWith(AUTH_HUB_ORIGIN + "/"));
  equal(
    (await worker.fetch("https://checkout.ubq.fi/api/v1/invoices", { method: "POST", body: "{}" }))
      .status,
    401,
  );
  equal(await (await worker.fetch("https://checkout.ubq.fi/.well-known/jwks.json")).json(), jwks);
  equal(await (await worker.fetch("https://checkout.ubq.fi/.well-known/jwks.json")).json(), jwks);
  const afterReads = (await (await store.fetch("https://fixture.invalid/stats")).json()) as {
    writes: number;
  };
  equal(
    afterReads.writes,
    beforeReads.writes,
    "candidate GET checks must not write production-shaped storage",
  );
  const create = () =>
    worker.fetch("https://checkout.ubq.fi/api/v1/invoices", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "offline-attempt",
      },
      body: JSON.stringify({
        customerReference: "customer-a",
        pricingVersionId: "worker-v1",
        productId: "pack:worker",
        chainId: 8453,
      }),
    });
  const created = await create();
  equal(created.status, 201);
  const invoice = (await created.json()) as {
    id: string;
    paidAmountUnits: string;
    listAmountUnits: string;
    tokenAddress: string;
    treasuryAddress: string;
    minimumBlock: string;
  };
  ok(BigInt(invoice.paidAmountUnits) < BigInt(invoice.listAmountUnits));
  equal(((await (await create()).json()) as { id: string }).id, invoice.id);
  const read = await worker.fetch(`https://checkout.ubq.fi/api/v1/invoices/${invoice.id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  equal(((await read.json()) as { id: string }).id, invoice.id);

  const transactionHash = "0x" + "11".repeat(32);
  await store.fetch("https://fixture.invalid/rpc-fixture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transactionHash,
      tokenAddress: invoice.tokenAddress,
      treasuryAddress: invoice.treasuryAddress,
      amountUnits: invoice.paidAmountUnits,
      blockNumber: invoice.minimumBlock,
    }),
  });
  const claim = () =>
    worker.fetch(`https://checkout.ubq.fi/api/v1/invoices/${invoice.id}/claims`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        transactionHash,
        logIndex: "7",
        observedBlockNumber: invoice.minimumBlock,
        observedBlockHash: "0x" + "ab".repeat(32),
      }),
    });
  const claimed = await claim();
  if (claimed.status !== 200) {
    const error = await claimed.text();
    throw new Error(`payment_claim_failed:${error}`);
  }
  const accepted = (await claimed.json()) as {
    invoice: { id: string; status: string };
    eventJws: string;
  };
  equal(accepted.invoice.status, "provisionally_paid");
  const event = await verifyCompactJws(accepted.eventJws, jwks);
  equal((event.payload as { type: string; invoiceId: string }).type, "payment.accepted.v1");
  equal((event.payload as { invoiceId: string }).invoiceId, invoice.id);
  const replay = await claim();
  equal(replay.status, 200);
  equal(
    ((await replay.json()) as { invoice: { status: string } }).invoice.status,
    "provisionally_paid",
  );
  const persisted = await kv.get<{ status: string; paidAmountUnits: bigint }>([
    "uos_checkout",
    "v1",
    "payments",
    "invoices",
    invoice.id,
  ]);
  equal(persisted.value?.status, "provisionally_paid");
  equal(persisted.value?.paidAmountUnits, BigInt(invoice.paidAmountUnits));
  const payments = ["uos_checkout", "v1", "payments"];
  const nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  await kv.set([...payments, "events", "offline-event"], {
    schemaVersion: 1,
    id: "offline-event",
    invoiceId: invoice.id,
    paymentId: "offline-payment",
    type: "payment.accepted.v1",
    payload: { merchantId: "merchant-a", type: "payment.accepted.v1" },
    compactJws: "regenerated-at-delivery",
    createdAt: nextAttemptAt,
    deliveryAttempts: 0,
    nextAttemptAt,
  });
  await kv.set(
    [...payments, "outbox", new Date(nextAttemptAt).getTime(), "offline-event"],
    "offline-event",
  );
  await worker.scheduled({
    cron: "* * * * *",
    scheduledTime: Math.floor(Date.now() / 180_000) * 180_000 + 120_000,
  });
  const delivery = (await (await store.fetch("https://fixture.invalid/relay-log")).json()) as {
    url: string;
    eventJws: string;
  };
  equal(delivery.url, "https://merchant.example/events");
  const verified = await verifyCompactJws(delivery.eventJws, jwks);
  equal((verified.payload as { jti: string }).jti, "offline-event");
  ok(
    (await kv.get<{ deliveredAt: string }>([...payments, "events", "offline-event"])).value
      ?.deliveredAt,
  );
  equal(
    (await kv.get([...payments, "outbox", new Date(nextAttemptAt).getTime(), "offline-event"]))
      .value,
    null,
  );
  ok(
    ((await (await store.fetch("https://fixture.invalid/stats")).json()) as { rpcCalls: number })
      .rpcCalls > 0,
  );
  console.log(
    "workerd: routes, socket-marker stripping, assets/CSP/HEAD, Auth Hub redirect, authenticated merchant invoice/idempotency, canonical payment transition and signed replay, persistent JWKS, D1 protocol and cron/JWS delivery passed; all upstreams isolated",
  );
} finally {
  await mf.dispose();
}
