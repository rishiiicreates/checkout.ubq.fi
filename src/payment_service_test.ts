import { createPersistentJwsSigner, verifyCompactJws } from "./jws.ts";
import {
  createPaymentService,
  type InvoiceCreationContext,
  type PaymentService,
} from "./payment_service.ts";
import { type InvoiceRecord, PaymentDomainError } from "./payment_types.ts";
import { type JsonRpcBatchItem, type JsonRpcCall, type RpcClient, TRANSFER_TOPIC } from "./rpc.ts";
import { createWorkQueue, workKey, type WorkRecord } from "./work_queue.ts";

const MERCHANT = "linkedin-scraper-2025";
const TREASURY = `0x${"44".repeat(20)}`;
const PAYER = `0x${"33".repeat(20)}`;

Deno.test("catalog versions are canonical, merchant-scoped, immutable, and idempotent", async () => {
  await withService(async ({ service }) => {
    const unsorted = catalog([
      product("second", 200),
      product("first", 100),
    ]);
    const first = await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices-1",
      unsorted,
    );
    const reordered = await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices-1",
      catalog([product("first", 100), product("second", 200)]),
    );
    assertEquals(first.digest, reordered.digest);
    assertEquals(first.projection.products.map((entry) => entry.productId), ["first", "second"]);
    assertEquals(first.canonicalJson, JSON.stringify(first.projection));

    await assertDomainError(
      () =>
        service.publishCatalogVersion(
          { merchantId: MERCHANT },
          "prices-1",
          catalog([product("first", 101), product("second", 200)]),
        ),
      "catalog_version_conflict",
    );
    const otherMerchant = await service.publishCatalogVersion(
      { merchantId: "another-merchant" },
      "prices-1",
      catalog([product("first", 500)]),
    );
    assert(otherMerchant.digest !== first.digest);
  });
});

Deno.test("invoice allocation resolves overlapping amount bands and preserves expired slots", async () => {
  const starts = [1n, 10_001n, 1n];
  await withService(async ({ service, clock }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices-100",
      catalog([product("pack-100", 100)]),
    );
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices-101",
      catalog([product("pack-101", 101)]),
    );
    const first = await service.createInvoice(context("first"), {
      customerReference: "customer-a",
      pricingVersionId: "prices-100",
      productId: "pack-100",
      chainId: 8453,
    });
    const overlapping = await service.createInvoice(context("second"), {
      customerReference: "customer-b",
      pricingVersionId: "prices-101",
      productId: "pack-101",
      chainId: 8453,
    });
    assertEquals(first.paidAmountUnits, "999999");
    assertEquals(overlapping.paidAmountUnits, "999998");
    assertEquals(overlapping.discountUnits, "10002");

    clock.advance(61 * 60 * 1000);
    assertEquals((await service.expireInvoice(first.id)).status, "expired");
    const afterExpiry = await service.createInvoice(context("third"), {
      customerReference: "customer-c",
      pricingVersionId: "prices-100",
      productId: "pack-100",
      chainId: 8453,
    });
    assertEquals(afterExpiry.paidAmountUnits, "999997");
    assertEquals(afterExpiry.discountUnits, "3");
  }, { discountStart: () => starts.shift() ?? 1n });
});

