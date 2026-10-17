import { assert, assertEquals } from "@std/assert";
import { createPersistentJwsSigner, verifyCompactJws } from "./jws.ts";
import { JsonKvService } from "./kv_test_fixture.ts";
import { createPaymentService } from "./payment_service.ts";
import type { InvoiceRecord } from "./payment_types.ts";
import { type JsonRpcBatchItem, type JsonRpcCall, type RpcClient, TRANSFER_TOPIC } from "./rpc.ts";
import { UbqKv } from "./ubq_kv.ts";
import { createWorkQueue, workKey, type WorkRecord } from "./work_queue.ts";

Deno.test("KV JSON boundary round-trips bigint, arrays, undefined, and legitimate tag-shaped objects", async () => {
  const store = new JsonKvService();
  const kv = new UbqKv({ url: "https://kv.example", token: "offline", fetchImpl: store.fetch });
  const value = {
    __uos_checkout_kv: 1,
    tree: ["bigint", "123"],
    nested: [1n, -9n, undefined, { __uos_checkout_kv: 1, tree: ["null"] }],
  };
  await kv.set(["values", "set"], value);
  await kv.atomic().set(["values", "atomic"], value).commit();
  assertEquals((await kv.get(["values", "set"])).value, value);
  assertEquals(
    (await kv.getMany([["values", "set"], ["values", "atomic"]])).map((entry) => entry.value),
    [value, value],
  );
  const listed = [];
  for await (const entry of kv.list({ prefix: ["values"] })) listed.push(entry.value);
  assertEquals(listed, [value, value]);
  const exactEnvelope = { __uos_checkout_kv: 1, tree: ["bigint", "123"] };
  await kv.set(["exact-envelope"], exactEnvelope);
  assertEquals((await kv.get(["exact-envelope"])).value, exactEnvelope);
  const legacy = {
    schemaVersion: 1,
    id: "old",
    minimumBlock: "100",
    paidAmountUnits: "999999",
    array: ["bigint", "42"],
  };
  store.seed(["legacy"], legacy);
  assertEquals((await kv.get(["legacy"])).value, legacy);
  const stale = await kv.get(["legacy"]);
  await kv.set(["legacy"], legacy);
  assertEquals(
    (await kv.atomic().check(stale).set(["conflict"], "must not write").commit()).ok,
    false,
  );
  assertEquals((await kv.get(["conflict"])).value, null);
});

Deno.test("actual JSON KV adapter creates/discovers invoices and atomically retains delivery/lifecycle jobs", async () => {
  const store = new JsonKvService();
  const kv = new UbqKv({
    url: "https://kv.example",
    token: "offline",
    fetchImpl: store.fetch,
  }) as unknown as Deno.Kv;
  const rpc = new TransferRpc();
  const clock = { now: () => new Date("2026-10-17T12:00:00Z") };
  const service = createPaymentService({
    kv,
    rpc,
    clock,
    signer: createPersistentJwsSigner(kv, clock),
    discountStart: () => 1n,
  });
  await service.configureChain(8453, { enabled: true, treasuryAddress: `0x${"44".repeat(20)}` });
  await service.publishCatalogVersion({ merchantId: "merchant" }, "prices", {
    currency: "USD",
    products: [{
      productId: "pack",
      label: "Pack",
      kind: "credit_pack",
      priceCents: 100,
      enabled: true,
    }],
  });
  const invoice = await service.createInvoice({
    merchantId: "merchant",
    idempotencyKey: "json-adapter",
  }, {
    customerReference: "customer",
    pricingVersionId: "prices",
    productId: "pack",
    chainId: 8453,
  });
  const record = await service.getInvoiceRecord(invoice.id);
  assertEquals(typeof record.minimumBlock, "bigint");
  assertEquals(record.paidAmountUnits, 999_999n);
  assert((await kv.get(workKey("reconcile_invoice", invoice.id))).value);
  assert((await kv.get(workKey("expire_invoice", invoice.id))).value);
  rpc.invoice = record;
  const paid = await service.discoverPayment(invoice.id);
  assertEquals(paid.invoice.status, "provisionally_paid");
  assertEquals(paid.discovery, { found: true, searchedToBlock: "100" });
  const payload = (await verifyCompactJws(paid.eventJws!, await service.jwks())).payload as Record<
    string,
    unknown
  >;
  assertEquals(payload.invoiceId, invoice.id);
  const [event] = await service.listOutbox();
  assert((await kv.get(workKey("deliver_event", event.id))).value);
  let deliveries = 0;
  const queue = createWorkQueue({
    kv,
    clock,
    handle: async (job) => {
      if (job.type !== "deliver_event") return service.runInvoiceWork(job);
      deliveries++;
      await service.markOutboxDelivered(job.id);
      return undefined;
    },
  });
  await Promise.all([queue.runDue(), queue.runDue()]);
  assertEquals(deliveries, 1);
  assertEquals((await service.listOutbox()).length, 0);
  assertEquals((await kv.get(workKey("deliver_event", event.id))).value, null);
  assert((await kv.get<WorkRecord>(workKey("reconcile_invoice", invoice.id))).value);
});

class TransferRpc implements RpcClient {
  invoice?: InvoiceRecord;
  batch(_chainId: 1 | 10 | 8453, calls: readonly JsonRpcCall[]): Promise<JsonRpcBatchItem[]> {
    const blockHash = `0x${"22".repeat(32)}`;
    const transactionHash = `0x${"11".repeat(32)}`;
    const block = (number: string) => ({
      number,
      hash: blockHash,
      timestamp: `0x${BigInt(Math.floor(Date.parse("2026-10-17T12:00:00Z") / 1000)).toString(16)}`,
    });
    const invoice = this.invoice;
    const log = invoice
      ? {
        address: invoice.tokenAddress,
        transactionHash,
        blockNumber: "0x64",
        blockHash,
        logIndex: "0x0",
        topics: [
          TRANSFER_TOPIC,
          `0x${"0".repeat(24)}${"33".repeat(20)}`,
          `0x${"0".repeat(24)}${invoice.treasuryAddress.slice(2)}`,
        ],
        data: `0x${invoice.paidAmountUnits.toString(16).padStart(64, "0")}`,
      }
      : undefined;
    const result: Record<string, unknown> = {
      latest: block(invoice ? "0x67" : "0x63"),
      safe: invoice ? block("0x64") : null,
      finalized: null,
      transfer_logs: log ? [log] : [],
      receipt: log
        ? { transactionHash, blockNumber: "0x64", blockHash, status: "0x1", logs: [log] }
        : null,
      event_block: block("0x64"),
    };
    return Promise.resolve(
      calls.map((call) => ({ jsonrpc: "2.0", id: call.id, result: result[call.id] })),
    );
  }
}
