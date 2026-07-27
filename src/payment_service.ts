import { type CompactJwsSigner } from "./jws.ts";
import {
  catalogVersionKey,
  type Clock,
  getCatalogVersion,
  publishCatalogVersion,
  systemClock,
} from "./payment_catalog.ts";
import {
  boundedText,
  type CatalogVersionRecord,
  CHAIN_CONFIGURATIONS,
  type ChainHeadRecord,
  DEFAULT_CHAIN_ID,
  INVOICE_TTL_MS,
  type InvoiceJson,
  invoiceJson,
  type InvoiceRecord,
  isOpenInvoiceStatus,
  listAmountUnits,
  MAX_DISCOUNT_UNITS,
  MIN_DISCOUNT_UNITS,
  normalizeAddress,
  normalizeTransactionHash,
  type OutboxEventRecord,
  type PaymentChainConfigurationJson,
  type PaymentChainSettings,
  PaymentDomainError,
  type PaymentEventPayload,
  type PaymentEventType,
  type PaymentRecord,
  RECENTLY_EXPIRED_WINDOW_MS,
  type SupportedChainId,
  supportedChainId,
} from "./payment_types.ts";
import {
  chainHeads,
  discoverTransferLogs,
  latestBlockNumber,
  type RpcClient,
  RpcVerificationError,
  type VerifiedTransfer,
  verifyTransferBatch,
} from "./rpc.ts";

const PREFIX: Deno.KvKey = ["uos_checkout", "v1", "payments"];
const INVOICES_PREFIX: Deno.KvKey = [...PREFIX, "invoices"];
const PAYMENTS_PREFIX: Deno.KvKey = [...PREFIX, "payment_records"];
const LOCATORS_PREFIX: Deno.KvKey = [...PREFIX, "payment_locators"];
const RESERVATIONS_PREFIX: Deno.KvKey = [...PREFIX, "amount_reservations"];
const OPEN_INVOICES_PREFIX: Deno.KvKey = [...PREFIX, "open_invoices"];
const IDEMPOTENCY_PREFIX: Deno.KvKey = [...PREFIX, "idempotency"];
const INVOICES_BY_CHAIN_PREFIX: Deno.KvKey = [...PREFIX, "invoices_by_chain"];
const HEADS_PREFIX: Deno.KvKey = [...PREFIX, "chain_heads"];
const EVENTS_PREFIX: Deno.KvKey = [...PREFIX, "events"];
const EVENTS_BY_INVOICE_PREFIX: Deno.KvKey = [...PREFIX, "events_by_invoice"];
const OUTBOX_PREFIX: Deno.KvKey = [...PREFIX, "outbox"];
const CURSORS_PREFIX: Deno.KvKey = [...PREFIX, "reconciliation_cursors"];
const CHAIN_SETTINGS_PREFIX: Deno.KvKey = [...PREFIX, "chain_settings"];

const EVENT_ISSUER = "https://checkout.ubq.fi";
const EVENT_TTL_SECONDS = 24 * 60 * 60;
const SEALED_BLOCKS_REQUIRED = 3n;
const RECONCILIATION_OVERLAP_BLOCKS = 128n;
const OUTBOX_INITIAL_BACKOFF_MS = 60_000;
const OUTBOX_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const AMOUNT_RESERVATION_REUSE_DELAY_MS = RECENTLY_EXPIRED_WINDOW_MS;
const MAX_AMOUNT_RESERVATION_PROBES = 64;

export type IdGenerator = { next(): string };

export type PaymentServiceOptions = {
  kv: Deno.Kv;
  rpc: RpcClient;
  signer: CompactJwsSigner;
  clock?: Clock;
  idGenerator?: IdGenerator;
  discountStart?: () => bigint;
};

export type MerchantContext = {
  merchantId: string;
};

export type InvoiceCreationContext = MerchantContext & {
  idempotencyKey: string;
};

export type CreateInvoiceInput = {
  customerReference: unknown;
  pricingVersionId: unknown;
  productId: unknown;
  chainId?: unknown;
};

export type ClaimPaymentInput = {
  transactionHash: unknown;
  logIndex: unknown;
  observedBlockNumber: unknown;
  observedBlockHash?: unknown;
};

export type ClaimPaymentResult = {
  invoice: InvoiceJson;
  eventJws?: string;
};

type OpenInvoiceIndex = {
  invoiceId: string;
  requestFingerprint: string;
};

type IdempotencyIndex = OpenInvoiceIndex;

type AmountReservation = {
  invoiceId: string;
  reservedAt: string;
};

type LocatorIndex = {
  invoiceId: string;
  paymentId: string;
  duplicate: boolean;
};

type ReconciliationCursor = {
  chainId: SupportedChainId;
  blockNumber: bigint;
  updatedAt: string;
};

type DeliveryEventRecord = OutboxEventRecord & {
  deliveryAttempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  lastError?: string;
};

export type SignedOutboxEvent = DeliveryEventRecord & { compactJws: string };

export type ReconciliationWatch = {
  fromBlock: bigint;
  toBlock: bigint;
  invoices: InvoiceRecord[];
};

export type PaymentService = ReturnType<typeof createPaymentService>;