Deno.test("finalized amount reservations become reusable only after the quarantine window", async () => {
  await withService(async ({ service, rpc, clock }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const first = await service.createInvoice(context("first-finalized"), {
      customerReference: "first-finalized",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    rpc.addTransfer(await service.getInvoiceRecord(first.id), {
      transactionHash: hash(1),
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    rpc.setHeads(103n, null, null);
    await service.claimPayment(first.id, claim(hash(1), 100n));
    rpc.setHeads(103n, 100n, null);
    await service.refreshInvoice(first.id);
    rpc.setHeads(103n, 100n, 100n);
    assertEquals((await service.refreshInvoice(first.id)).invoice.status, "finalized");

    const quarantined = await service.createInvoice(context("during-quarantine"), {
      customerReference: "during-quarantine",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    assertEquals(quarantined.discountUnits, "2");

    clock.advance(24 * 60 * 60 * 1000 + 1);
    const reused = await service.createInvoice(context("after-quarantine"), {
      customerReference: "after-quarantine",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    assertEquals(reused.discountUnits, "1");
    assertEquals(reused.paidAmountUnits, first.paidAmountUnits);
    assert(BigInt(reused.minimumBlock) > 100n);
    await assertDomainError(
      () => service.claimPayment(reused.id, claim(hash(1), 100n)),
      "payment_locator_already_claimed",
    );
  });
});

Deno.test("concurrent creation is idempotent and enforces one open tuple", async () => {
  await withService(async ({ service }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const creationContext = context("same-key");
    const input = {
      customerReference: "customer-concurrent",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    };
    const invoices = await Promise.all(
      Array.from({ length: 12 }, () => service.createInvoice(creationContext, input)),
    );
    assertEquals(new Set(invoices.map((invoice) => invoice.id)).size, 1);
    assertEquals(new Set(invoices.map((invoice) => invoice.paidAmountUnits)).size, 1);

    const secondKey = await service.createInvoice(context("another-key"), input);
    assertEquals(secondKey.id, invoices[0].id);
    await assertDomainError(
      () => service.createInvoice(creationContext, { ...input, customerReference: "changed" }),
      "idempotency_key_conflict",
    );
  });
});

Deno.test("admin overviews merge disabled chains and never expose invoice binding secrets", async () => {
  await withService(async ({ service }) => {
    const chains = await service.listChainConfigurations();
    assertEquals(chains.map((chain) => [chain.chainId, chain.enabled]), [
      [1, false],
      [10, false],
      [8453, true],
    ]);
    const updated = await service.configureChain(8453, {
      enabled: true,
      treasuryAddress: TREASURY,
    });
    assertEquals(updated.revision, 2);
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    await service.createInvoice(context("overview"), {
      customerReference: "secret-customer-reference",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    const [invoice] = await service.listInvoices();
    assertEquals("customerReference" in invoice, false);
    assertEquals("merchant" in invoice, false);
    assertEquals("idempotencyKey" in invoice, false);
    assertEquals(typeof invoice.paidAmountUnits, "string");
  });
});

Deno.test("late inclusion is quarantined but pre-expiry inclusion can be accepted after expiry", async () => {
  await withService(async ({ service, rpc, clock }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const late = await service.createInvoice(context("late"), {
      customerReference: "late-customer",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    const lateRecord = await service.getInvoiceRecord(late.id);
    rpc.addTransfer(lateRecord, {
      transactionHash: hash(10),
      blockNumber: 100n,
      includedAt: new Date(Date.parse(late.expiresAt) + 1),
    });
    rpc.setHeads(103n, null, null);
    clock.advance(2 * 60 * 60 * 1000);
    assertEquals((await service.expireInvoice(late.id)).status, "expired");
    const lateClaim = await service.claimPayment(late.id, claim(hash(10), 100n));
    assertEquals(lateClaim.invoice.status, "late_payment");
    assertEquals(lateClaim.eventJws, undefined);

    const onTime = await service.createInvoice(context("on-time"), {
      customerReference: "on-time-customer",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    const onTimeRecord = await service.getInvoiceRecord(onTime.id);
    rpc.addTransfer(onTimeRecord, {
      transactionHash: hash(11),
      blockNumber: 104n,
      includedAt: new Date(Date.parse(onTime.expiresAt) - 1),
    });
    rpc.setHeads(107n, null, null);
    clock.advance(2 * 60 * 60 * 1000);
    assertEquals((await service.expireInvoice(onTime.id)).status, "expired");
    const onTimeClaim = await service.claimPayment(onTime.id, claim(hash(11), 104n));
    assertEquals(onTimeClaim.invoice.status, "provisionally_paid");
    assert(onTimeClaim.eventJws);
    const idempotentOpen = await service.createInvoice(context("on-time-retry"), {
      customerReference: "on-time-customer",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    assertEquals(idempotentOpen.id, onTime.id);
  });
});

Deno.test("three sealed blocks accept, safe settles, finalized records, and stale heads do not latch", async () => {
  await withService(async ({ service, rpc, kv }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const invoice = await service.createInvoice(context("lifecycle"), {
      customerReference: "customer-lifecycle",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    const record = await service.getInvoiceRecord(invoice.id);
    rpc.addTransfer(record, {
      transactionHash: hash(20),
      blockNumber: 100n,
      includedAt: new Date("2026-07-21T12:10:00.000Z"),
    });
    rpc.setHeads(102n, null, null);
    const confirming = await service.claimPayment(invoice.id, claim(hash(20), 100n));
    assertEquals(confirming.invoice.status, "confirming");
    assertEquals(confirming.eventJws, undefined);

    rpc.setHeads(103n, null, null);
    const accepted = await service.refreshInvoice(invoice.id);
    assertEquals(accepted.invoice.status, "provisionally_paid");
    assert(accepted.eventJws);
    const acceptedPayload = (await verifyCompactJws(accepted.eventJws!, await service.jwks()))
      .payload as Record<string, unknown>;
    assertEquals(acceptedPayload.type, "payment.accepted.v1");
    assertEquals(acceptedPayload.aud, MERCHANT);
    assertEquals(acceptedPayload.merchantId, MERCHANT);
    assertEquals(acceptedPayload.customerReference, "customer-lifecycle");
    assertEquals(acceptedPayload.logIndex, "0");
    assertEquals(acceptedPayload.blockNumber, "100");
    assertEquals(acceptedPayload.paidAmountUnits, invoice.paidAmountUnits);
    assertEquals("reason" in acceptedPayload, false);
    assertEquals(Object.keys(acceptedPayload).sort(), [
      "aud",
      "blockHash",
      "blockNumber",
      "catalogDigest",
      "chainId",
      "customerReference",
      "discountUnits",
      "exp",
      "iat",
      "includedAt",
      "invoiceId",
      "iss",
      "jti",
      "listAmountUnits",
      "logIndex",
      "merchantId",
      "occurredAt",
      "paidAmountUnits",
      "payer",
      "pricingVersionId",
      "productId",
      "tokenAddress",
      "tokenDecimals",
      "treasuryAddress",
      "txHash",
      "type",
    ]);

    rpc.setHeads(101n, null, null);
    assertEquals((await service.refreshInvoice(invoice.id)).invoice.status, "provisionally_paid");
    const recoveredHeads = (await kv.get<{ latestBlock: bigint }>([
      "uos_checkout",
      "v1",
      "payments",
      "chain_heads",
      8453,
    ])).value;
    assertEquals(recoveredHeads?.latestBlock, 101n);
    rpc.setHeads(101n, 100n, null);
    const settled = await service.refreshInvoice(invoice.id);
    assertEquals(settled.invoice.status, "settled");
    assert(settled.eventJws);
    rpc.setHeads(100n, 100n, 100n);
    assertEquals((await service.refreshInvoice(invoice.id)).invoice.status, "finalized");
    assertEquals((await service.listOutbox()).length, 2);
  });
});

Deno.test("reorg before provisional returns to awaiting; reorg after provisional emits quarantine event", async () => {
  await withService(async ({ service, rpc }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const before = await service.createInvoice(context("before-reorg"), {
      customerReference: "before-reorg",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    rpc.addTransfer(await service.getInvoiceRecord(before.id), {
      transactionHash: hash(30),
      blockNumber: 100n,
      includedAt: new Date("2026-07-21T12:05:00.000Z"),
    });
    rpc.setHeads(102n, null, null);
    assertEquals(
      (await service.claimPayment(before.id, claim(hash(30), 100n))).invoice.status,
      "confirming",
    );
    rpc.reorgTransfer(hash(30));
    assertEquals((await service.refreshInvoice(before.id)).invoice.status, "awaiting_payment");

    const after = await service.createInvoice(context("after-reorg"), {
      customerReference: "after-reorg",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    rpc.addTransfer(await service.getInvoiceRecord(after.id), {
      transactionHash: hash(31),
      blockNumber: 103n,
      includedAt: new Date("2026-07-21T12:06:00.000Z"),
    });
    rpc.setHeads(106n, null, null);
    const accepted = await service.claimPayment(after.id, claim(hash(31), 103n));
    assertEquals(accepted.invoice.status, "provisionally_paid");
    rpc.hideReceipt(hash(31));
    const incomplete = await service.refreshInvoice(after.id);
    assertEquals(incomplete.invoice.status, "provisionally_paid");
    assertEquals(incomplete.eventJws, undefined);
    rpc.reorgTransfer(hash(31));
    const reverted = await service.refreshInvoice(after.id);
    assertEquals(reverted.invoice.status, "reverted");
    assert(reverted.eventJws);
    const payload = (await verifyCompactJws(reverted.eventJws!, await service.jwks()))
      .payload as Record<string, unknown>;
    assertEquals(payload.type, "payment.reverted.v1");
    assertEquals(payload.reason, "non_canonical_block");
  });
});

Deno.test("claim replay and a second exact transfer never emit a second acceptance", async () => {
  await withService(async ({ service, rpc }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const invoice = await service.createInvoice(context("replay"), {
      customerReference: "replay-customer",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    const record = await service.getInvoiceRecord(invoice.id);
    rpc.addTransfer(record, {
      transactionHash: hash(40),
      blockNumber: 100n,
      includedAt: new Date("2026-07-21T12:05:00.000Z"),
    });
    rpc.setHeads(103n, null, null);
    const first = await service.claimPayment(invoice.id, claim(hash(40), 100n));
    assert(first.eventJws);
    const replay = await service.claimPayment(invoice.id, claim(hash(40), 100n));
    assert(replay.eventJws);
    const firstPayload = (await verifyCompactJws(first.eventJws!, await service.jwks()))
      .payload as Record<string, unknown>;
    const replayPayload = (await verifyCompactJws(replay.eventJws!, await service.jwks()))
      .payload as Record<string, unknown>;
    assertEquals(replayPayload.jti, firstPayload.jti);

    rpc.addTransfer(record, {
      transactionHash: hash(41),
      blockNumber: 101n,
      includedAt: new Date("2026-07-21T12:06:00.000Z"),
    });
    const duplicate = await service.claimPayment(invoice.id, claim(hash(41), 101n));
    assertEquals(duplicate.invoice.status, "provisionally_paid");
    assertEquals(duplicate.invoice.requiresManualReview, true);
    assertEquals((await service.listOutbox()).length, 1);
    rpc.setHeads(104n, 101n, 100n);
    assertEquals((await service.refreshInvoice(invoice.id)).invoice.status, "settled");
  });
});

Deno.test("a reverted locator can reappear canonically and emit a new acceptance lifecycle", async () => {
  await withService(async ({ service, rpc }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const invoice = await service.createInvoice(context("canonical-reappearance"), {
      customerReference: "canonical-reappearance",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    const transactionHash = hash(42);
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash,
      blockNumber: 100n,
      includedAt: new Date("2026-07-21T12:05:00.000Z"),
    });
    rpc.setHeads(103n, null, null);
    const first = await service.claimPayment(invoice.id, claim(transactionHash, 100n));
    const firstClaims = (await verifyCompactJws(first.eventJws!, await service.jwks()))
      .payload as Record<string, unknown>;

    rpc.reorgTransfer(transactionHash);
    const reverted = await service.refreshInvoice(invoice.id);
    assertEquals(reverted.invoice.status, "reverted");

    rpc.reincludeTransfer(transactionHash, 101n);
    rpc.setHeads(104n, null, null);
    const watch = await service.reconcileHourly(8453, 104n);
    assertEquals(watch.invoices.map((candidate) => candidate.id), [invoice.id]);
    assertEquals((await service.getInvoice(invoice.id)).status, "provisionally_paid");
    const reaccepted = await service.claimPayment(invoice.id, claim(transactionHash, 101n));
    const reacceptedClaims = (await verifyCompactJws(reaccepted.eventJws!, await service.jwks()))
      .payload as Record<string, unknown>;
    assert(reacceptedClaims.jti !== firstClaims.jti);
    assertEquals(reacceptedClaims.invoiceId, firstClaims.invoiceId);
    assertEquals(reacceptedClaims.txHash, firstClaims.txHash);
    assertEquals(reacceptedClaims.logIndex, firstClaims.logIndex);
    assertEquals(reacceptedClaims.blockNumber, "101");

    rpc.setHeads(104n, 101n, 100n);
    assertEquals((await service.refreshInvoice(invoice.id)).invoice.status, "settled");
  });
});

Deno.test("reconciliation cursor advances only after a complete worker range", async () => {
  await withService(async ({ service }) => {
    let attempts = 0;
    await assertRejects(
      () =>
        service.reconcileChainRange(8453, 200n, () => {
          attempts++;
          return Promise.reject(new Error("upstream unavailable"));
        }),
    );
    const watch = await service.reconcileChainRange(8453, 200n, () => {
      attempts++;
      return Promise.resolve();
    });
    assertEquals(watch.toBlock, 200n);
    const next = await service.reconcileChainRange(8453, 205n, (range) => {
      assertEquals(range.fromBlock, 205n);
      return Promise.resolve();
    });
    assertEquals(next.fromBlock, 205n);
    assertEquals(attempts, 2);
  });
});

Deno.test("discovery claims one invoice, keeps the cursor, and is idempotent after payment", async () => {
  await withService(async ({ service, rpc, kv, clock }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const invoice = await service.createInvoice(context("discovery"), {
      customerReference: "discovery",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    const cursorKey = ["uos_checkout", "v1", "payments", "reconciliation_cursors", 8453];
    const cursor = { chainId: 8453, blockNumber: 5n, updatedAt: clock.now().toISOString() };
    await kv.set(cursorKey, cursor);
    rpc.setHeads(103n, null, null);
    const empty = await service.discoverPayment(invoice.id);
    assertEquals(empty.invoice, invoice);
    assertEquals(empty.discovery, { found: false, searchedToBlock: "103" });
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(70),
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    const paid = await service.discoverPayment(invoice.id);
    assertEquals(paid.invoice.status, "provisionally_paid");
    assertEquals(paid.discovery, { found: true, searchedToBlock: "103" });
    assert(paid.eventJws);
    const again = await service.discoverPayment(invoice.id);
    assertEquals(again.invoice, paid.invoice);
    assertEquals(again.discovery, { found: true });
    assertEquals((await service.listOutbox()).length, 1);
    assertEquals((await kv.get<typeof cursor>(cursorKey)).value?.blockNumber, 5n);
  });
});

Deno.test("discovery rejects nonmatching transfers and uses the coherent safe/latest head", async () => {
  await withService(async ({ service, rpc, clock }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const invoice = await service.createInvoice(context("discovery-wrong"), {
      customerReference: "discovery-wrong",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    const record = await service.getInvoiceRecord(invoice.id);
    for (
      const [index, changed] of [
        { ...record, paidAmountUnits: record.paidAmountUnits + 1n },
        { ...record, tokenAddress: `0x${"77".repeat(20)}` },
        { ...record, treasuryAddress: `0x${"77".repeat(20)}` },
        record,
      ].entries()
    ) {
      rpc.addTransfer(changed, {
        transactionHash: hash(71 + index),
        blockNumber: index === 3 ? 99n : 100n,
        includedAt: clock.now(),
      });
    }
    rpc.setHeads(200n, 190n, 180n);
    assertEquals((await service.discoverPayment(invoice.id)).discovery, {
      found: false,
      searchedToBlock: "190",
    });
    rpc.setHeads(99n, null, null);
    assertEquals((await service.discoverPayment(invoice.id)).discovery, {
      found: false,
      searchedToBlock: "99",
    });
    assertEquals(await service.getInvoice(invoice.id), invoice);
    assertEquals((await service.listOutbox()).length, 0);
  });
});

Deno.test("discovery bounds old invoices and resumes persisted full-history coverage", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "bounded-discovery");
    const cursorKey = ["uos_checkout", "v1", "payments", "reconciliation_cursors", 8453];
    await kv.set(cursorKey, { blockNumber: 42n });
    clock.advance(60 * 60_000);
    await service.expireInvoice(invoice.id);
    clock.advance(30 * 24 * 60 * 60_000);
    const head = 99n + 30n * 43_200n;
    rpc.setHeads(head, null, null);
    const first = await service.discoverPayment(invoice.id);
    const firstLogs = rpc.logRanges.length;
    assertEquals(firstLogs, 50);
    assertEquals(first.discovery, { found: false, searchedToBlock: "50099" });
    const restarted = createPaymentService({
      kv,
      rpc,
      clock,
      signer: createPersistentJwsSigner(kv, clock),
    });
    let through = BigInt(first.discovery!.searchedToBlock!);
    let requests = 1;
    let secondLogs = 0;
    while (through < head) {
      const callsBefore = rpc.logRanges.length;
      const result = await restarted.discoverPayment(invoice.id);
      const next = BigInt(result.discovery!.searchedToBlock!);
      assert(next > through);
      if (requests === 1) secondLogs = rpc.logRanges.length - callsBefore;
      assert(rpc.logRanges.length - callsBefore <= 50);
      assertEquals(rpc.logRanges[callsBefore][0], through + 1n - 128n);
      through = next;
      assert(++requests <= 27);
    }
    assertEquals(requests, 26);
    const caughtUpCalls = rpc.logRanges.length;
    assertEquals(
      (await service.discoverPayment(invoice.id)).discovery?.searchedToBlock,
      head.toString(),
    );
    const caughtUpLogs = rpc.logRanges.length - caughtUpCalls;
    assert(caughtUpLogs <= 2);
    console.log("discovery_scan_counts", { requests, firstLogs, secondLogs, caughtUpLogs });
    assertEquals((await kv.get<{ blockNumber: bigint }>(cursorKey)).value?.blockNumber, 42n);
    assertEquals(
      (await kv.get<{ searchedThrough: bigint }>(discoveryStateKey(invoice.id))).value
        ?.searchedThrough,
      head,
    );
  });
});

Deno.test("discovery busy calls return only committed progress without RPC", async () => {
  await withService(async ({ service, rpc }) => {
    const invoice = await createTestInvoice(service, "busy-discovery");
    rpc.setHeads(200n, null, null);
    for (const committed of [undefined, "200"]) {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let blocked = false;
      rpc.beforeLogs = () => {
        if (blocked) return Promise.resolve();
        blocked = true;
        entered.resolve();
        return release.promise;
      };
      const owner = service.discoverPayment(invoice.id);
      await entered.promise;
      const callsBefore = rpc.requests;
      try {
        const busy = await Promise.all(
          Array.from({ length: 5 }, () => service.discoverPayment(invoice.id)),
        );
        assertEquals(rpc.requests, callsBefore);
        for (const result of busy) {
          assertEquals(result.discovery?.found, false);
          assertEquals(result.discovery?.searchedToBlock, committed);
        }
      } finally {
        release.resolve();
        await owner;
      }
      rpc.setHeads(100_100n, null, null);
    }
  });
});

Deno.test("discovery retries matching logs with delayed canonical receipts before advancing", async () => {
  for (const failure of ["missing", "noncanonical"]) {
    await withService(async ({ service, rpc, clock, kv }) => {
      const invoice = await createTestInvoice(service, `delayed-discovery-${failure}`);
      const transactionHash = hash(98);
      rpc.setHeads(100_100n, null, null);
      await service.discoverPayment(invoice.id);
      rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
        transactionHash,
        blockNumber: 50_050n,
        includedAt: clock.now(),
      });
      if (failure === "missing") rpc.hideReceipt(transactionHash);
      else rpc.reorgTransfer(transactionHash);
      const missing = await service.discoverPayment(invoice.id);
      assertEquals(missing.discovery, { found: false, searchedToBlock: "50099" });
      const state = (await kv.get<{ searchedThrough: bigint }>(discoveryStateKey(invoice.id)))
        .value!;
      assertEquals(state.searchedThrough, 50_099n);
      rpc.reincludeTransfer(transactionHash, 50_050n);
      assertEquals(
        (await service.discoverPayment(invoice.id)).invoice.status,
        "provisionally_paid",
      );
      assertEquals((await kv.get(discoveryStateKey(invoice.id))).value, null);
    });
  }
});

Deno.test("a claim fences an in-flight discovery from restoring cleared progress", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "claim-fences-discovery");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    rpc.setHeads(1_000n, null, null);
    rpc.beforeLogs = () => {
      entered.resolve();
      return release.promise;
    };
    const pending = service.discoverPayment(invoice.id);
    await entered.promise;
    try {
      assert((await kv.get<{ leaseId: string }>(discoveryStateKey(invoice.id))).value?.leaseId);
      rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
        transactionHash: hash(99),
        blockNumber: 105n,
        includedAt: clock.now(),
      });
      await service.claimPayment(invoice.id, claim(hash(99), 105n));
      assertEquals((await kv.get(discoveryStateKey(invoice.id))).value, null);
    } finally {
      release.resolve();
      await pending;
    }
    assertEquals((await kv.get(discoveryStateKey(invoice.id))).value, null);
  });
});

Deno.test("discovery expired leases fence stale completion and release from the successor", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "expired-discovery-owner");
    await kv.set(discoveryStateKey(invoice.id), { searchedThrough: 500n });
    rpc.setHeads(100_100n, null, null);
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let started = 0;
    rpc.beforeLogs = () => {
      const index = started++;
      if (index > 1) return Promise.resolve();
      entered[index].resolve();
      return release[index].promise;
    };
    const stale = service.discoverPayment(invoice.id);
    await entered[0].promise;
    clock.advance(61_000);
    const successor = service.discoverPayment(invoice.id);
    await entered[1].promise;
    try {
      const owned = (await kv.get<{ leaseId: string }>(discoveryStateKey(invoice.id))).value!;
      release[0].resolve();
      await stale;
      const afterStale =
        (await kv.get<{ leaseId: string; searchedThrough: bigint }>(discoveryStateKey(invoice.id)))
          .value!;
      assertEquals(afterStale.leaseId, owned.leaseId);
      assertEquals(afterStale.searchedThrough, 500n);
    } finally {
      release[0].resolve();
      release[1].resolve();
      await Promise.all([stale, successor]);
    }
    const after =
      (await kv.get<{ leaseId?: string; searchedThrough: bigint }>(discoveryStateKey(invoice.id)))
        .value!;
    assertEquals(after.leaseId, undefined);
    assertEquals(after.searchedThrough, 50_372n);
  });
});

Deno.test("payment reorg and re-inclusion transitions clear discovery state", async () => {
  for (const accepted of [false, true]) {
    await withService(async ({ service, rpc, clock, kv }) => {
      const invoice = await createTestInvoice(service, `clear-reorg-discovery-${accepted}`);
      const transactionHash = hash(101);
      rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
        transactionHash,
        blockNumber: 100n,
        includedAt: clock.now(),
      });
      rpc.setHeads(accepted ? 103n : 100n, null, null);
      await kv.set(discoveryStateKey(invoice.id), { searchedThrough: 900n });
      await service.claimPayment(invoice.id, claim(transactionHash, 100n));
      assert((await kv.get(discoveryStateKey(invoice.id))).value === null);
      await kv.set(discoveryStateKey(invoice.id), { searchedThrough: 900n });
      rpc.reorgTransfer(transactionHash);
      await service.refreshInvoice(invoice.id);
      assert((await kv.get(discoveryStateKey(invoice.id))).value === null);
      if (accepted) {
        await kv.set(discoveryStateKey(invoice.id), { searchedThrough: 900n });
        rpc.reincludeTransfer(transactionHash, 104n, 5);
        rpc.setHeads(110n, null, null);
        await service.claimPayment(invoice.id, { ...claim(transactionHash, 104n), logIndex: "5" });
        assert((await kv.get(discoveryStateKey(invoice.id))).value === null);
      }
    });
  }
});

Deno.test("discovery continues past an unrelated duplicate to the original re-inclusion", async () => {
  await withService(async ({ service, rpc, clock }) => {
    const invoice = await createTestInvoice(service, "duplicate-before-reinclude");
    const record = await service.getInvoiceRecord(invoice.id);
    rpc.addTransfer(record, {
      transactionHash: hash(103),
      blockNumber: 101n,
      includedAt: clock.now(),
    });
    rpc.addTransfer(record, {
      transactionHash: hash(102),
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    rpc.setHeads(103n, null, null);
    await service.claimPayment(invoice.id, claim(hash(102), 100n));
    rpc.reorgTransfer(hash(102));
    await service.refreshInvoice(invoice.id);
    rpc.reincludeTransfer(hash(102), 104n, 5);
    rpc.setHeads(110n, null, null);
    const result = await service.discoverPayment(invoice.id);
    assertEquals(result.invoice.status, "provisionally_paid");
    assertEquals(result.discovery?.found, true);
  });
});

Deno.test("hourly reconciliation discovers matching treasury transfers and claims them", async () => {
  await withService(async ({ service, rpc }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const invoice = await service.createInvoice(context("hourly"), {
      customerReference: "hourly-customer",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(50),
      blockNumber: 100n,
      includedAt: new Date("2026-07-21T12:10:00.000Z"),
    });
    rpc.setHeads(103n, null, null);
    const range = await service.reconcileHourly(8453, 103n);
    assertEquals(range.fromBlock, 100n);
    assertEquals((await service.getInvoice(invoice.id)).status, "provisionally_paid");
    assertEquals((await service.listOutbox()).length, 1);
  });
});

Deno.test("hourly reconciliation scans only through the coherent safe head", async () => {
  await withService(async ({ service, rpc }) => {
    rpc.setHeads(200n, 190n, 180n);
    const watch = await service.reconcileHourly(8453);
    assertEquals(watch.fromBlock, 190n);
    assertEquals(watch.toBlock, 190n);
  });
});

Deno.test("outbox retries after JWS expiry keep stable event identity and isolate poison entries", async () => {
  await withService(async ({ service, rpc, clock }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    for (const [index, transactionHash] of [hash(60), hash(61)].entries()) {
      const invoice = await service.createInvoice(context(`outbox-${index}`), {
        customerReference: `outbox-${index}`,
        pricingVersionId: "prices",
        productId: "pack",
        chainId: 8453,
      });
      const blockNumber = index === 0 ? 100n : 104n;
      rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
        transactionHash,
        blockNumber,
        includedAt: clock.now(),
      });
      rpc.setHeads(blockNumber + 3n, null, null);
      await service.claimPayment(invoice.id, claim(transactionHash, blockNumber));
    }

    const initial = await service.listOutbox();
    assertEquals(initial.length, 2);
    const originalClaims = (await verifyCompactJws(initial[0].compactJws, await service.jwks()))
      .payload as Record<string, unknown>;
    await service.markOutboxFailed(initial[0].id, "merchant outage");
    assertEquals((await service.listOutbox()).map((event) => event.id), [initial[1].id]);

    clock.advance(25 * 60 * 60 * 1000);
    const retried = (await service.listOutbox()).find((event) => event.id === initial[0].id);
    assert(retried);
    const retryClaims = (await verifyCompactJws(retried.compactJws, await service.jwks()))
      .payload as Record<string, unknown>;
    assertEquals(retryClaims.jti, originalClaims.jti);
    assert(Number(retryClaims.iat) > Number(originalClaims.iat));
    assert(Number(retryClaims.exp) > Number(originalClaims.exp));
    assertEquals(retried.deliveryAttempts, 1);
  });
});

Deno.test("reconciliation overlaps the cursor and finds a transfer introduced behind it", async () => {
  await withService(async ({ service, rpc }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const invoice = await service.createInvoice(context("overlap"), {
      customerReference: "overlap",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    await service.reconcileHourly(8453, 103n);
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(62),
      blockNumber: 102n,
      includedAt: new Date("2026-07-21T12:10:00.000Z"),
    });
    rpc.setHeads(105n, 104n, 103n);
    const watch = await service.reconcileHourly(8453, 105n);
    assertEquals(watch.fromBlock, 100n);
    assertEquals((await service.getInvoice(invoice.id)).status, "settled");
  });
});

Deno.test("disabled chains drain outstanding invoices and terminal invoices leave the active index", async () => {
  await withService(async ({ service, rpc, kv }) => {
    await service.publishCatalogVersion(
      { merchantId: MERCHANT },
      "prices",
      catalog([product("pack", 100)]),
    );
    const invoice = await service.createInvoice(context("disabled-drain"), {
      customerReference: "disabled-drain",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    await service.configureChain(8453, { enabled: false, treasuryAddress: TREASURY });
    await assertDomainError(
      () =>
        service.createInvoice(context("disabled-new"), {
          customerReference: "disabled-new",
          pricingVersionId: "prices",
          productId: "pack",
          chainId: 8453,
        }),
      "chain_disabled",
    );
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(63),
      blockNumber: 100n,
      includedAt: new Date("2026-07-21T12:10:00.000Z"),
    });
    rpc.setHeads(103n, 100n, 100n);
    await service.reconcileHourly(8453, 103n);
    await service.refreshInvoice(invoice.id);
    await service.refreshInvoice(invoice.id);
    assertEquals((await service.getInvoice(invoice.id)).status, "finalized");
    const active = [];
    for await (
      const entry of kv.list({
        prefix: ["uos_checkout", "v1", "payments", "invoices_by_chain", 8453],
      })
    ) active.push(entry);
    assertEquals(active.length, 0);
  });
});

Deno.test("treasury rejects zero and token addresses and events target the invoice merchant", async () => {
  await withService(async ({ service, rpc }) => {
    await assertDomainError(
      () =>
        service.configureChain(8453, {
          enabled: true,
          treasuryAddress: "0x0000000000000000000000000000000000000000",
        }),
      "invalid_treasury_address",
    );
    await assertDomainError(
      () =>
        service.configureChain(8453, {
          enabled: true,
          treasuryAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        }),
      "invalid_treasury_address",
    );
    const merchant = "another-merchant";
    await service.publishCatalogVersion(
      { merchantId: merchant },
      "prices",
      catalog([product("pack", 100)]),
    );
    const invoice = await service.createInvoice({ merchantId: merchant, idempotencyKey: "aud" }, {
      customerReference: "audience",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(64),
      blockNumber: 100n,
      includedAt: new Date("2026-07-21T12:10:00.000Z"),
    });
    rpc.setHeads(103n, null, null);
    const accepted = await service.claimPayment(invoice.id, claim(hash(64), 100n));
    const payload = (await verifyCompactJws(accepted.eventJws!, await service.jwks()))
      .payload as Record<string, unknown>;
    assertEquals(payload.aud, merchant);
    assertEquals(payload.merchantId, merchant);
  });
});

Deno.test("invoice jobs preserve pending/safe/finalized lifecycle past expiry and disabled configuration", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "job-lifecycle");
    const queue = invoiceQueue(service, kv, clock);
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(80),
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    rpc.setHeads(100n, null, null);
    await service.configureChain(8453, { enabled: false, treasuryAddress: `0x${"88".repeat(20)}` });
    clock.advance(60_000);
    await Promise.all([queue.runDue(), queue.runDue()]);
    assertEquals((await service.getInvoice(invoice.id)).status, "confirming");
    assertEquals((await kv.get(workKey("expire_invoice", invoice.id))).value, null);
    clock.advance(61 * 60_000);
    rpc.setHeads(103n, 100n, 100n);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "provisionally_paid");
    clock.advance(60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "settled");
    clock.advance(60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "finalized");
    assertEquals((await kv.get(workKey("reconcile_invoice", invoice.id))).value, null);
    const events = [];
    for await (const entry of kv.list({ prefix: ["uos_checkout", "v1", "payments", "events"] })) {
      events.push(entry);
    }
    assertEquals(events.length, 2);
    assertEquals((await service.listReconciliationInvoices(8453)).length, 0);
  });
});

Deno.test("invoice jobs back off through the expired watch window and then stop", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "job-expiry");
    const queue = invoiceQueue(service, kv, clock);
    rpc.setHeads(103n, null, null);
    clock.advance(60_000);
    await queue.runDue();
    const retry = (await kv.get<WorkRecord>(workKey("reconcile_invoice", invoice.id))).value!;
    assertEquals(retry.attempts, 1);
    assertEquals(retry.dueAt, clock.now().getTime() + 2 * 60_000);
    clock.advance(59 * 60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "expired");
    const followup = (await kv.get<WorkRecord>(workKey("reconcile_invoice", invoice.id))).value!;
    assertEquals(followup.dueAt, clock.now().getTime() + 15 * 60_000);
    clock.advance(15 * 60_000);
    await queue.runDue();
    const coarseRetry = (await kv.get<WorkRecord>(workKey("reconcile_invoice", invoice.id))).value!;
    assertEquals(coarseRetry.dueAt, clock.now().getTime() + 60 * 60_000);
    clock.advance(60 * 60_000);
    await queue.runDue();
    const laterRetry = (await kv.get<WorkRecord>(workKey("reconcile_invoice", invoice.id))).value!;
    assertEquals(laterRetry.dueAt, clock.now().getTime() + 4 * 60 * 60_000);
    const windowEnd = Date.parse(invoice.expiresAt) + 24 * 60 * 60_000;
    let scheduled = laterRetry;
    while (scheduled.dueAt < windowEnd) {
      clock.advance(scheduled.dueAt - clock.now().getTime());
      await queue.runDue();
      scheduled = (await kv.get<WorkRecord>(workKey("reconcile_invoice", invoice.id))).value!;
    }
    assertEquals(scheduled.dueAt, windowEnd);
    const callsAtExpiry = rpc.requests;
    clock.advance(windowEnd - clock.now().getTime());
    await queue.runDue();
    assertEquals(rpc.requests, callsAtExpiry);
    assertEquals((await kv.get(workKey("expire_invoice", invoice.id))).value, null);
    assertEquals((await kv.get(workKey("reconcile_invoice", invoice.id))).value, null);
    assertEquals(
      (await kv.get(["uos_checkout", "v1", "payments", "invoices_by_chain", 8453, invoice.id]))
        .value,
      null,
    );
    await service.recoverWork();
    assertEquals((await kv.get(workKey("reconcile_invoice", invoice.id))).value, null);
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(81),
      blockNumber: 100n,
      includedAt: new Date("2026-07-21T12:30:00Z"),
    });
    const recovered = await service.discoverPayment(invoice.id);
    assertEquals(recovered.discovery?.found, true);
    assertEquals(recovered.invoice.status, "provisionally_paid");
    assert((await kv.get(workKey("reconcile_invoice", invoice.id))).value);
  });
});

