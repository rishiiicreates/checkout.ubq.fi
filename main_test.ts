import {
  type CheckoutServices,
  createCheckoutServices,
  createHandler,
  deliverOutbox,
  withPeerAddress,
} from "./main.ts";
import { LOCAL_PEER_HEADER } from "./src/admin_auth.ts";
import type { JsonRpcBatchItem, JsonRpcCall, RpcClient } from "./src/rpc.ts";
import { verifyCompactJws } from "./src/jws.ts";
import { scheduleWork, workKey } from "./src/work_queue.ts";

const TREASURY = "0x1111111111111111111111111111111111111111";

Deno.test("local operator configures Checkout without a bootstrap password", async () => {
  await withApp(async ({ request }) => {
    const session = await request("/api/v1/admin/session");
    assertEquals(session.status, 200);
    const sessionBody = await session.json();
    assertEquals(sessionBody.authenticated, true);
    assertEquals(sessionBody.member.role, "owner");

    const rejected = await request("/api/v1/admin/chains/8453", {
      method: "PUT",
      body: { enabled: true, treasuryAddress: TREASURY },
    });
    assertEquals(rejected.status, 403);

    const configured = await request("/api/v1/admin/chains/8453", {
      method: "PUT",
      adminMutation: true,
      body: { enabled: true, treasuryAddress: TREASURY },
    });
    assertEquals(configured.status, 200);

    const merchant = await request("/api/v1/admin/merchants/linkedin-scraper-2025", {
      method: "PUT",
      adminMutation: true,
      body: {
        name: "LinkedIn Sales Agent",
        settlementWebhookUrl: "https://webhook.example/api/billing/crypto-settlements",
      },
    });
    assertEquals(merchant.status, 200);

    const key = await request("/api/v1/admin/merchant-keys", {
      method: "POST",
      adminMutation: true,
      body: { merchantId: "linkedin-scraper-2025", label: "Local integration" },
    });
    assertEquals(key.status, 201);
    const keyBody = await key.json();
    assert(String(keyBody.token).startsWith("uos_checkout_"));
    assertEquals("tokenHash" in keyBody.key, false);

    const invited = await request("/api/v1/admin/members/operator", {
      method: "PUT",
      adminMutation: true,
      body: { role: "viewer" },
    });
    assertEquals(invited.status, 200);
    assertEquals((await invited.json()).invitation.handle, "operator");
    const access = await request("/api/v1/admin/members");
    const accessBody = await access.json();
    assertEquals(accessBody.invitations.length, 1);

    const overview = await request("/api/v1/admin/overview");
    const overviewBody = await overview.json();
    assertEquals(overviewBody.chains.length, 3);
    assertEquals(
      overviewBody.chains.find((chain: { chainId: number }) => chain.chainId === 8453).enabled,
      true,
    );
    assertEquals("ok" in overviewBody, false);
  });
});

Deno.test("merchant API publishes an immutable catalog and creates an idempotent exact invoice", async () => {
  await withApp(async ({ request }) => {
    await request("/api/v1/admin/chains/8453", {
      method: "PUT",
      adminMutation: true,
      body: { enabled: true, treasuryAddress: TREASURY },
    });

    const catalog = await request("/api/v1/catalog/versions/pricing-2026-07-21", {
      method: "PUT",
      body: {
        currency: "USD",
        products: [{
          productId: "pack:starter",
          label: "Starter",
          kind: "credit_pack",
          priceCents: 2_000,
          enabled: true,
        }],
      },
    });
    assertEquals(catalog.status, 200);

    const input = {
      customerReference: "user-123",
      pricingVersionId: "pricing-2026-07-21",
      productId: "pack:starter",
      chainId: 8453,
    };
    const first = await request("/api/v1/invoices", {
      method: "POST",
      headers: { "idempotency-key": "invoice-attempt-1" },
      body: input,
    });
    assertEquals(first.status, 201);
    const invoice = await first.json();
    assertEquals(invoice.chainId, 8453);
    assertEquals(invoice.treasuryAddress, TREASURY);
    assert(BigInt(invoice.paidAmountUnits) < BigInt(invoice.listAmountUnits));
    assertEquals("customerReference" in invoice, false);
    assertEquals("idempotencyKey" in invoice, false);

    const retry = await request("/api/v1/invoices", {
      method: "POST",
      headers: { "idempotency-key": "invoice-attempt-1" },
      body: input,
    });
    assertEquals((await retry.json()).id, invoice.id);

    const loaded = await request(`/api/v1/invoices/${invoice.id}`);
    assertEquals(loaded.status, 200);
    assertEquals((await loaded.json()).id, invoice.id);
  });
});