export function createPaymentService(options: PaymentServiceOptions) {
  const kv = options.kv;
  const rpc = options.rpc;
  const signer = options.signer;
  const clock = options.clock ?? systemClock;
  const idGenerator = options.idGenerator ?? { next: () => crypto.randomUUID() };
  const discountStart = options.discountStart ?? randomDiscountStart;
  return {
    publishCatalogVersion: (
      context: MerchantContext,
      pricingVersionId: unknown,
      projection: unknown,
    ) =>
      publishCatalogVersion(
        kv,
        merchantId(context),
        pricingVersionId,
        projection,
        clock,
      ),
    getCatalogVersion: (context: MerchantContext, pricingVersionId: unknown) =>
      getCatalogVersion(kv, merchantId(context), pricingVersionId),
    configureChain: (chainId: unknown, input: { enabled: unknown; treasuryAddress: unknown }) =>
      configureChain(chainId, input),
    getChainConfiguration: (chainId: unknown) =>
      getChainConfiguration(kv, supportedChainId(chainId)),
    listChainConfigurations: () => listChainConfigurations(kv),
    createInvoice: (context: InvoiceCreationContext, input: CreateInvoiceInput) =>
      createInvoice(context, input),
    getInvoice: async (invoiceId: unknown) => invoiceJson(await invoiceRecord(kv, invoiceId)),
    listInvoices: (limit?: number) => listInvoices(kv, limit),
    getInvoiceRecord: (invoiceId: unknown) => invoiceRecord(kv, invoiceId),
    claimPayment: (invoiceId: unknown, input: ClaimPaymentInput) => claimPayment(invoiceId, input),
    refreshInvoice: (invoiceId: unknown) => refreshInvoice(invoiceId),
    expireInvoice: (invoiceId: unknown) => expireInvoice(invoiceId),
    markManualReview: (invoiceId: unknown) => markManualReview(invoiceId),
    listOutbox: (limit?: number) => listOutbox(kv, signer, clock, limit),
    markOutboxDelivered: (eventId: unknown) => markOutboxDelivered(kv, eventId, clock),
    markOutboxFailed: (eventId: unknown, reason: unknown) =>
      markOutboxFailed(kv, eventId, reason, clock),
    listReconciliationInvoices: (chainId: unknown) =>
      listReconciliationInvoices(kv, supportedChainId(chainId), clock),
    reconcileChainRange: (
      chainId: unknown,
      toBlock: bigint,
      worker: (watch: ReconciliationWatch) => Promise<void>,
    ) => reconcileChainRange(supportedChainId(chainId), toBlock, worker),
    reconcileHourly: (chainId: unknown, toBlock?: bigint) =>
      reconcileHourly(supportedChainId(chainId), toBlock),
    jwks: () => signer.jwks(),
  };

  async function configureChain(
    chainIdInput: unknown,
    input: { enabled: unknown; treasuryAddress: unknown },
  ): Promise<PaymentChainSettings> {
    const chainId = supportedChainId(chainIdInput);
    if (typeof input.enabled !== "boolean") {
      throw new PaymentDomainError("invalid_chain_enabled");
    }
    const treasuryAddress = normalizeAddress(input.treasuryAddress);
    const chain = CHAIN_CONFIGURATIONS[chainId];
    if (
      treasuryAddress === "0x0000000000000000000000000000000000000000" ||
      treasuryAddress === normalizeAddress(chain.tokenAddress)
    ) throw new PaymentDomainError("invalid_treasury_address");
    while (true) {
      const existing = await kv.get<PaymentChainSettings>(chainSettingsKey(chainId));
      const record: PaymentChainSettings = {
        schemaVersion: 1,
        chainId,
        enabled: input.enabled,
        treasuryAddress,
        revision: (existing.value?.revision ?? 0) + 1,
        updatedAt: clock.now().toISOString(),
      };
      if ((await kv.atomic().check(existing).set(chainSettingsKey(chainId), record).commit()).ok) {
        return record;
      }
    }
  }

  async function createInvoice(
    contextInput: InvoiceCreationContext,
    input: CreateInvoiceInput,
  ): Promise<InvoiceJson> {
    const merchant = merchantId(contextInput);
    const idempotencyKey = boundedText(contextInput.idempotencyKey, "idempotency_key", 200);
    const customerReference = boundedText(input.customerReference, "customer_reference", 256);
    const pricingVersionId = boundedText(input.pricingVersionId, "pricing_version_id", 128);
    const productId = boundedText(input.productId, "product_id", 128);
    const chainId = input.chainId === undefined
      ? DEFAULT_CHAIN_ID
      : supportedChainId(input.chainId);
    const requestFingerprint = JSON.stringify({
      merchant,
      customerReference,
      pricingVersionId,
      productId,
      chainId,
    });
    const idempotencyKeyEntry = idempotencyIndexKey(merchant, idempotencyKey);
    const openKey = openInvoiceKey(merchant, customerReference, productId, chainId);

    creationLoop: while (true) {
      const idempotency = await kv.get<IdempotencyIndex>(idempotencyKeyEntry);
      if (idempotency.value) {
        if (idempotency.value.requestFingerprint !== requestFingerprint) {
          throw new PaymentDomainError("idempotency_key_conflict");
        }
        return invoiceJson(await invoiceRecord(kv, idempotency.value.invoiceId));
      }

      const open = await kv.get<OpenInvoiceIndex>(openKey);
      if (open.value) {
        const existing = await kv.get<InvoiceRecord>(invoiceKey(open.value.invoiceId));
        if (!existing.value || !isOpenInvoiceStatus(existing.value.status)) {
          await kv.atomic().check(open).delete(openKey).commit();
          continue;
        }
        if (
          existing.value.status === "awaiting_payment" &&
          Date.parse(existing.value.expiresAt) <= clock.now().getTime()
        ) {
          await expireAwaiting(kv, clock, existing, open, openKey);
          continue;
        }
        if (open.value.requestFingerprint !== requestFingerprint) {
          throw new PaymentDomainError("open_invoice_conflict");
        }
        const committed = await kv.atomic()
          .check(idempotency)
          .check(open)
          .set(idempotencyKeyEntry, open.value)
          .commit();
        if (committed.ok) return invoiceJson(existing.value);
        continue;
      }

      const versionEntry = await kv.get<CatalogVersionRecord>(
        catalogVersionKey(merchant, pricingVersionId),
      );
      const version = versionEntry.value;
      if (!version) throw new PaymentDomainError("catalog_version_not_found");
      const product = version.projection.products.find((candidate) =>
        candidate.productId === productId
      );
      if (!product) throw new PaymentDomainError("catalog_product_not_found");
      if (!product.enabled) throw new PaymentDomainError("catalog_product_disabled");

      const chain = CHAIN_CONFIGURATIONS[chainId];
      const chainSettingsEntry = await kv.get<PaymentChainSettings>(chainSettingsKey(chainId));
      const chainSettings = chainSettingsEntry.value;
      if (!chainSettings) throw new PaymentDomainError("chain_not_configured");
      if (!chainSettings.enabled) throw new PaymentDomainError("chain_disabled");
      const treasuryAddress = chainSettings.treasuryAddress;
      const listUnits = listAmountUnits(product.priceCents);
      const latest = await latestBlockNumber(rpc, chainId);
      const now = clock.now();
      const invoiceId = idGenerator.next();
      let candidate = normalizeDiscountStart(discountStart());

      for (let attempts = 0; attempts < MAX_AMOUNT_RESERVATION_PROBES; attempts++) {
        const paidAmountUnits = listUnits - candidate;
        const reservationKey = amountReservationKey(
          chainId,
          chain.tokenAddress,
          treasuryAddress,
          paidAmountUnits,
        );
        const [reservation, currentOpen, currentIdempotency] = await Promise.all([
          kv.get<AmountReservation>(reservationKey),
          kv.get<OpenInvoiceIndex>(openKey),
          kv.get<IdempotencyIndex>(idempotencyKeyEntry),
        ]);
        if (currentIdempotency.value || currentOpen.value) break;
        let reservedInvoice: Deno.KvEntryMaybe<InvoiceRecord> | null = null;
        if (reservation.value !== null) {
          if (typeof reservation.value.invoiceId !== "string") {
            candidate = nextDiscount(candidate);
            continue;
          }
          reservedInvoice = await kv.get<InvoiceRecord>(
            invoiceKey(reservation.value.invoiceId),
          );
          if (!reservationCanBeReused(reservedInvoice.value, now)) {
            candidate = nextDiscount(candidate);
            continue;
          }
        }

        const timestamp = now.toISOString();
        const record: InvoiceRecord = {
          schemaVersion: 1,
          id: invoiceId,
          merchant,
          idempotencyKey,
          customerReference,
          pricingVersionId,
          catalogDigest: version.digest,
          productId,
          productKind: product.kind,
          chainId,
          networkName: chain.networkName,
          tokenAddress: normalizeAddress(chain.tokenAddress),
          tokenSymbol: chain.tokenSymbol,
          tokenDecimals: chain.tokenDecimals,
          treasuryAddress,
          listAmountUnits: listUnits,
          paidAmountUnits,
          discountUnits: candidate,
          minimumBlock: latest + 1n,
          status: "awaiting_payment",
          createdAt: timestamp,
          expiresAt: new Date(now.getTime() + INVOICE_TTL_MS).toISOString(),
          updatedAt: timestamp,
        };
        const index: OpenInvoiceIndex = { invoiceId, requestFingerprint };
        let atomic = kv.atomic()
          .check(versionEntry)
          .check(chainSettingsEntry)
          .check(reservation)
          .check(currentOpen)
          .check(currentIdempotency)
          .set(reservationKey, { invoiceId, reservedAt: timestamp } satisfies AmountReservation)
          .set(invoiceKey(invoiceId), record)
          .set(invoiceByChainKey(chainId, invoiceId), invoiceId)
          .set(openKey, index)
          .set(idempotencyKeyEntry, index);
        if (reservedInvoice) atomic = atomic.check(reservedInvoice);
        const committed = await atomic.commit();
        if (committed.ok) return invoiceJson(record);
        continue creationLoop;
      }

      const racedIdempotency = await kv.get<IdempotencyIndex>(idempotencyKeyEntry);
      if (racedIdempotency.value) continue;
      const racedOpen = await kv.get<OpenInvoiceIndex>(openKey);
      if (racedOpen.value) continue;
      throw new PaymentDomainError("amount_space_exhausted");
    }
  }

  async function claimPayment(
    invoiceIdInput: unknown,
    input: ClaimPaymentInput,
  ): Promise<ClaimPaymentResult> {
    const invoiceId = boundedText(invoiceIdInput, "invoice_id", 128);
    const invoiceEntry = await kv.get<InvoiceRecord>(invoiceKey(invoiceId));
    if (!invoiceEntry.value) throw new PaymentDomainError("invoice_not_found");
    const invoice = invoiceEntry.value;
    const transactionHash = normalizeTransactionHash(input.transactionHash);
    const logIndexBigint = decimalBigint(input.logIndex, "invalid_log_index");
    if (logIndexBigint > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PaymentDomainError("invalid_log_index");
    }
    const logIndex = Number(logIndexBigint);
    const observedBlockNumber = decimalBigint(
      input.observedBlockNumber,
      "invalid_observed_block_number",
    );
    const observedBlockHash = input.observedBlockHash === undefined
      ? undefined
      : boundedText(input.observedBlockHash, "observed_block_hash", 66);
    const locatorKey = paymentLocatorKey(invoice.chainId, transactionHash, logIndex);
    const existingLocator = await kv.get<LocatorIndex>(locatorKey);
    if (existingLocator.value) {
      if (existingLocator.value.invoiceId !== invoice.id) {
        throw new PaymentDomainError("payment_locator_already_claimed");
      }
      if (invoice.status === "reverted") {
        return reincludeRevertedPayment(
          invoiceEntry,
          existingLocator,
          transactionHash,
          logIndex,
          observedBlockNumber,
          observedBlockHash,
        );
      }
      const refreshed = await refreshInvoice(invoice.id);
      if (refreshed.eventJws) return refreshed;
      return { ...refreshed, eventJws: await signedExistingEvent(invoice.id) };
    }

    const evidence = await verifyTransferBatch(rpc, invoice.chainId, {
      transactionHash,
      logIndex,
      observedBlockNumber,
      observedBlockHash,
      tokenAddress: invoice.tokenAddress,
      recipientAddress: invoice.treasuryAddress,
      amountUnits: invoice.paidAmountUnits,
    });
    if (evidence.blockNumber < invoice.minimumBlock) {
      throw new PaymentDomainError("payment_before_minimum_block");
    }

    if (invoice.paymentId) {
      return recordDuplicatePayment(invoiceEntry, locatorKey, existingLocator, evidence);
    }
    return recordPrimaryPayment(invoiceEntry, locatorKey, existingLocator, evidence);
  }

  async function reincludeRevertedPayment(
    invoiceEntry: Deno.KvEntryMaybe<InvoiceRecord>,
    locatorEntry: Deno.KvEntryMaybe<LocatorIndex>,
    transactionHash: string,
    logIndex: number,
    observedBlockNumber: bigint,
    observedBlockHash: string | undefined,
  ): Promise<ClaimPaymentResult> {
    const invoice = invoiceEntry.value!;
    if (!invoice.paymentId || locatorEntry.value?.paymentId !== invoice.paymentId) {
      throw new PaymentDomainError("payment_record_not_found");
    }
    const paymentEntry = await kv.get<PaymentRecord>(paymentKey(invoice.paymentId));
    if (!paymentEntry.value) throw new PaymentDomainError("payment_record_not_found");
    const evidence = await verifyTransferBatch(rpc, invoice.chainId, {
      transactionHash,
      logIndex,
      observedBlockNumber,
      observedBlockHash,
      tokenAddress: invoice.tokenAddress,
      recipientAddress: invoice.treasuryAddress,
      amountUnits: invoice.paidAmountUnits,
    });
    if (evidence.blockNumber < invoice.minimumBlock) {
      throw new PaymentDomainError("payment_before_minimum_block");
    }

    const timestamp = clock.now().toISOString();
    const headsEntry = await kv.get<ChainHeadRecord>(headKey(invoice.chainId));
    const heads = mergeHeads(invoice.chainId, headsEntry.value, evidence, timestamp);
    const sealed = heads.latestBlock >= evidence.blockNumber + SEALED_BLOCKS_REQUIRED;
    const openKey = openInvoiceKey(
      invoice.merchant,
      invoice.customerReference,
      invoice.productId,
      invoice.chainId,
    );
    const openEntry = await kv.get<OpenInvoiceIndex>(openKey);
    const conflictingOpen = openEntry.value !== null && openEntry.value.invoiceId !== invoice.id;
    const nextInvoice: InvoiceRecord = {
      ...invoice,
      status: sealed ? "provisionally_paid" : "confirming",
      acceptedAt: sealed ? timestamp : undefined,
      settledAt: undefined,
      finalizedAt: undefined,
      revertedAt: undefined,
      requiresManualReview: conflictingOpen || invoice.requiresManualReview,
      updatedAt: timestamp,
    };
    const nextPayment: PaymentRecord = {
      ...paymentEntry.value,
      transactionHash: evidence.transactionHash,
      logIndex: evidence.logIndex,
      payer: evidence.payerAddress,
      tokenAddress: evidence.tokenAddress,
      treasuryAddress: evidence.recipientAddress,
      amountUnits: evidence.amountUnits,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      blockTimestamp: evidence.blockTimestamp.toISOString(),
      phase: sealed ? "accepted" : "confirming",
      acceptedAt: sealed ? timestamp : undefined,
      settledAt: undefined,
      finalizedAt: undefined,
      revertedAt: undefined,
      updatedAt: timestamp,
    };
    const event = sealed
      ? await makeEvent("payment.accepted.v1", nextInvoice, nextPayment, timestamp)
      : undefined;
    let atomic = kv.atomic()
      .check(invoiceEntry)
      .check(paymentEntry)
      .check(locatorEntry)
      .check(headsEntry)
      .check(openEntry)
      .set(invoiceKey(invoice.id), nextInvoice)
      .set(paymentKey(nextPayment.id), nextPayment)
      .set(headKey(invoice.chainId), heads)
      .set(invoiceByChainKey(invoice.chainId, invoice.id), invoice.id);
    if (openEntry.value === null) {
      atomic = atomic.set(
        openKey,
        {
          invoiceId: invoice.id,
          requestFingerprint: invoiceRequestFingerprint(invoice),
        } satisfies OpenInvoiceIndex,
      );
    }
    if (event) atomic = addEventMutations(atomic, event);
    if (!(await atomic.commit()).ok) {
      return claimPayment(invoice.id, {
        transactionHash,
        logIndex: String(logIndex),
        observedBlockNumber: observedBlockNumber.toString(),
        observedBlockHash,
      });
    }
    return { invoice: invoiceJson(nextInvoice), eventJws: event?.compactJws };
  }

  async function recordPrimaryPayment(
    invoiceEntry: Deno.KvEntryMaybe<InvoiceRecord>,
    locatorKey: Deno.KvKey,
    locatorEntry: Deno.KvEntryMaybe<LocatorIndex>,
    evidence: VerifiedTransfer,
  ): Promise<ClaimPaymentResult> {
    const invoice = invoiceEntry.value!;
    const now = clock.now();
    const timestamp = now.toISOString();
    const paymentId = idGenerator.next();
    const payment: PaymentRecord = {
      schemaVersion: 1,
      id: paymentId,
      invoiceId: invoice.id,
      chainId: invoice.chainId,
      transactionHash: evidence.transactionHash,
      logIndex: evidence.logIndex,
      payer: evidence.payerAddress,
      tokenAddress: evidence.tokenAddress,
      treasuryAddress: evidence.recipientAddress,
      amountUnits: evidence.amountUnits,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      blockTimestamp: evidence.blockTimestamp.toISOString(),
      phase: "confirming",
      firstObservedAt: timestamp,
      updatedAt: timestamp,
    };
    const headsEntry = await kv.get<ChainHeadRecord>(headKey(invoice.chainId));
    const heads = mergeHeads(invoice.chainId, headsEntry.value, evidence, timestamp);
    const includedLate = evidence.blockTimestamp.getTime() >= Date.parse(invoice.expiresAt);
    const openKey = openInvoiceKey(
      invoice.merchant,
      invoice.customerReference,
      invoice.productId,
      invoice.chainId,
    );
    const openEntry = await kv.get<OpenInvoiceIndex>(openKey);
    const conflictingOpen = !includedLate && openEntry.value !== null &&
      openEntry.value.invoiceId !== invoice.id;
    let nextInvoice: InvoiceRecord = {
      ...invoice,
      paymentId,
      status: includedLate ? "late_payment" : conflictingOpen ? "manual_review" : "confirming",
      updatedAt: timestamp,
    };
    payment.phase = includedLate ? "late" : conflictingOpen ? "duplicate" : "confirming";

    let event: OutboxEventRecord | undefined;
    if (
      !includedLate && !conflictingOpen &&
      heads.latestBlock >= evidence.blockNumber + SEALED_BLOCKS_REQUIRED
    ) {
      nextInvoice = { ...nextInvoice, status: "provisionally_paid", acceptedAt: timestamp };
      payment.phase = "accepted";
      payment.acceptedAt = timestamp;
      event = await makeEvent("payment.accepted.v1", nextInvoice, payment, timestamp);
    }

    let atomic = kv.atomic()
      .check(invoiceEntry)
      .check(locatorEntry)
      .check(headsEntry)
      .check(openEntry)
      .set(invoiceKey(invoice.id), nextInvoice)
      .set(paymentKey(paymentId), payment)
      .set(
        locatorKey,
        { invoiceId: invoice.id, paymentId, duplicate: false } satisfies LocatorIndex,
      )
      .set(headKey(invoice.chainId), heads);
    if (includedLate && openEntry.value?.invoiceId === invoice.id) {
      atomic = atomic.delete(openKey);
    } else if (!includedLate && !conflictingOpen && openEntry.value === null) {
      atomic = atomic.set(
        openKey,
        {
          invoiceId: invoice.id,
          requestFingerprint: invoiceRequestFingerprint(invoice),
        } satisfies OpenInvoiceIndex,
      );
    }
    if (includedLate || conflictingOpen) {
      atomic = atomic.delete(invoiceByChainKey(invoice.chainId, invoice.id));
    }
    if (event) atomic = addEventMutations(atomic, event);
    const committed = await atomic.commit();
    if (!committed.ok) {
      return claimPayment(invoice.id, {
        transactionHash: evidence.transactionHash,
        logIndex: String(evidence.logIndex),
        observedBlockNumber: evidence.blockNumber.toString(),
        observedBlockHash: evidence.blockHash,
      });
    }
    return { invoice: invoiceJson(nextInvoice), eventJws: event?.compactJws };
  }

  async function recordDuplicatePayment(
    invoiceEntry: Deno.KvEntryMaybe<InvoiceRecord>,
    locatorKey: Deno.KvKey,
    locatorEntry: Deno.KvEntryMaybe<LocatorIndex>,
    evidence: VerifiedTransfer,
  ): Promise<ClaimPaymentResult> {
    const invoice = invoiceEntry.value!;
    const timestamp = clock.now().toISOString();
    const paymentId = idGenerator.next();
    const payment: PaymentRecord = {
      schemaVersion: 1,
      id: paymentId,
      invoiceId: invoice.id,
      chainId: invoice.chainId,
      transactionHash: evidence.transactionHash,
      logIndex: evidence.logIndex,
      payer: evidence.payerAddress,
      tokenAddress: evidence.tokenAddress,
      treasuryAddress: evidence.recipientAddress,
      amountUnits: evidence.amountUnits,
      blockNumber: evidence.blockNumber,
      blockHash: evidence.blockHash,
      blockTimestamp: evidence.blockTimestamp.toISOString(),
      phase: "duplicate",
      firstObservedAt: timestamp,
      updatedAt: timestamp,
    };
    const nextInvoice: InvoiceRecord = {
      ...invoice,
      requiresManualReview: true,
      updatedAt: timestamp,
    };
    const openKey = openInvoiceKey(
      invoice.merchant,
      invoice.customerReference,
      invoice.productId,
      invoice.chainId,
    );
    const openEntry = await kv.get<OpenInvoiceIndex>(openKey);
    let atomic = kv.atomic().check(invoiceEntry).check(locatorEntry)
      .set(invoiceKey(invoice.id), nextInvoice)
      .set(paymentKey(paymentId), payment)
      .set(
        locatorKey,
        { invoiceId: invoice.id, paymentId, duplicate: true } satisfies LocatorIndex,
      );
    if (openEntry.value?.invoiceId === invoice.id) atomic = atomic.check(openEntry).delete(openKey);
    const committed = await atomic.commit();
    if (!committed.ok) throw new PaymentDomainError("payment_claim_conflict");
    return { invoice: invoiceJson(nextInvoice) };
  }

  async function refreshInvoice(invoiceIdInput: unknown): Promise<ClaimPaymentResult> {
    const invoiceId = boundedText(invoiceIdInput, "invoice_id", 128);
    const invoiceEntry = await kv.get<InvoiceRecord>(invoiceKey(invoiceId));
    if (!invoiceEntry.value) throw new PaymentDomainError("invoice_not_found");
    const invoice = invoiceEntry.value;
    if (!invoice.paymentId) {
      return { invoice: await expireInvoice(invoice.id) };
    }
    const paymentEntry = await kv.get<PaymentRecord>(paymentKey(invoice.paymentId));
    if (!paymentEntry.value) throw new PaymentDomainError("payment_record_not_found");
    const payment = paymentEntry.value;

    let evidence: VerifiedTransfer;
    try {
      evidence = await verifyTransferBatch(rpc, invoice.chainId, {
        transactionHash: payment.transactionHash,
        logIndex: payment.logIndex,
        observedBlockNumber: payment.blockNumber,
        observedBlockHash: payment.blockHash,
        previouslyVerifiedBlockHash: payment.blockHash,
        tokenAddress: invoice.tokenAddress,
        recipientAddress: invoice.treasuryAddress,
        amountUnits: invoice.paidAmountUnits,
      });
    } catch (error) {
      if (!(error instanceof RpcVerificationError)) throw error;
      if (!error.canonicalContradiction) return { invoice: invoiceJson(invoice) };
      return handleReorg(invoiceEntry, paymentEntry, error.code);
    }

    const timestamp = clock.now().toISOString();
    const headsEntry = await kv.get<ChainHeadRecord>(headKey(invoice.chainId));
    const heads = mergeHeads(invoice.chainId, headsEntry.value, evidence, timestamp);
    let nextInvoice = invoice;
    let nextPayment = payment;
    let event: OutboxEventRecord | undefined;

    if (
      invoice.status === "confirming" &&
      heads.latestBlock >= payment.blockNumber + SEALED_BLOCKS_REQUIRED
    ) {
      nextInvoice = {
        ...invoice,
        status: "provisionally_paid",
        acceptedAt: timestamp,
        updatedAt: timestamp,
      };
      nextPayment = { ...payment, phase: "accepted", acceptedAt: timestamp, updatedAt: timestamp };
      event = await makeEvent("payment.accepted.v1", nextInvoice, nextPayment, timestamp);
    } else if (
      invoice.status === "provisionally_paid" && heads.safeBlock !== null &&
      heads.safeBlock >= payment.blockNumber
    ) {
      nextInvoice = { ...invoice, status: "settled", settledAt: timestamp, updatedAt: timestamp };
      nextPayment = { ...payment, phase: "settled", settledAt: timestamp, updatedAt: timestamp };
      event = await makeEvent("payment.settled.v1", nextInvoice, nextPayment, timestamp);
    } else if (
      invoice.status === "settled" && heads.finalizedBlock !== null &&
      heads.finalizedBlock >= payment.blockNumber
    ) {
      nextInvoice = {
        ...invoice,
        status: "finalized",
        finalizedAt: timestamp,
        updatedAt: timestamp,
      };
      nextPayment = {
        ...payment,
        phase: "finalized",
        finalizedAt: timestamp,
        updatedAt: timestamp,
      };
    } else {
      if (!headAdvanced(headsEntry.value, heads)) return { invoice: invoiceJson(invoice) };
    }

    const openKey = openInvoiceKey(
      invoice.merchant,
      invoice.customerReference,
      invoice.productId,
      invoice.chainId,
    );
    const openEntry = await kv.get<OpenInvoiceIndex>(openKey);
    let atomic = kv.atomic().check(invoiceEntry).check(paymentEntry).check(headsEntry)
      .set(invoiceKey(invoice.id), nextInvoice)
      .set(paymentKey(payment.id), nextPayment)
      .set(headKey(invoice.chainId), heads);
    if (nextInvoice.status === "finalized" && openEntry.value?.invoiceId === invoice.id) {
      atomic = atomic.check(openEntry).delete(openKey);
    }
    if (nextInvoice.status === "finalized") {
      atomic = atomic.delete(invoiceByChainKey(invoice.chainId, invoice.id));
    }
    if (event) atomic = addEventMutations(atomic, event);
    const committed = await atomic.commit();
    if (!committed.ok) return refreshInvoice(invoice.id);
    return { invoice: invoiceJson(nextInvoice), eventJws: event?.compactJws };
  }

  async function handleReorg(
    invoiceEntry: Deno.KvEntryMaybe<InvoiceRecord>,
    paymentEntry: Deno.KvEntryMaybe<PaymentRecord>,
    reason: string,
  ): Promise<ClaimPaymentResult> {
    const invoice = invoiceEntry.value!;
    const payment = paymentEntry.value!;
    const timestamp = clock.now().toISOString();
    const locatorKey = paymentLocatorKey(
      invoice.chainId,
      payment.transactionHash,
      payment.logIndex,
    );
    const locatorEntry = await kv.get<LocatorIndex>(locatorKey);
    const openKey = openInvoiceKey(
      invoice.merchant,
      invoice.customerReference,
      invoice.productId,
      invoice.chainId,
    );
    const openEntry = await kv.get<OpenInvoiceIndex>(openKey);

    if (invoice.status === "confirming" && !invoice.acceptedAt) {
      const expired = clock.now().getTime() >= Date.parse(invoice.expiresAt);
      const nextInvoice: InvoiceRecord = {
        ...invoice,
        paymentId: undefined,
        status: expired ? "expired" : "awaiting_payment",
        expiredAt: expired ? timestamp : undefined,
        updatedAt: timestamp,
      };
      let atomic = kv.atomic().check(invoiceEntry).check(paymentEntry).check(locatorEntry)
        .set(invoiceKey(invoice.id), nextInvoice)
        .delete(paymentKey(payment.id))
        .delete(locatorKey);
      if (expired && openEntry.value?.invoiceId === invoice.id) {
        atomic = atomic.check(openEntry).delete(openKey);
      }
      const committed = await atomic.commit();
      if (!committed.ok) return refreshInvoice(invoice.id);
      return { invoice: invoiceJson(nextInvoice) };
    }

    if (invoice.status === "reverted") return { invoice: invoiceJson(invoice) };
    const nextInvoice: InvoiceRecord = {
      ...invoice,
      status: "reverted",
      revertedAt: timestamp,
      updatedAt: timestamp,
    };
    const nextPayment: PaymentRecord = {
      ...payment,
      phase: "reverted",
      revertedAt: timestamp,
      updatedAt: timestamp,
    };
    const event = await makeEvent(
      "payment.reverted.v1",
      nextInvoice,
      nextPayment,
      timestamp,
      reason,
    );
    let atomic = addEventMutations(
      kv.atomic().check(invoiceEntry).check(paymentEntry)
        .set(invoiceKey(invoice.id), nextInvoice)
        .set(paymentKey(payment.id), nextPayment)
        .set(invoiceByChainKey(invoice.chainId, invoice.id), invoice.id),
      event,
    );
    if (openEntry.value?.invoiceId === invoice.id) atomic = atomic.check(openEntry).delete(openKey);
    const committed = await atomic.commit();
    if (!committed.ok) return refreshInvoice(invoice.id);
    return { invoice: invoiceJson(nextInvoice), eventJws: event.compactJws };
  }

  async function expireInvoice(invoiceIdInput: unknown): Promise<InvoiceJson> {
    const invoiceId = boundedText(invoiceIdInput, "invoice_id", 128);
    while (true) {
      const invoiceEntry = await kv.get<InvoiceRecord>(invoiceKey(invoiceId));
      if (!invoiceEntry.value) throw new PaymentDomainError("invoice_not_found");
      const invoice = invoiceEntry.value;
      if (
        invoice.status !== "awaiting_payment" ||
        clock.now().getTime() < Date.parse(invoice.expiresAt)
      ) return invoiceJson(invoice);
      const openKey = openInvoiceKey(
        invoice.merchant,
        invoice.customerReference,
        invoice.productId,
        invoice.chainId,
      );
      const openEntry = await kv.get<OpenInvoiceIndex>(openKey);
      const nextInvoice = await expireAwaiting(kv, clock, invoiceEntry, openEntry, openKey);
      if (nextInvoice) return invoiceJson(nextInvoice);
    }
  }

  async function markManualReview(invoiceIdInput: unknown): Promise<InvoiceJson> {
    const invoiceId = boundedText(invoiceIdInput, "invoice_id", 128);
    while (true) {
      const entry = await kv.get<InvoiceRecord>(invoiceKey(invoiceId));
      if (!entry.value) throw new PaymentDomainError("invoice_not_found");
      if (entry.value.status === "manual_review") return invoiceJson(entry.value);
      const timestamp = clock.now().toISOString();
      const next = { ...entry.value, status: "manual_review" as const, updatedAt: timestamp };
      const openKey = openInvoiceKey(
        entry.value.merchant,
        entry.value.customerReference,
        entry.value.productId,
        entry.value.chainId,
      );
      const openEntry = await kv.get<OpenInvoiceIndex>(openKey);
      let atomic = kv.atomic().check(entry).set(invoiceKey(invoiceId), next);
      atomic = atomic.delete(invoiceByChainKey(entry.value.chainId, invoiceId));
      if (openEntry.value?.invoiceId === invoiceId) {
        atomic = atomic.check(openEntry).delete(openKey);
      }
      if ((await atomic.commit()).ok) return invoiceJson(next);
    }
  }

  async function makeEvent(
    type: PaymentEventType,
    invoice: InvoiceRecord,
    payment: PaymentRecord,
    occurredAt: string,
    reason?: string,
  ): Promise<OutboxEventRecord> {
    const id = idGenerator.next();
    const issuedAt = Math.floor(Date.parse(occurredAt) / 1000);
    const payload: PaymentEventPayload = {
      iss: EVENT_ISSUER,
      aud: invoice.merchant,
      iat: issuedAt,
      exp: issuedAt + EVENT_TTL_SECONDS,
      jti: id,
      type,
      occurredAt,
      merchantId: invoice.merchant,
      customerReference: invoice.customerReference,
      invoiceId: invoice.id,
      productId: invoice.productId,
      pricingVersionId: invoice.pricingVersionId,
      catalogDigest: invoice.catalogDigest,
      chainId: invoice.chainId,
      tokenAddress: invoice.tokenAddress,
      tokenDecimals: invoice.tokenDecimals,
      treasuryAddress: invoice.treasuryAddress,
      listAmountUnits: invoice.listAmountUnits.toString(),
      paidAmountUnits: invoice.paidAmountUnits.toString(),
      discountUnits: invoice.discountUnits.toString(),
      txHash: payment.transactionHash,
      logIndex: payment.logIndex.toString(),
      blockNumber: payment.blockNumber.toString(),
      blockHash: payment.blockHash,
      payer: payment.payer,
      includedAt: payment.blockTimestamp,
      ...(type === "payment.reverted.v1" && reason ? { reason } : {}),
    };
    const compactJws = await signer.sign(payload as unknown as Record<string, unknown>);
    return {
      schemaVersion: 1,
      id,
      invoiceId: invoice.id,
      paymentId: payment.id,
      type,
      payload,
      compactJws,
      createdAt: occurredAt,
      deliveryAttempts: 0,
      nextAttemptAt: occurredAt,
    } as DeliveryEventRecord;
  }

  async function signedExistingEvent(invoiceId: string): Promise<string | undefined> {
    const invoice = await invoiceRecord(kv, invoiceId);
    const types: PaymentEventType[] = invoice.status === "reverted"
      ? ["payment.reverted.v1"]
      : invoice.status === "settled" || invoice.status === "finalized"
      ? ["payment.settled.v1", "payment.accepted.v1"]
      : ["payment.accepted.v1"];
    for (const type of types) {
      const eventId = (await kv.get<string>(eventByInvoiceKey(invoiceId, type))).value;
      if (!eventId) continue;
      const event = (await kv.get<DeliveryEventRecord>(eventKey(eventId))).value;
      if (event) return signEventForDelivery(signer, event, clock.now());
    }
    return undefined;
  }

  async function reconcileChainRange(
    chainId: SupportedChainId,
    toBlock: bigint,
    worker: (watch: ReconciliationWatch) => Promise<void>,
  ): Promise<ReconciliationWatch> {
    if (toBlock < 0n) throw new PaymentDomainError("invalid_reconciliation_block");
    const cursorEntry = await kv.get<ReconciliationCursor>(cursorKey(chainId));
    const invoices = await listReconciliationInvoices(kv, chainId, clock);
    const minimumOutstandingBlock = invoices.reduce(
      (minimum, invoice) => invoice.minimumBlock < minimum ? invoice.minimumBlock : minimum,
      toBlock,
    );
    const fromBlock = cursorEntry.value
      ? maximum(
        minimumOutstandingBlock,
        maximum(0n, cursorEntry.value.blockNumber + 1n - RECONCILIATION_OVERLAP_BLOCKS),
      )
      : minimumOutstandingBlock;
    if (toBlock < fromBlock) throw new PaymentDomainError("reconciliation_range_regressed");
    const watch = { fromBlock, toBlock, invoices };
    await worker(watch);
    const cursor: ReconciliationCursor = {
      chainId,
      blockNumber: toBlock,
      updatedAt: clock.now().toISOString(),
    };
    if (!(await kv.atomic().check(cursorEntry).set(cursorKey(chainId), cursor).commit()).ok) {
      throw new PaymentDomainError("reconciliation_cursor_conflict");
    }
    return watch;
  }

  async function reconcileHourly(
    chainId: SupportedChainId,
    requestedToBlock?: bigint,
  ): Promise<ReconciliationWatch> {
    const observedHeads = requestedToBlock === undefined ? await chainHeads(rpc, chainId) : null;
    const toBlock = requestedToBlock ?? observedHeads!.safeBlock ?? observedHeads!.finalizedBlock ??
      observedHeads!.latestBlock;
    const tokenAddress = CHAIN_CONFIGURATIONS[chainId].tokenAddress;
    return reconcileChainRange(chainId, toBlock, async (watch) => {
      if (watch.invoices.length === 0) return;
      const treasuries = [...new Set(watch.invoices.map((invoice) => invoice.treasuryAddress))];
      const logs = (await Promise.all(treasuries.map((treasuryAddress) =>
        discoverTransferLogs(
          rpc,
          chainId,
          tokenAddress,
          treasuryAddress,
          watch.fromBlock,
          watch.toBlock,
        )
      ))).flat();
      for (const log of logs) {
        const invoice = watch.invoices.find((candidate) =>
          (!candidate.paymentId || candidate.status === "reverted") &&
          candidate.minimumBlock <= log.blockNumber &&
          candidate.tokenAddress.toLowerCase() === log.tokenAddress.toLowerCase() &&
          candidate.treasuryAddress.toLowerCase() === log.recipientAddress.toLowerCase() &&
          candidate.paidAmountUnits === log.amountUnits
        );
        if (!invoice) continue;
        try {
          await claimPayment(invoice.id, {
            transactionHash: log.transactionHash,
            logIndex: log.logIndex.toString(),
            observedBlockNumber: log.blockNumber.toString(),
            observedBlockHash: log.blockHash,
          });
        } catch (error) {
          if (error instanceof RpcVerificationError) continue;
          if (
            error instanceof PaymentDomainError &&
            (error.code === "payment_locator_already_claimed" ||
              error.code === "payment_before_minimum_block")
          ) continue;
          throw error;
        }
      }
      for (const watched of watch.invoices) {
        const current = await invoiceRecord(kv, watched.id);
        if (
          current.paymentId && current.status !== "late_payment" &&
          current.status !== "manual_review"
        ) {
          await refreshInvoice(current.id);
        } else if (!current.paymentId) {
          await expireInvoice(current.id);
        }
      }
    });
  }
}