Deno.test("expiry discovery RPC failure expires the invoice and a follow-up still recovers payment", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const paid = await createTestInvoice(service, "expiry-final-discovery");
    const unpaid = await createTestInvoice(service, "expiry-rpc-failure");
    const queue = invoiceQueue(service, kv, clock);
    rpc.addTransfer(await service.getInvoiceRecord(paid.id), {
      transactionHash: hash(82),
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    rpc.setHeads(103n, null, null);
    clock.advance(60 * 60_000);
    await service.runInvoiceWork({
      type: "expire_invoice",
      id: paid.id,
      dueAt: clock.now().getTime(),
      attempts: 0,
    });
    assertEquals((await service.getInvoice(paid.id)).status, "provisionally_paid");
    rpc.failures = 1;
    await service.runInvoiceWork({
      type: "expire_invoice",
      id: unpaid.id,
      dueAt: clock.now().getTime(),
      attempts: 0,
    });
    assertEquals((await service.getInvoice(unpaid.id)).status, "expired");
    assertEquals((await kv.get(workKey("expire_invoice", unpaid.id))).value, null);
    const followup = (await kv.get<WorkRecord>(workKey("reconcile_invoice", unpaid.id))).value!;
    assertEquals(followup.dueAt, clock.now().getTime() + 15 * 60_000);
    rpc.addTransfer(await service.getInvoiceRecord(unpaid.id), {
      transactionHash: hash(85),
      blockNumber: 100n,
      includedAt: new Date(Date.parse(unpaid.expiresAt) - 60_000),
    });
    clock.advance(15 * 60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(unpaid.id)).status, "provisionally_paid");
  });
});

