import {
  type CheckoutServices,
  createCheckoutServices,
  createHandler,
  deliverOutbox,
  withPeerAddress,
} from "./main.ts";
import { LOCAL_PEER_HEADER } from "./src/admin_auth.ts";
import type { JsonRpcBatchItem, JsonRpcCall, RpcClient } from "./src/rpc.ts";

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