export async function listReconciliationInvoices(
  kv: Deno.Kv,
  chainId: SupportedChainId,
  clock: Clock = systemClock,
): Promise<InvoiceRecord[]> {
  const invoices: InvoiceRecord[] = [];
  const cutoff = clock.now().getTime() - RECENTLY_EXPIRED_WINDOW_MS;
  for await (
    const entry of kv.list<string>({ prefix: [...INVOICES_BY_CHAIN_PREFIX, chainId] })
  ) {
    const invoice = (await kv.get<InvoiceRecord>(invoiceKey(entry.value))).value;
    if (!invoice) {
      await kv.delete(entry.key);
      continue;
    }
    if (
      isOpenInvoiceStatus(invoice.status) || invoice.status === "confirming" ||
      invoice.status === "reverted" ||
      (invoice.status === "expired" && Date.parse(invoice.expiredAt ?? invoice.updatedAt) >= cutoff)
    ) {
      invoices.push(invoice);
    } else {
      await kv.delete(invoiceByChainKey(chainId, invoice.id));
    }
  }
  return invoices.sort((a, b) => a.minimumBlock < b.minimumBlock ? -1 : a.id.localeCompare(b.id));
}

export async function listOutbox(
  kv: Deno.Kv,
  signer: CompactJwsSigner,
  clock: Clock = systemClock,
  limit = 100,
): Promise<SignedOutboxEvent[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new PaymentDomainError("invalid_outbox_limit");
  }
  const events: SignedOutboxEvent[] = [];
  const now = clock.now();
  const selector = {
    start: [...OUTBOX_PREFIX, 0] as Deno.KvKey,
    end: [...OUTBOX_PREFIX, now.getTime(), "\uffff"] as Deno.KvKey,
  };
  for await (const entry of kv.list<string>(selector)) {
    const event = (await kv.get<DeliveryEventRecord>(eventKey(entry.value))).value;
    if (!event || event.deliveredAt) continue;
    events.push({ ...event, compactJws: await signEventForDelivery(signer, event, now) });
    if (events.length === limit) break;
  }
  return events;
}