Deno.test("invoice jobs handle reorgs and bound reverted watches from the revert time", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "job-reorg");
    const queue = invoiceQueue(service, kv, clock);
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(83),
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    rpc.setHeads(100n, null, null);
    await service.claimPayment(invoice.id, claim(hash(83), 100n));
    rpc.hideReceipt(hash(83));
    clock.advance(60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "confirming");
    rpc.reincludeTransfer(hash(83), 100n);
    rpc.reorgTransfer(hash(83));
    clock.advance(60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "awaiting_payment");
    rpc.reincludeTransfer(hash(83), 101n);
    rpc.setHeads(104n, null, null);
    clock.advance(60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "provisionally_paid");
    rpc.reorgTransfer(hash(83));
    clock.advance(60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "reverted");
    rpc.reincludeTransfer(hash(83), 102n);
    rpc.setHeads(105n, null, null);
    clock.advance(30 * 60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "provisionally_paid");
    rpc.reorgTransfer(hash(83));
    clock.advance(60_000);
    await queue.runDue();
    clock.advance(60 * 60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "reverted");
    assert((await kv.get(workKey("reconcile_invoice", invoice.id))).value);
    assertEquals((await kv.get(workKey("expire_invoice", invoice.id))).value, null);
    const revertedAt = (await service.getInvoiceRecord(invoice.id)).revertedAt!;
    clock.advance(Date.parse(revertedAt) + 24 * 60 * 60_000 - clock.now().getTime());
    await queue.runDue();
    assertEquals((await kv.get(workKey("reconcile_invoice", invoice.id))).value, null);
    assertEquals((await kv.get(workKey("expire_invoice", invoice.id))).value, null);
    assertEquals(
      (await kv.get(["uos_checkout", "v1", "payments", "invoices_by_chain", 8453, invoice.id]))
        .value,
      null,
    );
  });
});