Deno.test("reading an invoice never performs expiration writes", async () => {
  let reads = 0;
  let expirations = 0;
  const services = {
    merchantAuth: {
      authenticate: () =>
        Promise.resolve({
          merchant: { id: "merchant" },
        }),
    },
    payment: {
      getInvoiceRecord: () => Promise.resolve({ merchant: "merchant" }),
      getInvoice: () => {
        reads++;
        return Promise.resolve({ id: "invoice", status: "awaiting_payment" });
      },
      expireInvoice: () => {
        expirations++;
        return Promise.resolve({ id: "invoice", status: "expired" });
      },
    },
  } as unknown as CheckoutServices;
  const response = await createHandler(services)(
    new Request("https://checkout.ubq.fi/api/v1/invoices/invoice"),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).status, "awaiting_payment");
  assertEquals(reads, 1);
  assertEquals(expirations, 0);
});

Deno.test("claim route accepts discovery or exactly four coordinates and preserves merchant ownership", async () => {
  let discoveries = 0;
  let coordinates = 0;
  let merchant = "merchant";
  const services = {
    merchantAuth: {
      authenticate: (_request: Request, scopes: string[]) => {
        assertEquals(scopes, ["claim:create"]);
        return Promise.resolve({ merchant: { id: "merchant" } });
      },
    },
    payment: {
      getInvoiceRecord: () => Promise.resolve({ merchant }),
      discoverPayment: () => {
        discoveries++;
        return Promise.resolve({
          invoice: { id: "invoice", status: "awaiting_payment" },
          discovery: { found: false, searchedToBlock: "100" },
        });
      },
      claimPayment: () => {
        coordinates++;
        return Promise.resolve({
          invoice: { id: "invoice", status: "provisionally_paid" },
          eventJws: "signed",
        });
      },
    },
  } as unknown as CheckoutServices;
  const handler = createHandler(services);
  const send = (body: unknown) =>
    handler(
      new Request("https://checkout.ubq.fi/api/v1/invoices/invoice/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const discovery = await send({});
  assertEquals(discovery.status, 200);
  assertEquals((await discovery.json()).discovery, { found: false, searchedToBlock: "100" });
  const locator = {
    transactionHash: "tx",
    logIndex: "0",
    observedBlockNumber: "100",
    observedBlockHash: "block",
  };
  assertEquals((await send(locator)).status, 200);
  for (
    const body of [{ transactionHash: "tx" }, { ...locator, discover: true }, { discover: true }]
  ) {
    assertEquals((await send(body)).status, 400);
  }
  merchant = "other";
  assertEquals((await send({})).status, 404);
  assertEquals(discoveries, 1);
  assertEquals(coordinates, 1);
});

Deno.test("public origins cannot forge loopback trust", async () => {
  await withApp(async ({ handler }) => {
    const forged = await handler(
      new Request("https://checkout.ubq.fi/api/v1/invoices", {
        method: "POST",
        headers: {
          [LOCAL_PEER_HEADER]: "127.0.0.1",
          "content-type": "application/json",
          "idempotency-key": "forged",
        },
        body: JSON.stringify({}),
      }),
    );
    assertEquals(forged.status, 401);

    const original = new Request("http://localhost:8000/api/health", {
      headers: { [LOCAL_PEER_HEADER]: "127.0.0.1" },
    });
    const stripped = withPeerAddress(original, "203.0.113.8");
    assertEquals(stripped.headers.has(LOCAL_PEER_HEADER), false);
  });
});

Deno.test("health, JWKS, and branded static assets are public", async () => {
  await withApp(async ({ request }) => {
    const health = await request("/api/health");
    assertEquals(await health.json(), { status: "ready" });

    const jwks = await request("/.well-known/jwks.json");
    const jwksBody = await jwks.json();
    assertEquals(jwksBody.keys.length, 1);
    assertEquals(jwksBody.keys[0].alg, "RS256");

    const index = await request("/");
    assert((await index.text()).includes("Ubiquity Checkout"));
    assert((index.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));
  });
});

Deno.test("webhook delivery paginates, isolates failures, forbids redirects, and carries a timeout", async () => {
  const failed: string[] = [];
  const delivered: string[] = [];
  const attempts: string[] = [];
  const events = Array.from({ length: 101 }, (_, index) => {
    const id = index === 0 ? "poison" : `healthy-${index}`;
    return { id, payload: { merchantId: id } };
  });
  const services = {
    payment: {
      listOutbox: (limit: number) => Promise.resolve(events.splice(0, limit)),
      markOutboxFailed: (id: string) => {
        failed.push(id);
        return Promise.resolve();
      },
      markOutboxDelivered: (id: string) => {
        delivered.push(id);
        return Promise.resolve();
      },
    },
    merchantAuth: {
      getMerchant: (id: string) =>
        Promise.resolve({
          id,
          settlementWebhookUrl: `https://${id}.example/hook`,
        }),
      resolveWebhookTarget: (url: string) =>
        Promise.resolve({
          url: new URL(url),
          addresses: ["93.184.216.34"],
        }),
    },
    webhookSender: ((_target, _body, signal) => {
      assert(signal instanceof AbortSignal);
      const merchantId = attempts.length === 0 ? "poison" : `healthy-${attempts.length}`;
      attempts.push(merchantId);
      if (attempts.length === 1) return Promise.reject(new Error("poison webhook"));
      return Promise.resolve({ status: 204, ok: true });
    }) as CheckoutServices["webhookSender"],
  } as unknown as CheckoutServices;

  await deliverOutbox(services);
  assertEquals(failed, ["poison"]);
  assertEquals(delivered.length, 100);
  assertEquals(delivered.at(-1), "healthy-100");
  assertEquals(attempts.length, 101);
});

Deno.test("delivery jobs serialize duplicate messages, persist retries, renew JWS, and ignore delivered events", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = Date.parse("2026-10-17T12:00:00Z");
  const bodies: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const services = createCheckoutServices(kv, {
    clock: { now: () => new Date(now) },
    rpc: new StaticRpc(),
    resolveDns: () => Promise.resolve(["93.184.216.34"]),
    webhookSender: async (_target, body, signal) => {
      assert(signal instanceof AbortSignal);
      bodies.push(body);
      if (bodies.length === 1) {
        entered.resolve();
        await release.promise;
        return { status: 503, ok: false };
      }
      return { status: 204, ok: true };
    },
  });
  try {
    await services.merchantAuth.upsertMerchant({
      id: "merchant",
      name: "Merchant",
      settlementWebhookUrl: "https://merchant.example/hook",
    });
    await seedDelivery(kv, "event", "merchant", now);
    await services.payment.recoverWork();
    const running = services.work.runDue();
    await entered.promise;
    await services.work.runDue();
    assertEquals(bodies.length, 1);
    release.resolve();
    await running;
    await services.work.runDue();
    assertEquals(bodies.length, 1);
    const retry = await services.payment.getOutboxEvent("event");
    assertEquals(retry?.deliveryAttempts, 1);
    assertEquals(retry?.nextAttemptAt, new Date(now + 60_000).toISOString());
    now += 25 * 60 * 60_000;
    const restarted = createCheckoutServices(kv, {
      clock: { now: () => new Date(now) },
      rpc: new StaticRpc(),
      resolveDns: () => Promise.resolve(["93.184.216.34"]),
      webhookSender: (_target, body) => {
        bodies.push(body);
        return Promise.resolve({ status: 204, ok: true });
      },
    });
    await restarted.payment.recoverWork();
    await restarted.work.runDue();
    assertEquals(bodies.length, 2);
    const claims = await Promise.all(
      bodies.map(async (body) =>
        (await verifyCompactJws(JSON.parse(body).eventJws, await services.payment.jwks()))
          .payload as Record<string, unknown>
      ),
    );
    assertEquals(claims[0].jti, claims[1].jti);
    assert(Number(claims[1].iat) > Number(claims[0].iat));
    assert(Number(claims[1].exp) > Number(claims[0].exp));
    await scheduleWork(kv.atomic(), "deliver_event", "event", now, now).commit();
    await restarted.work.runDue();
    assertEquals(bodies.length, 2);
    assertEquals((await kv.get(workKey("deliver_event", "event"))).value, null);
  } finally {
    release.resolve();
    kv.close();
  }
});

Deno.test("poison delivery jobs do not block healthy events and future retries are not due", async () => {
  const kv = await Deno.openKv(":memory:");
  const now = Date.parse("2026-10-17T12:00:00Z");
  let sends = 0;
  const services = createCheckoutServices(kv, {
    clock: { now: () => new Date(now) },
    rpc: new StaticRpc(),
    resolveDns: () => Promise.resolve(["93.184.216.34"]),
    webhookSender: () => {
      sends++;
      return Promise.resolve({ status: 204, ok: true });
    },
  });
  try {
    await services.merchantAuth.upsertMerchant({
      id: "healthy",
      name: "Healthy",
      settlementWebhookUrl: "https://healthy.example/hook",
    });
    await seedDelivery(kv, "poison", "missing", now);
    await seedDelivery(kv, "healthy", "healthy", now);
    await services.payment.recoverWork();
    await services.work.runDue();
    assertEquals(sends, 1);
    assertEquals((await services.payment.getOutboxEvent("poison"))?.deliveryAttempts, 1);
    assertEquals(await services.payment.getOutboxEvent("healthy"), null);
    assertEquals((await services.payment.listOutbox()).length, 0);
  } finally {
    kv.close();
  }
});

async function seedDelivery(
  kv: Deno.Kv,
  id: string,
  merchantId: string,
  now: number,
): Promise<void> {
  await kv.set(["uos_checkout", "v1", "payments", "events", id], {
    schemaVersion: 1,
    id,
    invoiceId: "invoice",
    paymentId: "payment",
    type: "payment.accepted.v1",
    payload: { merchantId, invoiceId: "invoice", jti: id },
    compactJws: "stale",
    createdAt: new Date(now).toISOString(),
    deliveryAttempts: 0,
    nextAttemptAt: new Date(now).toISOString(),
  });
  await kv.set(["uos_checkout", "v1", "payments", "outbox", now, id], id);
}

async function withApp(
  run: (
    value: { request: RequestFn; handler: (request: Request) => Promise<Response> },
  ) => Promise<void>,
): Promise<void> {
  const path = await Deno.makeTempFile({ prefix: "checkout-http-", suffix: ".sqlite" });
  const kv = await Deno.openKv(path);
  const handler = createHandler(createCheckoutServices(kv, {
    rpc: new StaticRpc(),
    resolveDns: () => Promise.resolve(["93.184.216.34"]),
  }));
  try {
    await run({
      handler,
      request: async (pathname, init = {}) => {
        const headers = new Headers(init.headers);
        if (init.body !== undefined) headers.set("content-type", "application/json");
        if (init.adminMutation) headers.set("x-uos-requested-with", "checkout-admin");
        const request = new Request(`http://localhost:8000${pathname}`, {
          method: init.method ?? "GET",
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        return await handler(withPeerAddress(request, "127.0.0.1"));
      },
    });
  } finally {
    kv.close();
    await Deno.remove(path).catch(() => {});
  }
}

type RequestFn = (
  path: string,
  init?: {
    method?: string;
    headers?: HeadersInit;
    body?: unknown;
    adminMutation?: boolean;
  },
) => Promise<Response>;

class StaticRpc implements RpcClient {
  batch(_chainId: 1 | 10 | 8453, calls: readonly JsonRpcCall[]): Promise<JsonRpcBatchItem[]> {
    return Promise.resolve(calls.map((call) => ({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        number: "0x64",
        hash: `0x${"ab".repeat(32)}`,
        timestamp: "0x669fb640",
      },
    })));
  }
}

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Expected value to be truthy.");
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}