export async function markOutboxDelivered(
  kv: Deno.Kv,
  eventIdInput: unknown,
  clock: Clock = systemClock,
): Promise<OutboxEventRecord> {
  const eventId = boundedText(eventIdInput, "event_id", 128);
  while (true) {
    const entry = await kv.get<DeliveryEventRecord>(eventKey(eventId));
    if (!entry.value) throw new PaymentDomainError("event_not_found");
    if (entry.value.deliveredAt) return entry.value;
    const next = { ...entry.value, deliveredAt: clock.now().toISOString() };
    if (
      (await kv.atomic().check(entry).set(eventKey(eventId), next).delete(outboxKey(entry.value))
        .commit())
        .ok
    ) return next;
  }
}

export async function markOutboxFailed(
  kv: Deno.Kv,
  eventIdInput: unknown,
  reason: unknown,
  clock: Clock = systemClock,
): Promise<DeliveryEventRecord> {
  const eventId = boundedText(eventIdInput, "event_id", 128);
  while (true) {
    const entry = await kv.get<DeliveryEventRecord>(eventKey(eventId));
    if (!entry.value) throw new PaymentDomainError("event_not_found");
    if (entry.value.deliveredAt) return entry.value;
    const deliveryAttempts = entry.value.deliveryAttempts + 1;
    const delay = Math.min(
      OUTBOX_INITIAL_BACKOFF_MS * 2 ** Math.min(deliveryAttempts - 1, 20),
      OUTBOX_MAX_BACKOFF_MS,
    );
    const attemptedAt = clock.now();
    const next: DeliveryEventRecord = {
      ...entry.value,
      deliveryAttempts,
      lastAttemptAt: attemptedAt.toISOString(),
      lastError: boundedDeliveryError(reason),
      nextAttemptAt: new Date(attemptedAt.getTime() + delay).toISOString(),
    };
    const committed = await kv.atomic().check(entry)
      .set(eventKey(eventId), next)
      .delete(outboxKey(entry.value))
      .set(outboxKey(next), eventId)
      .commit();
    if (committed.ok) return next;
  }
}