Deno.test("expired watch recovers an on-time payment once the safe head catches up", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "safe-head-expiry");
    const queue = invoiceQueue(service, kv, clock);
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(91),
      blockNumber: 105n,
      includedAt: new Date(Date.parse(invoice.expiresAt) - 60_000),
    });
    rpc.setHeads(110n, 99n, null);
    clock.advance(60 * 60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "expired");
    assert((await kv.get(workKey("reconcile_invoice", invoice.id))).value);
    await kv.delete(workKey("reconcile_invoice", invoice.id));
    await service.recoverWork();
    const followup = (await kv.get<WorkRecord>(workKey("reconcile_invoice", invoice.id))).value!;
    assertEquals(followup.dueAt, clock.now().getTime() + 15 * 60_000);
    rpc.setHeads(115n, 110n, null);
    clock.advance(followup.dueAt - clock.now().getTime());
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "provisionally_paid");
    assertEquals((await service.listOutbox()).map((event) => event.type), ["payment.accepted.v1"]);
  });
});

Deno.test("expired watch flags a late payment without accepting it", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "late-expired-watch");
    const queue = invoiceQueue(service, kv, clock);
    clock.advance(60 * 60_000);
    await queue.runDue();
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(92),
      blockNumber: 105n,
      includedAt: new Date(Date.parse(invoice.expiresAt) + 60_000),
    });
    rpc.setHeads(115n, 110n, null);
    clock.advance(15 * 60_000);
    await queue.runDue();
    assertEquals((await service.getInvoice(invoice.id)).status, "late_payment");
    assertEquals((await service.listOutbox()).length, 0);
    assertEquals((await kv.get(workKey("reconcile_invoice", invoice.id))).value, null);
    assertEquals(
      (await kv.get(["uos_checkout", "v1", "payments", "invoices_by_chain", 8453, invoice.id]))
        .value,
      null,
    );
  });
});

