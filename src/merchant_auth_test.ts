import { createMerchantAuthService, MerchantAuthError } from "./merchant_auth.ts";
import { LOCAL_PEER_HEADER } from "./admin_auth.ts";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");

Deno.test("merchant key is shown once, scoped, and revocable", async () => {
  await withKv(async (kv) => {
    const service = createMerchantAuthService(kv, {
      now: () => NOW,
      randomUuid: () => "key-1",
      randomBytes: () => new Uint8Array(32).fill(7),
      resolveDns: publicDns,
    });
    await service.upsertMerchant({
      id: "linkedin-scraper-2025",
      name: "LinkedIn Sales Agent",
      settlementWebhookUrl: "https://linkedin.example/api/billing/crypto-settlements",
    });
    const created = await service.createKey({
      merchantId: "linkedin-scraper-2025",
      label: "Production",
      scopes: ["invoice:create", "invoice:read"],
    });
    assert(created.token.startsWith("uos_checkout_"));
    assertEquals("token" in created.key, false);

    const request = new Request("https://checkout.ubq.fi/api/v1/invoices", {
      headers: { authorization: `Bearer ${created.token}` },
    });
    const principal = await service.authenticate(request, ["invoice:create"]);
    assertEquals(principal.merchant.id, "linkedin-scraper-2025");
    await assertRejects(
      () => service.authenticate(request, ["catalog:write"]),
      "insufficient_scope",
    );

    await service.revokeKey(created.key.id);
    await assertRejects(() => service.authenticate(request, ["invoice:create"]), "unauthorized");
  });
});

Deno.test("loopback trust requires the internally supplied peer marker", async () => {
  await withKv(async (kv) => {
    const service = createMerchantAuthService(kv, { now: () => NOW, resolveDns: publicDns });
    await assertRejects(
      () =>
        service.authenticate(new Request("http://localhost:8000/api/v1/invoices"), [
          "invoice:create",
        ]),
      "unauthorized",
    );
    const request = new Request("http://localhost:8000/api/v1/invoices", {
      headers: { [LOCAL_PEER_HEADER]: "127.0.0.1" },
    });
    const principal = await service.authenticate(request, ["invoice:create"]);
    assertEquals(principal.merchant.id, "linkedin-scraper-2025");
    await assertRejects(
      () =>
        service.authenticate(
          new Request("https://checkout.ubq.fi/api/v1/invoices", {
            headers: { [LOCAL_PEER_HEADER]: "127.0.0.1" },
          }),
          ["invoice:create"],
        ),
      "unauthorized",
    );
  });
});

Deno.test("merchant records can be retrieved without exposing key material", async () => {
  await withKv(async (kv) => {
    const service = createMerchantAuthService(kv, { now: () => NOW, resolveDns: publicDns });
    assertEquals(await service.getMerchant("linkedin-scraper-2025"), null);
    const created = await service.upsertMerchant({
      id: "linkedin-scraper-2025",
      name: "LinkedIn Sales Agent",
      settlementWebhookUrl: "https://linkedin.example/api/billing/crypto-settlements",
    });
    const loaded = await service.getMerchant("linkedin-scraper-2025");
    assertEquals(loaded?.id, created.id);
    assertEquals(loaded?.settlementWebhookUrl, created.settlementWebhookUrl);
  });
});

Deno.test("merchant webhooks reject local targets and DNS answers in private ranges", async () => {
  await withKv(async (kv) => {
    const privateDns = createMerchantAuthService(kv, {
      now: () => NOW,
      resolveDns: (_hostname, recordType) =>
        Promise.resolve(recordType === "A" ? ["10.0.0.8"] : []),
    });
    await assertRejects(
      () =>
        privateDns.upsertMerchant({
          id: "private-ip",
          name: "Private",
          settlementWebhookUrl: "https://127.0.0.1/hook",
        }),
      "unsafe_webhook_url",
    );
    await assertRejects(
      () =>
        privateDns.upsertMerchant({
          id: "insecure",
          name: "Insecure",
          settlementWebhookUrl: "http://example.com/hook",
        }),
      "invalid_webhook_url",
    );
    await assertRejects(
      () => privateDns.validateWebhookTarget("https://merchant.example/hook"),
      "unsafe_webhook_url",
    );

    const publicDns = createMerchantAuthService(kv, {
      resolveDns: (_hostname, recordType) =>
        Promise.resolve(recordType === "A" ? ["93.184.216.34"] : []),
    });
    const resolved = await publicDns.resolveWebhookTarget("https://merchant.example/hook");
    assertEquals(resolved.url.toString(), "https://merchant.example/hook");
    assertEquals(resolved.addresses.join(","), "93.184.216.34");
  });
});

async function withKv(run: (kv: Deno.Kv) => Promise<void>): Promise<void> {
  const path = await Deno.makeTempFile({ prefix: "checkout-merchant-auth-", suffix: ".sqlite" });
  const kv = await Deno.openKv(path);
  try {
    await run(kv);
  } finally {
    kv.close();
    await Deno.remove(path).catch(() => undefined);
  }
}

async function assertRejects(run: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MerchantAuthError && error.message === message) return;
    throw error;
  }
  throw new Error(`Expected rejection with ${message}`);
}

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Expected value to be truthy");
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function publicDns(_hostname: string, recordType: "A" | "AAAA"): Promise<string[]> {
  return Promise.resolve(recordType === "A" ? ["93.184.216.34"] : []);
}