export async function invoiceRecord(kv: Deno.Kv, invoiceIdInput: unknown): Promise<InvoiceRecord> {
  const invoiceId = boundedText(invoiceIdInput, "invoice_id", 128);
  const invoice = (await kv.get<InvoiceRecord>(invoiceKey(invoiceId))).value;
  if (!invoice) throw new PaymentDomainError("invoice_not_found");
  return invoice;
}

export async function listInvoices(kv: Deno.Kv, limit = 50): Promise<InvoiceJson[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new PaymentDomainError("invalid_invoice_limit");
  }
  const invoices: InvoiceRecord[] = [];
  for await (const entry of kv.list<InvoiceRecord>({ prefix: INVOICES_PREFIX })) {
    invoices.push(entry.value);
  }
  return invoices
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, limit)
    .map(invoiceJson);
}

export async function getChainConfiguration(
  kv: Deno.Kv,
  chainId: SupportedChainId,
): Promise<PaymentChainSettings> {
  const settings = (await kv.get<PaymentChainSettings>(chainSettingsKey(chainId))).value;
  if (!settings) throw new PaymentDomainError("chain_not_configured");
  return settings;
}

export async function listChainConfigurations(
  kv: Deno.Kv,
): Promise<PaymentChainConfigurationJson[]> {
  const entries = await Promise.all(
    ([1, 10, 8453] as const).map((chainId) =>
      kv.get<PaymentChainSettings>(chainSettingsKey(chainId))
    ),
  );
  return ([1, 10, 8453] as const).map((chainId, index) => {
    const chain = CHAIN_CONFIGURATIONS[chainId];
    const settings = entries[index].value;
    return {
      ...chain,
      enabled: settings?.enabled ?? false,
      treasuryAddress: settings?.treasuryAddress ?? null,
      revision: settings?.revision ?? 0,
      updatedAt: settings?.updatedAt ?? null,
    };
  });
}