Deno.test("replacement invoice creation retains the unpaid expired invoice watch", async () => {
  await withService(async ({ service, clock, kv }) => {
    const invoice = await createTestInvoice(service, "replacement-watch");
    clock.advance(60 * 60_000);
    await service.createInvoice(context("replacement-watch-next"), {
      customerReference: "replacement-watch",
      pricingVersionId: "prices",
      productId: "pack",
      chainId: 8453,
    });
    assertEquals((await service.getInvoice(invoice.id)).status, "expired");
    const followup = (await kv.get<WorkRecord>(workKey("reconcile_invoice", invoice.id))).value!;
    assertEquals(followup.dueAt, clock.now().getTime() + 15 * 60_000);
  });
});

Deno.test("discovery moves a reverted payment locator when its logIndex changes", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "changed-index-reinclude");
    const transactionHash = hash(93);
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash,
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    rpc.setHeads(103n, null, null);
    await service.claimPayment(invoice.id, claim(transactionHash, 100n));
    const paymentId = (await service.getInvoiceRecord(invoice.id)).paymentId;
    rpc.reorgTransfer(transactionHash);
    await service.refreshInvoice(invoice.id);
    rpc.reincludeTransfer(transactionHash, 104n, 5);
    rpc.setHeads(110n, 110n, null);
    const recovered = await service.discoverPayment(invoice.id);
    assertEquals(recovered.invoice.status, "provisionally_paid");
    assertEquals(recovered.discovery?.found, true);
    assert(recovered.eventJws);
    assertEquals((await service.getInvoiceRecord(invoice.id)).paymentId, paymentId);
    const locatorPrefix = [
      "uos_checkout",
      "v1",
      "payments",
      "payment_locators",
      8453,
      transactionHash,
    ];
    assertEquals((await kv.get([...locatorPrefix, 0])).value, null);
    assertEquals((await kv.get([...locatorPrefix, 5])).value, {
      invoiceId: invoice.id,
      paymentId,
      duplicate: false,
    });
    const replay = await service.claimPayment(invoice.id, {
      ...claim(transactionHash, 104n),
      logIndex: "5",
    });
    assert(replay.eventJws);
    assertEquals((await service.discoverPayment(invoice.id)).discovery?.found, true);
    assertEquals((await service.listOutbox()).map((event) => event.type), [
      "payment.accepted.v1",
      "payment.reverted.v1",
      "payment.accepted.v1",
      "payment.settled.v1",
    ]);
  });
});

Deno.test("discovery of a different transaction does not report a reverted invoice recovered", async () => {
  await withService(async ({ service, rpc, clock }) => {
    const invoice = await createTestInvoice(service, "unrelated-reverted-transfer");
    const record = await service.getInvoiceRecord(invoice.id);
    rpc.addTransfer(record, {
      transactionHash: hash(94),
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    rpc.setHeads(103n, null, null);
    await service.claimPayment(invoice.id, claim(hash(94), 100n));
    rpc.reorgTransfer(hash(94));
    await service.refreshInvoice(invoice.id);
    rpc.addTransfer(record, {
      transactionHash: hash(95),
      blockNumber: 104n,
      includedAt: clock.now(),
    });
    rpc.setHeads(110n, 110n, null);
    const result = await service.discoverPayment(invoice.id);
    assertEquals(result.invoice.status, "reverted");
    assertEquals(result.discovery?.found, false);
    assertEquals((await service.discoverPayment(invoice.id)).discovery?.found, false);
  });
});

Deno.test("re-inclusion refuses an occupied new locator and preserves the original locator", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "occupied-reinclude-locator");
    const transactionHash = hash(97);
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash,
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    rpc.setHeads(103n, null, null);
    await service.claimPayment(invoice.id, claim(transactionHash, 100n));
    const paymentId = (await service.getInvoiceRecord(invoice.id)).paymentId;
    rpc.reorgTransfer(transactionHash);
    await service.refreshInvoice(invoice.id);
    rpc.reincludeTransfer(transactionHash, 104n, 5);
    const locatorPrefix = [
      "uos_checkout",
      "v1",
      "payments",
      "payment_locators",
      8453,
      transactionHash,
    ];
    const occupied = { invoiceId: invoice.id, paymentId: "occupied", duplicate: true };
    await kv.set([...locatorPrefix, 5], occupied);
    await assertDomainError(
      () => service.claimPayment(invoice.id, { ...claim(transactionHash, 104n), logIndex: "5" }),
      "payment_locator_already_claimed",
    );
    assertEquals((await kv.get([...locatorPrefix, 0])).value, {
      invoiceId: invoice.id,
      paymentId,
      duplicate: false,
    });
    assertEquals((await kv.get([...locatorPrefix, 5])).value, occupied);
    assertEquals((await service.getInvoice(invoice.id)).status, "reverted");
  });
});

Deno.test("queue recovers re-inclusion after expiry for reverts before and after expiry", async () => {
  for (const revertMinute of [55, 61]) {
    await withService(async ({ service, rpc, clock, kv }) => {
      const invoice = await createTestInvoice(service, `post-expiry-revert-${revertMinute}`);
      const queue = invoiceQueue(service, kv, clock);
      const transactionHash = hash(96);
      clock.advance(40 * 60_000);
      rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
        transactionHash,
        blockNumber: 100n,
        includedAt: clock.now(),
      });
      rpc.setHeads(103n, 99n, null);
      await service.claimPayment(invoice.id, claim(transactionHash, 100n));
      clock.advance((revertMinute - 40) * 60_000);
      rpc.reorgTransfer(transactionHash);
      await queue.runDue();
      assertEquals((await service.getInvoice(invoice.id)).status, "reverted");
      rpc.reincludeTransfer(transactionHash, 104n, 5);
      rpc.setHeads(110n, 101n, 99n);
      clock.advance(10 * 60_000);
      await queue.runDue();
      assertEquals((await service.getInvoice(invoice.id)).status, "reverted");
      rpc.setHeads(120n, 110n, null);
      const watch = (await kv.get<WorkRecord>(workKey("reconcile_invoice", invoice.id))).value!;
      clock.advance(watch.dueAt - clock.now().getTime());
      await queue.runDue();
      assertEquals((await service.getInvoice(invoice.id)).status, "provisionally_paid");
      assertEquals(
        (await service.listOutbox()).filter((event) => event.type === "payment.accepted.v1").length,
        2,
      );
    });
  }
});

Deno.test("startup recovers pre-cutover invoices/outbox, preserves retries, and prunes orphan indexes", async () => {
  await withService(async ({ service, rpc, clock, kv }) => {
    const invoice = await createTestInvoice(service, "recover-invoice");
    rpc.addTransfer(await service.getInvoiceRecord(invoice.id), {
      transactionHash: hash(84),
      blockNumber: 100n,
      includedAt: clock.now(),
    });
    rpc.setHeads(103n, null, null);
    await service.claimPayment(invoice.id, claim(hash(84), 100n));
    const [event] = await service.listOutbox();
    await service.markOutboxFailed(event.id, "offline retry");
    const job = (await kv.get<WorkRecord>(workKey("deliver_event", event.id))).value!;
    await kv.set(workKey("deliver_event", event.id), {
      ...job,
      attempts: 7,
      leaseId: "dead",
      leaseUntil: job.dueAt + 1_000,
    });
    await kv.delete(workKey("reconcile_invoice", invoice.id));
    await kv.set(["uos_checkout", "v1", "payments", "invoices_by_chain", 8453, "orphan"], "orphan");
    await kv.set(["uos_checkout", "v1", "payments", "outbox", 0, "orphan"], "orphan");
    await service.recoverWork();
    await service.recoverWork();
    const recovered = (await kv.get<WorkRecord>(workKey("deliver_event", event.id))).value!;
    assertEquals(recovered.attempts, 7);
    assertEquals(recovered.dueAt, job.dueAt);
    assertEquals(recovered.leaseId, "dead");
    assert((await kv.get(workKey("reconcile_invoice", invoice.id))).value);
    assertEquals((await service.listReconciliationInvoices(8453)).length, 1);
    assertEquals(
      (await kv.get(["uos_checkout", "v1", "payments", "outbox", 0, "orphan"])).value,
      null,
    );
    assertEquals((await service.listOutbox()).length, 0);
  });
});

async function createTestInvoice(service: PaymentService, key: string) {
  await service.publishCatalogVersion(
    { merchantId: MERCHANT },
    "prices",
    catalog([product("pack", 100)]),
  );
  return service.createInvoice(context(key), {
    customerReference: key,
    pricingVersionId: "prices",
    productId: "pack",
    chainId: 8453,
  });
}

function invoiceQueue(service: PaymentService, kv: Deno.Kv, clock: MutableClock) {
  return createWorkQueue({
    kv,
    clock,
    handle: (job) =>
      job.type === "deliver_event"
        ? Promise.resolve(clock.now().getTime() + 24 * 60 * 60_000)
        : service.runInvoiceWork(job),
  });
}