function invoiceKey(invoiceId: string): Deno.KvKey {
  return [...INVOICES_PREFIX, invoiceId];
}

function paymentKey(paymentId: string): Deno.KvKey {
  return [...PAYMENTS_PREFIX, paymentId];
}

function paymentLocatorKey(
  chainId: SupportedChainId,
  transactionHash: string,
  logIndex: number,
): Deno.KvKey {
  return [...LOCATORS_PREFIX, chainId, transactionHash, logIndex];
}

function amountReservationKey(
  chainId: SupportedChainId,
  tokenAddress: string,
  treasuryAddress: string,
  paidAmountUnits: bigint,
): Deno.KvKey {
  return [
    ...RESERVATIONS_PREFIX,
    chainId,
    normalizeAddress(tokenAddress),
    normalizeAddress(treasuryAddress),
    paidAmountUnits.toString(),
  ];
}

function openInvoiceKey(
  merchant: string,
  customerReference: string,
  productId: string,
  chainId: SupportedChainId,
): Deno.KvKey {
  return [...OPEN_INVOICES_PREFIX, merchant, customerReference, productId, chainId];
}

function idempotencyIndexKey(merchant: string, idempotencyKey: string): Deno.KvKey {
  return [...IDEMPOTENCY_PREFIX, merchant, idempotencyKey];
}