async function withService(
  fn: (context: {
    service: PaymentService;
    rpc: MockRpc;
    clock: MutableClock;
    kv: Deno.Kv;
  }) => Promise<void>,
  options: { discountStart?: () => bigint } = {},
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const clock = new MutableClock("2026-07-21T12:00:00.000Z");
  const rpc = new MockRpc();
  let id = 0;
  const signer = createPersistentJwsSigner(kv, clock);
  const service = createPaymentService({
    kv,
    rpc,
    signer,
    clock,
    idGenerator: { next: () => `test-${++id}` },
    discountStart: options.discountStart ?? (() => 1n),
  });
  await service.configureChain(8453, { enabled: true, treasuryAddress: TREASURY });
  try {
    await fn({ service, rpc, clock, kv });
  } finally {
    kv.close();
  }
}

class MutableClock {
  #now: number;
  constructor(value: string) {
    this.#now = Date.parse(value);
  }
  now(): Date {
    return new Date(this.#now);
  }
  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

type MockTransfer = {
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  includedAt: Date;
  tokenAddress: string;
  treasuryAddress: string;
  amountUnits: bigint;
};

class MockRpc implements RpcClient {
  requests = 0;
  failures = 0;
  logRanges: [bigint, bigint][] = [];
  beforeLogs?: () => Promise<void>;
  #transfers = new Map<string, MockTransfer>();
  #missingReceipts = new Set<string>();
  #canonicalOverrides = new Map<string, string>();
  #latest = 99n;
  #safe: bigint | null = null;
  #finalized: bigint | null = null;

  setHeads(latest: bigint, safe: bigint | null, finalized: bigint | null): void {
    this.#latest = latest;
    this.#safe = safe;
    this.#finalized = finalized;
  }

  addTransfer(
    invoice: InvoiceRecord,
    input: {
      transactionHash: string;
      blockNumber: bigint;
      includedAt: Date;
      logIndex?: number;
    },
  ): void {
    this.#transfers.set(input.transactionHash.toLowerCase(), {
      transactionHash: input.transactionHash.toLowerCase(),
      logIndex: input.logIndex ?? 0,
      blockNumber: input.blockNumber,
      blockHash: hash(Number(input.blockNumber) + 1000),
      includedAt: input.includedAt,
      tokenAddress: invoice.tokenAddress,
      treasuryAddress: invoice.treasuryAddress,
      amountUnits: invoice.paidAmountUnits,
    });
  }

  hideReceipt(transactionHash: string): void {
    this.#missingReceipts.add(transactionHash.toLowerCase());
  }

  reorgTransfer(transactionHash: string): void {
    this.#canonicalOverrides.set(transactionHash.toLowerCase(), hash(90_000));
  }

  reincludeTransfer(transactionHash: string, blockNumber: bigint, logIndex?: number): void {
    const key = transactionHash.toLowerCase();
    const transfer = this.#transfers.get(key);
    if (!transfer) throw new Error("missing mock transfer");
    transfer.blockNumber = blockNumber;
    if (logIndex !== undefined) transfer.logIndex = logIndex;
    transfer.blockHash = hash(Number(blockNumber) + 5_000);
    this.#canonicalOverrides.delete(key);
    this.#missingReceipts.delete(key);
  }

  batch(_chainId: 1 | 10 | 8453, calls: readonly JsonRpcCall[]): Promise<JsonRpcBatchItem[]> {
    this.requests++;
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error("offline RPC unavailable"));
    }
    if (calls.length === 1 && calls[0].id === "transfer_logs") {
      const filter = calls[0].params[0] as {
        address: string;
        fromBlock: string;
        toBlock: string;
        topics: [string, null, string];
      };
      const fromBlock = BigInt(filter.fromBlock);
      const toBlock = BigInt(filter.toBlock);
      this.logRanges.push([fromBlock, toBlock]);
      const logs = [...this.#transfers.values()].filter((transfer) =>
        transfer.blockNumber >= fromBlock && transfer.blockNumber <= toBlock &&
        transfer.tokenAddress.toLowerCase() === filter.address.toLowerCase() &&
        addressTopic(transfer.treasuryAddress) === filter.topics[2]
      ).map(rpcLog);
      return (this.beforeLogs?.() ?? Promise.resolve()).then(() => [{
        jsonrpc: "2.0",
        id: "transfer_logs",
        result: logs,
      }]);
    }
    const receiptCall = calls.find((call) => call.id === "receipt");
    const transactionHash = receiptCall ? String(receiptCall.params[0]).toLowerCase() : "";
    const transfer = this.#transfers.get(transactionHash);
    const results: Record<string, unknown> = {
      receipt: transfer && !this.#missingReceipts.has(transactionHash) ? receipt(transfer) : null,
      event_block: transfer
        ? block(
          transfer.blockNumber,
          this.#canonicalOverrides.get(transactionHash) ?? transfer.blockHash,
          transfer.includedAt,
        )
        : null,
      latest: block(this.#latest, hash(Number(this.#latest) + 2000)),
      safe: this.#safe === null ? null : block(this.#safe, hash(Number(this.#safe) + 3000)),
      finalized: this.#finalized === null
        ? null
        : block(this.#finalized, hash(Number(this.#finalized) + 4000)),
    };
    return Promise.resolve(
      calls.map((call) => ({ jsonrpc: "2.0", id: call.id, result: results[call.id] })),
    );
  }
}

function receipt(transfer: MockTransfer) {
  return {
    transactionHash: transfer.transactionHash,
    blockNumber: quantity(transfer.blockNumber),
    blockHash: transfer.blockHash,
    status: "0x1",
    logs: [rpcLog(transfer)],
  };
}

function rpcLog(transfer: MockTransfer) {
  return {
    address: transfer.tokenAddress,
    transactionHash: transfer.transactionHash,
    blockNumber: quantity(transfer.blockNumber),
    blockHash: transfer.blockHash,
    logIndex: quantity(BigInt(transfer.logIndex)),
    removed: false,
    topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(transfer.treasuryAddress)],
    data: word(transfer.amountUnits),
  };
}

function block(number: bigint, blockHash: string, timestamp = new Date("2026-07-21T12:00:00Z")) {
  return {
    number: quantity(number),
    hash: blockHash,
    timestamp: quantity(BigInt(Math.floor(timestamp.getTime() / 1000))),
  };
}

function context(key: string): InvoiceCreationContext {
  return { merchantId: MERCHANT, idempotencyKey: key };
}

function catalog(products: ReturnType<typeof product>[]) {
  return { currency: "USD" as const, products };
}

function product(productId: string, priceCents: number) {
  return {
    productId,
    label: productId,
    kind: "credit_pack" as const,
    priceCents,
    enabled: true,
  };
}

function claim(transactionHash: string, blockNumber: bigint) {
  return {
    transactionHash,
    logIndex: "0",
    observedBlockNumber: blockNumber.toString(),
    observedBlockHash: hash(Number(blockNumber) + 9999),
  };
}

function hash(seed: number): string {
  return `0x${seed.toString(16).padStart(64, "0")}`;
}

function discoveryStateKey(invoiceId: string): Deno.KvKey {
  return ["uos_checkout", "v1", "payments", "discovery_state", invoiceId];
}

function quantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function addressTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

async function assertDomainError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PaymentDomainError && error.code === code) return;
    throw new Error(`Expected ${code}, got ${String(error)}`);
  }
  throw new Error(`Expected rejection ${code}`);
}

async function assertRejects(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("Expected promise rejection");
}

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Expected value to be truthy");
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(`Expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

function deepEqual(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "bigint" || typeof expected === "bigint") return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}