function invoiceRequestFingerprint(invoice: InvoiceRecord): string {
  return JSON.stringify({
    merchant: invoice.merchant,
    customerReference: invoice.customerReference,
    pricingVersionId: invoice.pricingVersionId,
    productId: invoice.productId,
    chainId: invoice.chainId,
  });
}

function invoiceByChainKey(chainId: SupportedChainId, invoiceId: string): Deno.KvKey {
  return [...INVOICES_BY_CHAIN_PREFIX, chainId, invoiceId];
}

function headKey(chainId: SupportedChainId): Deno.KvKey {
  return [...HEADS_PREFIX, chainId];
}

function eventKey(eventId: string): Deno.KvKey {
  return [...EVENTS_PREFIX, eventId];
}

function eventByInvoiceKey(invoiceId: string, type: PaymentEventType): Deno.KvKey {
  return [...EVENTS_BY_INVOICE_PREFIX, invoiceId, type];
}

function outboxKey(event: DeliveryEventRecord): Deno.KvKey {
  return [...OUTBOX_PREFIX, Date.parse(event.nextAttemptAt), event.id];
}

function cursorKey(chainId: SupportedChainId): Deno.KvKey {
  return [...CURSORS_PREFIX, chainId];
}

function chainSettingsKey(chainId: SupportedChainId): Deno.KvKey {
  return [...CHAIN_SETTINGS_PREFIX, chainId];
}

function merchantId(context: MerchantContext): string {
  return boundedText(context?.merchantId, "merchant_id", 128);
}

function normalizeDiscountStart(value: bigint): bigint {
  if (value < MIN_DISCOUNT_UNITS || value > MAX_DISCOUNT_UNITS) {
    throw new PaymentDomainError("invalid_discount_start");
  }
  return value;
}

function nextDiscount(value: bigint): bigint {
  return value === MAX_DISCOUNT_UNITS ? MIN_DISCOUNT_UNITS : value + 1n;
}

function randomDiscountStart(): bigint {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return BigInt(value % Number(MAX_DISCOUNT_UNITS)) + 1n;
}

function reservationCanBeReused(invoice: InvoiceRecord | null, now: Date): boolean {
  if (!invoice) return true;
  if (invoice.status !== "finalized" || !invoice.finalizedAt) return false;
  return Date.parse(invoice.finalizedAt) + AMOUNT_RESERVATION_REUSE_DELAY_MS <= now.getTime();
}

function decimalBigint(value: unknown, code: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new PaymentDomainError(code);
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new PaymentDomainError(code);
  }
  return BigInt(value);
}

function mergeHeads(
  chainId: SupportedChainId,
  _previous: ChainHeadRecord | null,
  evidence: VerifiedTransfer,
  updatedAt: string,
): ChainHeadRecord {
  return {
    schemaVersion: 1,
    chainId,
    latestBlock: evidence.latestBlock,
    safeBlock: evidence.safeBlock,
    finalizedBlock: evidence.finalizedBlock,
    updatedAt,
  };
}

function headAdvanced(previous: ChainHeadRecord | null, next: ChainHeadRecord): boolean {
  return !previous || previous.latestBlock !== next.latestBlock ||
    previous.safeBlock !== next.safeBlock ||
    previous.finalizedBlock !== next.finalizedBlock;
}

function maximum(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function addEventMutations(
  atomic: Deno.AtomicOperation,
  event: OutboxEventRecord,
): Deno.AtomicOperation {
  const delivery = event as DeliveryEventRecord;
  return atomic
    .set(eventKey(event.id), event)
    .set(eventByInvoiceKey(event.invoiceId, event.type), event.id)
    .set(outboxKey(delivery), event.id);
}

function signEventForDelivery(
  signer: CompactJwsSigner,
  event: OutboxEventRecord,
  now: Date,
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: PaymentEventPayload = {
    ...event.payload,
    jti: event.id,
    iat: issuedAt,
    exp: issuedAt + EVENT_TTL_SECONDS,
  };
  return signer.sign(payload as unknown as Record<string, unknown>);
}

function boundedDeliveryError(reason: unknown): string {
  const text = reason instanceof Error ? `${reason.name}:${reason.message}` : String(reason);
  return text.slice(0, 512);
}

async function expireAwaiting(
  kv: Deno.Kv,
  clock: Clock,
  invoiceEntry: Deno.KvEntryMaybe<InvoiceRecord>,
  openEntry: Deno.KvEntryMaybe<OpenInvoiceIndex>,
  openKey: Deno.KvKey,
): Promise<InvoiceRecord | null> {
  const invoice = invoiceEntry.value!;
  const timestamp = clock.now().toISOString();
  const next: InvoiceRecord = {
    ...invoice,
    status: "expired",
    expiredAt: timestamp,
    updatedAt: timestamp,
  };
  let atomic = kv.atomic().check(invoiceEntry).set(invoiceKey(invoice.id), next);
  if (openEntry.value?.invoiceId === invoice.id) {
    atomic = atomic.check(openEntry).delete(openKey);
  }
  return (await atomic.commit()).ok ? next : null;
}
