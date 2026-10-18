import type { KvKey, Kv, KvEntryMaybe, KvAtomic } from "./kv.ts";
import { confirmationMilestones, type WakeupPort, type WakeTarget } from "./wakeup.ts";
import { StaleWakeupError } from "./wakeup.ts";
import type { ChainTransferEvent } from "./chain_events.ts";
import type { ChainTransferContext } from "./chain_ingress.ts";
import { type CompactJwsSigner } from "./jws.ts";
import {
  discoverInvoicePayment,
  discoveryStateKey,
  invoiceMatchesTransfer,
  type DiscoveryOptions,
} from "./payment_discovery.ts";
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
  RpcError,
  RpcVerificationError,
  type VerifiedTransfer,
  verifyTransferBatch,
} from "./rpc.ts";
import { WorkerBudgetError } from "./worker_budget.ts";

const PREFIX: KvKey = ["uos_checkout", "v1", "payments"];
const INVOICES_PREFIX: KvKey = [...PREFIX, "invoices"];
const PAYMENTS_PREFIX: KvKey = [...PREFIX, "payment_records"];
const LOCATORS_PREFIX: KvKey = [...PREFIX, "payment_locators"];
const RESERVATIONS_PREFIX: KvKey = [...PREFIX, "amount_reservations"];
const OPEN_INVOICES_PREFIX: KvKey = [...PREFIX, "open_invoices"];
const IDEMPOTENCY_PREFIX: KvKey = [...PREFIX, "idempotency"];
const INVOICES_BY_CHAIN_PREFIX: KvKey = [...PREFIX, "invoices_by_chain"];
const HEADS_PREFIX: KvKey = [...PREFIX, "chain_heads"];
const EVENTS_PREFIX: KvKey = [...PREFIX, "events"];
const EVENTS_BY_INVOICE_PREFIX: KvKey = [...PREFIX, "events_by_invoice"];
const OUTBOX_PREFIX: KvKey = [...PREFIX, "outbox"];
const CURSORS_PREFIX: KvKey = [...PREFIX, "reconciliation_cursors"];
const CHAIN_SETTINGS_PREFIX: KvKey = [...PREFIX, "chain_settings"];

const EVENT_ISSUER = "https://checkout.ubq.fi";
const EVENT_TTL_SECONDS = 24 * 60 * 60;
const RECONCILIATION_OVERLAP_BLOCKS = 128n;
const OUTBOX_INITIAL_BACKOFF_MS = 60_000;
const OUTBOX_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const AMOUNT_RESERVATION_REUSE_DELAY_MS = RECENTLY_EXPIRED_WINDOW_MS;
const MAX_AMOUNT_RESERVATION_PROBES = 64;

export type IdGenerator = { next(): string };

export type PaymentServiceOptions = {
  kv: Kv;
  rpc: RpcClient;
  signer: CompactJwsSigner;
  clock?: Clock;
  idGenerator?: IdGenerator;
  discountStart?: () => bigint;
  discovery?: DiscoveryOptions;
  wakeups?: WakeupPort;
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
  discovery?: { found: boolean; searchedToBlock?: string };
};

function hasCurrentPaymentRecord(invoice: Pick<InvoiceRecord, "paymentId" | "status">): boolean {
  return Boolean(invoice.paymentId) && invoice.status !== "reverted";
}

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

type ClaimSnapshot = {
  invoiceEntry?: KvEntryMaybe<InvoiceRecord>;
  locatorEntry?: KvEntryMaybe<LocatorIndex>;
  paymentEntry?: KvEntryMaybe<PaymentRecord>;
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
  function verificationRpc(context?: ChainTransferContext, completionCalls = 5): RpcClient {
    return {
      async batch(chainId, calls, limits) {
        const headRetry = calls.every(({ id }) => ["latest", "safe", "finalized"].includes(id));
        if (headRetry && context && !(await context.isCurrent())) throw new StaleWakeupError();
        const budget = context?.budget ?? options.discovery?.budget;
        if (
          calls.every(({ id }) => id === "safe" || id === "finalized") &&
          budget &&
          // Fenced ingress can also read its receipt before each of the three commit phases.
          !budget.hasCapacity(completionCalls + 1 + (context ? 3 : 0))
        ) {
          return calls.map(({ id }) => ({ jsonrpc: "2.0", id, result: null }));
        }
        return rpc.batch(chainId, calls, limits);
      },
    };
  }
  return {
    publishCatalogVersion: (
      context: MerchantContext,
      pricingVersionId: unknown,
      projection: unknown,
    ) => publishCatalogVersion(kv, merchantId(context), pricingVersionId, projection, clock),
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
    processChainTransfer: (event: ChainTransferEvent, context: ChainTransferContext) =>
      processChainTransfer(event, context),
    discoverPayment: (
      invoiceId: unknown,
      search?: Pick<DiscoveryOptions, "expiryToBlock" | "isCurrent">,
    ) =>
      discoverInvoicePayment(
        {
          kv,
          rpc,
          clock,
          claim: (id, input, invoiceEntry) =>
            claimPayment(
              id,
              input,
              search?.expiryToBlock === undefined
                ? undefined
                : {
                    budget: options.discovery?.budget,
                    deadline: options.discovery?.deadline ?? Date.now() + 20_000,
                    isCurrent: search.isCurrent ?? (async () => true),
                  },
              { invoiceEntry },
            ),
          existingEvent: signedExistingEvent,
        },
        invoiceId,
        { ...options.discovery, ...search },
      ),
    refreshInvoice: (invoiceId: unknown) => refreshInvoice(invoiceId),
    expireInvoice: (invoiceId: unknown) => expireInvoice(invoiceId),
    markManualReview: (invoiceId: unknown) => markManualReview(invoiceId),
    listOutbox: (limit?: number) => listOutbox(kv, signer, clock, limit),
    getOutboxEventRecord: (eventId: unknown) => getOutboxEventRecord(kv, eventId),
    getOutboxEvent: async (eventId: unknown): Promise<SignedOutboxEvent | null> => {
      const event = await getOutboxEventRecord(kv, eventId);
      if (!event || event.deliveredAt || Date.parse(event.nextAttemptAt) > clock.now().getTime())
        return null;
      return { ...event, compactJws: await signEventForDelivery(signer, event, clock.now()) };
    },
    markOutboxDelivered: (eventId: unknown) =>
      markOutboxDelivered(kv, eventId, clock, options.wakeups),
    markOutboxFailed: (eventId: unknown, reason: unknown) =>
      markOutboxFailed(kv, eventId, reason, clock, options.wakeups),
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

  async function commitInvoice(
    atomic: KvAtomic,
    invoice: InvoiceRecord,
    event?: OutboxEventRecord,
    evidence?: VerifiedTransfer,
    context?: ChainTransferContext,
  ) {
    if (context?.fence) atomic.check(context.fence);
    if (!options.wakeups) {
      if (context && !(await context.isCurrent())) throw new StaleWakeupError();
      return atomic.commit();
    }
    let target: WakeTarget = { kind: "invoice", id: invoice.id, dueAt: null, reason: "cancel" };
    if (invoice.status === "awaiting_payment") {
      target = { ...target, dueAt: Date.parse(invoice.expiresAt), reason: "expiry" };
    } else if (
      invoice.paymentId &&
      !invoice.requiresManualReview &&
      ["confirming", "provisionally_paid", "settled"].includes(invoice.status)
    ) {
      if (!evidence) throw new PaymentDomainError("confirmation_evidence_required");
      const times = confirmationMilestones(invoice.chainId, evidence.blockTimestamp.getTime());
      const expected = invoice.status === "settled" ? times.finalizedAt : times.safeAt;
      target = {
        ...target,
        dueAt: Math.max(clock.now().getTime(), expected),
        reason: "confirmation",
      };
    }
    return options.wakeups.commit(
      atomic,
      [
        target,
        ...(event
          ? [
              {
                kind: "delivery" as const,
                id: event.id,
                dueAt: Date.parse((event as DeliveryEventRecord).nextAttemptAt),
                reason: "delivery" as const,
              },
            ]
          : []),
      ],
      context?.isCurrent,
    );
  }

  async function processChainTransfer(
    event: ChainTransferEvent,
    context: ChainTransferContext,
  ): Promise<{ terminal: boolean; disposition: string; invoiceId?: string }> {
    const ignored = (invoiceId?: string) => ({ terminal: true, disposition: "ignored", invoiceId });
    const deferred = (invoiceId?: string) => ({
      terminal: false,
      disposition: "deferred",
      invoiceId,
    });
    const room = (calls: number) =>
      Date.now() < context.deadline && (context.budget?.hasCapacity(calls) ?? true);
    if (!room(3)) return deferred();
    const locatorKey = paymentLocatorKey(event.chainId, event.transactionHash, event.logIndex);
    const [reservation, locator] = await kv.getMany<[AmountReservation, LocatorIndex]>([
      amountReservationKey(
        event.chainId,
        event.tokenAddress.toLowerCase(),
        event.recipientAddress.toLowerCase(),
        event.amountUnits,
      ),
      locatorKey,
    ]);
    const id = locator.value?.invoiceId ?? reservation.value?.invoiceId;
    if (!id) return ignored();
    const invoiceEntry = await kv.get<InvoiceRecord>(invoiceKey(id));
    const invoice = invoiceEntry.value;
    if (
      !invoice ||
      invoice.chainId !== event.chainId ||
      invoice.minimumBlock > event.blockNumber ||
      invoice.tokenAddress.toLowerCase() !== event.tokenAddress.toLowerCase() ||
      invoice.treasuryAddress.toLowerCase() !== event.recipientAddress.toLowerCase() ||
      invoice.paidAmountUnits !== event.amountUnits
    )
      return ignored(id);
    const paymentEntry = invoice.paymentId
      ? await kv.get<PaymentRecord>(paymentKey(invoice.paymentId))
      : undefined;
    const payment = paymentEntry?.value;
    const snapshot: ClaimSnapshot = { invoiceEntry, locatorEntry: locator, paymentEntry };
    const sameTransaction = payment?.transactionHash === event.transactionHash;
    const sameInclusion =
      sameTransaction &&
      payment?.logIndex === event.logIndex &&
      payment.blockNumber === event.blockNumber &&
      payment.blockHash === event.blockHash;
    if (
      event.removed &&
      (!sameInclusion || locator.value?.paymentId !== invoice.paymentId || locator.value?.duplicate)
    )
      return ignored(id);
    if (!event.removed && hasCurrentPaymentRecord(invoice) && sameInclusion) return ignored(id);
    if (payment && !sameTransaction) return ignored(id);
    const mutationCalls =
      event.removed || (hasCurrentPaymentRecord(invoice) && sameTransaction && !sameInclusion)
        ? 12
        : invoice.status === "reverted" && invoice.paymentId
          ? 11
          : 10;
    if (!room(mutationCalls) || !(await context.isCurrent())) return deferred(id);
    try {
      if (
        event.removed ||
        (hasCurrentPaymentRecord(invoice) && sameTransaction && !sameInclusion)
      ) {
        let uncertain = false;
        const result = await refreshInvoice(id, context, snapshot, () => {
          uncertain = true;
        });
        if (uncertain) return deferred(id);
        // Reorg and reinclusion are separate viable receipt phases under the Free budget.
        if (!event.removed && (!result.invoice.paymentId || result.invoice.status === "reverted"))
          return deferred(id);
        return {
          terminal: true,
          disposition:
            result.invoice.status === "reverted" || !result.invoice.paymentId
              ? "reverted"
              : "refreshed",
          invoiceId: id,
        };
      }
      if (
        !invoiceMatchesTransfer(invoice, event) ||
        ["manual_review", "late_payment", "finalized"].includes(invoice.status)
      )
        return ignored(id);
      const result = await claimPayment(
        id,
        {
          transactionHash: event.transactionHash,
          logIndex: event.logIndex.toString(),
          observedBlockNumber: event.blockNumber.toString(),
          observedBlockHash: event.blockHash,
        },
        context,
        snapshot,
      );
      return {
        terminal: hasCurrentPaymentRecord(result.invoice),
        disposition: "claimed",
        invoiceId: id,
      };
    } catch (error) {
      if (
        error instanceof WorkerBudgetError ||
        error instanceof RpcError ||
        error instanceof RpcVerificationError ||
        error instanceof StaleWakeupError
      )
        return deferred(id);
      if (
        error instanceof PaymentDomainError &&
        ["payment_locator_already_claimed", "payment_before_minimum_block"].includes(error.code)
      )
        return ignored(id);
      throw error;
    }
  }

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
    )
      throw new PaymentDomainError("invalid_treasury_address");
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
    const chainId =
      input.chainId === undefined ? DEFAULT_CHAIN_ID : supportedChainId(input.chainId);
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
          await expireAwaiting(kv, clock, existing, open, openKey, options.wakeups);
          continue;
        }
        if (open.value.requestFingerprint !== requestFingerprint) {
          throw new PaymentDomainError("open_invoice_conflict");
        }
        const committed = await kv
          .atomic()
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
      const product = version.projection.products.find(
        (candidate) => candidate.productId === productId,
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
        let reservedInvoice: KvEntryMaybe<InvoiceRecord> | null = null;
        if (reservation.value !== null) {
          if (typeof reservation.value.invoiceId !== "string") {
            candidate = nextDiscount(candidate);
            continue;
          }
          reservedInvoice = await kv.get<InvoiceRecord>(invoiceKey(reservation.value.invoiceId));
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
        let atomic = kv
          .atomic()
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
        const committed = await commitInvoice(atomic, record);
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
    context?: ChainTransferContext,
    snapshot?: ClaimSnapshot,
  ): Promise<ClaimPaymentResult> {
    const invoiceId = boundedText(invoiceIdInput, "invoice_id", 128);
    const invoiceEntry =
      snapshot?.invoiceEntry ?? (await kv.get<InvoiceRecord>(invoiceKey(invoiceId)));
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
    const observedBlockHash =
      input.observedBlockHash === undefined
        ? undefined
        : boundedText(input.observedBlockHash, "observed_block_hash", 66);
    const locatorKey = paymentLocatorKey(invoice.chainId, transactionHash, logIndex);
    const existingLocator = snapshot?.locatorEntry ?? (await kv.get<LocatorIndex>(locatorKey));
    if (existingLocator.value && existingLocator.value.invoiceId !== invoice.id) {
      throw new PaymentDomainError("payment_locator_already_claimed");
    }
    if (invoice.status === "reverted" && invoice.paymentId) {
      const payment =
        snapshot?.paymentEntry ?? (await kv.get<PaymentRecord>(paymentKey(invoice.paymentId)));
      if (payment.value?.transactionHash === transactionHash) {
        return reincludeRevertedPayment(
          invoiceEntry,
          existingLocator,
          transactionHash,
          logIndex,
          observedBlockNumber,
          observedBlockHash,
          context,
          payment,
        );
      }
    }
    if (existingLocator.value) {
      const refreshed = await refreshInvoice(invoice.id, context);
      if (refreshed.eventJws) return refreshed;
      return { ...refreshed, eventJws: await signedExistingEvent(refreshed.invoice) };
    }

    const evidence = await verifyTransferBatch(verificationRpc(context), invoice.chainId, {
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
      return recordDuplicatePayment(invoiceEntry, locatorKey, existingLocator, evidence, context);
    }
    return recordPrimaryPayment(invoiceEntry, locatorKey, existingLocator, evidence, context);
  }

  async function reincludeRevertedPayment(
    invoiceEntry: KvEntryMaybe<InvoiceRecord>,
    locatorEntry: KvEntryMaybe<LocatorIndex>,
    transactionHash: string,
    logIndex: number,
    observedBlockNumber: bigint,
    observedBlockHash: string | undefined,
    context?: ChainTransferContext,
    cachedPayment?: KvEntryMaybe<PaymentRecord>,
  ): Promise<ClaimPaymentResult> {
    const invoice = invoiceEntry.value!;
    if (!invoice.paymentId) throw new PaymentDomainError("payment_record_not_found");
    const paymentEntry =
      cachedPayment ?? (await kv.get<PaymentRecord>(paymentKey(invoice.paymentId)));
    const payment = paymentEntry.value;
    if (!payment || payment.transactionHash !== transactionHash)
      throw new PaymentDomainError("payment_record_not_found");
    const locatorChanged = payment.logIndex !== logIndex;
    if (locatorChanged && locatorEntry.value)
      throw new PaymentDomainError("payment_locator_already_claimed");
    const previousLocator = locatorChanged
      ? await kv.get<LocatorIndex>(
          paymentLocatorKey(invoice.chainId, payment.transactionHash, payment.logIndex),
        )
      : locatorEntry;
    if (
      previousLocator.value?.invoiceId !== invoice.id ||
      previousLocator.value?.paymentId !== invoice.paymentId
    ) {
      throw new PaymentDomainError("payment_record_not_found");
    }
    const evidence = await verifyTransferBatch(verificationRpc(context), invoice.chainId, {
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
      status: "confirming",
      acceptedAt: undefined,
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
      phase: "confirming",
      acceptedAt: undefined,
      settledAt: undefined,
      finalizedAt: undefined,
      revertedAt: undefined,
      updatedAt: timestamp,
    };
    let atomic = kv
      .atomic()
      .check(invoiceEntry)
      .check(paymentEntry)
      .check(locatorEntry)
      .check(headsEntry)
      .check(openEntry)
      .set(invoiceKey(invoice.id), nextInvoice)
      .set(paymentKey(nextPayment.id), nextPayment)
      .delete(discoveryStateKey(invoice.id))
      .set(locatorEntry.key, {
        invoiceId: invoice.id,
        paymentId: invoice.paymentId,
        duplicate: false,
      } satisfies LocatorIndex)
      .set(headKey(invoice.chainId), heads)
      .set(invoiceByChainKey(invoice.chainId, invoice.id), invoice.id);
    if (locatorChanged) atomic = atomic.check(previousLocator).delete(previousLocator.key);
    if (openEntry.value === null) {
      atomic = atomic.set(openKey, {
        invoiceId: invoice.id,
        requestFingerprint: invoiceRequestFingerprint(invoice),
      } satisfies OpenInvoiceIndex);
    }
    if (!(await commitInvoice(atomic, nextInvoice, undefined, evidence, context)).ok) {
      if (context) throw new StaleWakeupError();
      return claimPayment(
        invoice.id,
        {
          transactionHash,
          logIndex: String(logIndex),
          observedBlockNumber: observedBlockNumber.toString(),
          observedBlockHash,
        },
        context,
      );
    }
    return { invoice: invoiceJson(nextInvoice) };
  }

  async function recordPrimaryPayment(
    invoiceEntry: KvEntryMaybe<InvoiceRecord>,
    locatorKey: KvKey,
    locatorEntry: KvEntryMaybe<LocatorIndex>,
    evidence: VerifiedTransfer,
    context?: ChainTransferContext,
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
    const conflictingOpen =
      !includedLate && openEntry.value !== null && openEntry.value.invoiceId !== invoice.id;
    const nextInvoice: InvoiceRecord = {
      ...invoice,
      paymentId,
      status: includedLate ? "late_payment" : conflictingOpen ? "manual_review" : "confirming",
      updatedAt: timestamp,
    };
    payment.phase = includedLate ? "late" : conflictingOpen ? "duplicate" : "confirming";

    let atomic = kv
      .atomic()
      .check(invoiceEntry)
      .check(locatorEntry)
      .check(headsEntry)
      .check(openEntry)
      .set(invoiceKey(invoice.id), nextInvoice)
      .set(paymentKey(paymentId), payment)
      .delete(discoveryStateKey(invoice.id))
      .set(locatorKey, {
        invoiceId: invoice.id,
        paymentId,
        duplicate: false,
      } satisfies LocatorIndex)
      .set(headKey(invoice.chainId), heads);
    if (includedLate && openEntry.value?.invoiceId === invoice.id) {
      atomic = atomic.delete(openKey);
    } else if (!includedLate && !conflictingOpen && openEntry.value === null) {
      atomic = atomic.set(openKey, {
        invoiceId: invoice.id,
        requestFingerprint: invoiceRequestFingerprint(invoice),
      } satisfies OpenInvoiceIndex);
    }
    if (includedLate || conflictingOpen) {
      atomic = atomic.delete(invoiceByChainKey(invoice.chainId, invoice.id));
    }
    const committed = await commitInvoice(atomic, nextInvoice, undefined, evidence, context);
    if (!committed.ok) {
      if (context) throw new StaleWakeupError();
      return claimPayment(
        invoice.id,
        {
          transactionHash: evidence.transactionHash,
          logIndex: String(evidence.logIndex),
          observedBlockNumber: evidence.blockNumber.toString(),
          observedBlockHash: evidence.blockHash,
        },
        context,
      );
    }
    return { invoice: invoiceJson(nextInvoice) };
  }

  async function recordDuplicatePayment(
    invoiceEntry: KvEntryMaybe<InvoiceRecord>,
    locatorKey: KvKey,
    locatorEntry: KvEntryMaybe<LocatorIndex>,
    evidence: VerifiedTransfer,
    context?: ChainTransferContext,
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
    let atomic = kv
      .atomic()
      .check(invoiceEntry)
      .check(locatorEntry)
      .set(invoiceKey(invoice.id), nextInvoice)
      .set(paymentKey(paymentId), payment)
      .set(locatorKey, {
        invoiceId: invoice.id,
        paymentId,
        duplicate: true,
      } satisfies LocatorIndex);
    if (openEntry.value?.invoiceId === invoice.id) atomic = atomic.check(openEntry).delete(openKey);
    const committed = await commitInvoice(atomic, nextInvoice, undefined, undefined, context);
    if (!committed.ok) throw new PaymentDomainError("payment_claim_conflict");
    return { invoice: invoiceJson(nextInvoice) };
  }

  async function refreshInvoice(
    invoiceIdInput: unknown,
    context?: ChainTransferContext,
    snapshot?: ClaimSnapshot,
    inconclusive?: () => void,
  ): Promise<ClaimPaymentResult> {
    const invoiceId = boundedText(invoiceIdInput, "invoice_id", 128);
    const invoiceEntry =
      snapshot?.invoiceEntry ?? (await kv.get<InvoiceRecord>(invoiceKey(invoiceId)));
    if (!invoiceEntry.value) throw new PaymentDomainError("invoice_not_found");
    const invoice = invoiceEntry.value;
    if (!invoice.paymentId) {
      return { invoice: await expireInvoice(invoice.id) };
    }
    const paymentEntry =
      snapshot?.paymentEntry ?? (await kv.get<PaymentRecord>(paymentKey(invoice.paymentId)));
    if (!paymentEntry.value) throw new PaymentDomainError("payment_record_not_found");
    const payment = paymentEntry.value;

    let evidence: VerifiedTransfer;
    try {
      evidence = await verifyTransferBatch(verificationRpc(context, 9), invoice.chainId, {
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
      if (!error.canonicalContradiction) {
        inconclusive?.();
        return { invoice: invoiceJson(invoice) };
      }
      return handleReorg(invoiceEntry, paymentEntry, error.code, context);
    }

    const timestamp = clock.now().toISOString();
    const headsEntry = await kv.get<ChainHeadRecord>(headKey(invoice.chainId));
    const heads = mergeHeads(invoice.chainId, headsEntry.value, evidence, timestamp);
    let nextInvoice = invoice;
    let nextPayment = payment;
    let event: OutboxEventRecord | undefined;

    if (
      invoice.status === "confirming" &&
      ((heads.safeBlock !== null && heads.safeBlock >= payment.blockNumber) ||
        (heads.finalizedBlock !== null && heads.finalizedBlock >= payment.blockNumber))
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
      invoice.status === "provisionally_paid" &&
      ((heads.safeBlock !== null && heads.safeBlock >= payment.blockNumber) ||
        (heads.finalizedBlock !== null && heads.finalizedBlock >= payment.blockNumber))
    ) {
      nextInvoice = { ...invoice, status: "settled", settledAt: timestamp, updatedAt: timestamp };
      nextPayment = { ...payment, phase: "settled", settledAt: timestamp, updatedAt: timestamp };
      event = await makeEvent("payment.settled.v1", nextInvoice, nextPayment, timestamp);
    } else if (
      invoice.status === "settled" &&
      heads.finalizedBlock !== null &&
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

    if (nextInvoice === invoice) {
      // Head movement alone neither replaces the payment generation nor rearms a spent milestone.
      const atomic = kv
        .atomic()
        .check(invoiceEntry, paymentEntry, headsEntry)
        .set(headKey(invoice.chainId), heads);
      if (context?.fence) atomic.check(context.fence);
      if (context && !(await context.isCurrent())) throw new StaleWakeupError();
      if (!(await atomic.commit()).ok) {
        if (context) throw new StaleWakeupError();
        return refreshInvoice(invoice.id, context, undefined, inconclusive);
      }
      return { invoice: invoiceJson(invoice) };
    }

    const openKey = openInvoiceKey(
      invoice.merchant,
      invoice.customerReference,
      invoice.productId,
      invoice.chainId,
    );
    const openEntry = await kv.get<OpenInvoiceIndex>(openKey);
    let atomic = kv
      .atomic()
      .check(invoiceEntry)
      .check(paymentEntry)
      .check(headsEntry)
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
    const committed = await commitInvoice(atomic, nextInvoice, event, evidence, context);
    if (!committed.ok) {
      if (context) throw new StaleWakeupError();
      return refreshInvoice(invoice.id, context, undefined, inconclusive);
    }
    return { invoice: invoiceJson(nextInvoice), eventJws: event?.compactJws };
  }

  async function handleReorg(
    invoiceEntry: KvEntryMaybe<InvoiceRecord>,
    paymentEntry: KvEntryMaybe<PaymentRecord>,
    reason: string,
    context?: ChainTransferContext,
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
      let atomic = kv
        .atomic()
        .check(invoiceEntry)
        .check(paymentEntry)
        .check(locatorEntry)
        .set(invoiceKey(invoice.id), nextInvoice)
        .delete(discoveryStateKey(invoice.id))
        .delete(paymentKey(payment.id))
        .delete(locatorKey);
      if (expired && openEntry.value?.invoiceId === invoice.id) {
        atomic = atomic.check(openEntry).delete(openKey);
      }
      const committed = await commitInvoice(atomic, nextInvoice, undefined, undefined, context);
      if (!committed.ok) {
        if (context) throw new StaleWakeupError();
        return refreshInvoice(invoice.id, context);
      }
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
      kv
        .atomic()
        .check(invoiceEntry)
        .check(paymentEntry)
        .set(invoiceKey(invoice.id), nextInvoice)
        .set(paymentKey(payment.id), nextPayment)
        .delete(discoveryStateKey(invoice.id))
        .set(invoiceByChainKey(invoice.chainId, invoice.id), invoice.id),
      event,
    );
    if (openEntry.value?.invoiceId === invoice.id) atomic = atomic.check(openEntry).delete(openKey);
    const committed = await commitInvoice(atomic, nextInvoice, event, undefined, context);
    if (!committed.ok) {
      if (context) throw new StaleWakeupError();
      return refreshInvoice(invoice.id, context);
    }
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
      )
        return invoiceJson(invoice);
      const openKey = openInvoiceKey(
        invoice.merchant,
        invoice.customerReference,
        invoice.productId,
        invoice.chainId,
      );
      const openEntry = await kv.get<OpenInvoiceIndex>(openKey);
      const nextInvoice = await expireAwaiting(
        kv,
        clock,
        invoiceEntry,
        openEntry,
        openKey,
        options.wakeups,
      );
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
      if ((await commitInvoice(atomic, next)).ok) return invoiceJson(next);
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

  async function signedExistingEvent(
    invoice: InvoiceRecord | InvoiceJson,
  ): Promise<string | undefined> {
    if (!invoice.paymentId) return undefined;
    const types: PaymentEventType[] =
      invoice.status === "reverted"
        ? ["payment.reverted.v1"]
        : invoice.status === "settled" || invoice.status === "finalized"
          ? ["payment.settled.v1", "payment.accepted.v1"]
          : invoice.status === "provisionally_paid"
            ? ["payment.accepted.v1"]
            : [];
    for (const type of types) {
      const eventId = (await kv.get<string>(eventByInvoiceKey(invoice.id, type))).value;
      if (!eventId) continue;
      const event = (await kv.get<DeliveryEventRecord>(eventKey(eventId))).value;
      const occurredAt =
        type === "payment.reverted.v1"
          ? invoice.revertedAt
          : type === "payment.settled.v1"
            ? invoice.settledAt
            : invoice.acceptedAt;
      if (event?.paymentId === invoice.paymentId && event.createdAt === occurredAt) {
        return signEventForDelivery(signer, event, clock.now());
      }
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
      (minimum, invoice) => (invoice.minimumBlock < minimum ? invoice.minimumBlock : minimum),
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
    const toBlock =
      requestedToBlock ??
      observedHeads!.safeBlock ??
      observedHeads!.finalizedBlock ??
      observedHeads!.latestBlock;
    const tokenAddress = CHAIN_CONFIGURATIONS[chainId].tokenAddress;
    return reconcileChainRange(chainId, toBlock, async (watch) => {
      if (watch.invoices.length === 0) return;
      const treasuries = [...new Set(watch.invoices.map((invoice) => invoice.treasuryAddress))];
      const logs = (
        await Promise.all(
          treasuries.map((treasuryAddress) =>
            discoverTransferLogs(
              rpc,
              chainId,
              tokenAddress,
              treasuryAddress,
              watch.fromBlock,
              watch.toBlock,
            ),
          ),
        )
      ).flat();
      for (const log of logs) {
        const invoice = watch.invoices.find((candidate) => invoiceMatchesTransfer(candidate, log));
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
          )
            continue;
          throw error;
        }
      }
      for (const watched of watch.invoices) {
        const current = await invoiceRecord(kv, watched.id);
        if (
          current.paymentId &&
          current.status !== "late_payment" &&
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
  kv: Kv,
  chainId: SupportedChainId,
  clock: Clock = systemClock,
): Promise<InvoiceRecord[]> {
  const invoices: InvoiceRecord[] = [];
  const cutoff = clock.now().getTime() - RECENTLY_EXPIRED_WINDOW_MS;
  for await (const entry of kv.list<string>({ prefix: [...INVOICES_BY_CHAIN_PREFIX, chainId] })) {
    const invoice = (await kv.get<InvoiceRecord>(invoiceKey(entry.value))).value;
    if (!invoice) {
      await kv.delete(entry.key);
      continue;
    }
    if (
      isOpenInvoiceStatus(invoice.status) ||
      invoice.status === "confirming" ||
      invoice.status === "reverted" ||
      (invoice.status === "expired" && Date.parse(invoice.expiredAt ?? invoice.updatedAt) >= cutoff)
    ) {
      invoices.push(invoice);
    } else {
      await kv.delete(invoiceByChainKey(chainId, invoice.id));
    }
  }
  return invoices.sort((a, b) => (a.minimumBlock < b.minimumBlock ? -1 : a.id.localeCompare(b.id)));
}

export async function listOutbox(
  kv: Kv,
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
    start: [...OUTBOX_PREFIX, 0] as KvKey,
    end: [...OUTBOX_PREFIX, now.getTime(), "\uffff"] as KvKey,
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
  kv: Kv,
  eventIdInput: unknown,
  clock: Clock = systemClock,
  wakeups?: WakeupPort,
): Promise<OutboxEventRecord> {
  const eventId = boundedText(eventIdInput, "event_id", 128);
  while (true) {
    const entry = await kv.get<DeliveryEventRecord>(eventKey(eventId));
    if (!entry.value) throw new PaymentDomainError("event_not_found");
    if (entry.value.deliveredAt) return entry.value;
    const next = { ...entry.value, deliveredAt: clock.now().toISOString() };
    const atomic = kv
      .atomic()
      .check(entry)
      .set(eventKey(eventId), next)
      .delete(outboxKey(entry.value));
    if (
      (
        await (wakeups?.commit(atomic, [
          { kind: "delivery", id: eventId, dueAt: null, reason: "cancel" },
        ]) ?? atomic.commit())
      ).ok
    )
      return next;
  }
}

export async function markOutboxFailed(
  kv: Kv,
  eventIdInput: unknown,
  reason: unknown,
  clock: Clock = systemClock,
  wakeups?: WakeupPort,
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
    const atomic = kv
      .atomic()
      .check(entry)
      .set(eventKey(eventId), next)
      .delete(outboxKey(entry.value))
      .set(outboxKey(next), eventId);
    const committed = await (wakeups?.commit(atomic, [
      { kind: "delivery", id: eventId, dueAt: Date.parse(next.nextAttemptAt), reason: "delivery" },
    ]) ?? atomic.commit());
    if (committed.ok) return next;
  }
}

export async function getOutboxEventRecord(
  kv: Kv,
  eventIdInput: unknown,
): Promise<DeliveryEventRecord | null> {
  return (await kv.get<DeliveryEventRecord>(eventKey(boundedText(eventIdInput, "event_id", 128))))
    .value;
}

export async function invoiceRecord(kv: Kv, invoiceIdInput: unknown): Promise<InvoiceRecord> {
  const invoiceId = boundedText(invoiceIdInput, "invoice_id", 128);
  const invoice = (await kv.get<InvoiceRecord>(invoiceKey(invoiceId))).value;
  if (!invoice) throw new PaymentDomainError("invoice_not_found");
  return invoice;
}

export async function listInvoices(kv: Kv, limit = 50): Promise<InvoiceJson[]> {
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
  kv: Kv,
  chainId: SupportedChainId,
): Promise<PaymentChainSettings> {
  const settings = (await kv.get<PaymentChainSettings>(chainSettingsKey(chainId))).value;
  if (!settings) throw new PaymentDomainError("chain_not_configured");
  return settings;
}

export async function listChainConfigurations(kv: Kv): Promise<PaymentChainConfigurationJson[]> {
  const entries = await Promise.all(
    ([1, 10, 8453] as const).map((chainId) =>
      kv.get<PaymentChainSettings>(chainSettingsKey(chainId)),
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

export function invoiceKey(invoiceId: string): KvKey {
  return [...INVOICES_PREFIX, invoiceId];
}

export function paymentKey(paymentId: string): KvKey {
  return [...PAYMENTS_PREFIX, paymentId];
}

function paymentLocatorKey(
  chainId: SupportedChainId,
  transactionHash: string,
  logIndex: number,
): KvKey {
  return [...LOCATORS_PREFIX, chainId, transactionHash, logIndex];
}

function amountReservationKey(
  chainId: SupportedChainId,
  tokenAddress: string,
  treasuryAddress: string,
  paidAmountUnits: bigint,
): KvKey {
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
): KvKey {
  return [...OPEN_INVOICES_PREFIX, merchant, customerReference, productId, chainId];
}

function idempotencyIndexKey(merchant: string, idempotencyKey: string): KvKey {
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

function invoiceByChainKey(chainId: SupportedChainId, invoiceId: string): KvKey {
  return [...INVOICES_BY_CHAIN_PREFIX, chainId, invoiceId];
}

function headKey(chainId: SupportedChainId): KvKey {
  return [...HEADS_PREFIX, chainId];
}

function eventKey(eventId: string): KvKey {
  return [...EVENTS_PREFIX, eventId];
}

function eventByInvoiceKey(invoiceId: string, type: PaymentEventType): KvKey {
  return [...EVENTS_BY_INVOICE_PREFIX, invoiceId, type];
}

function outboxKey(event: DeliveryEventRecord): KvKey {
  return [...OUTBOX_PREFIX, Date.parse(event.nextAttemptAt), event.id];
}

function cursorKey(chainId: SupportedChainId): KvKey {
  return [...CURSORS_PREFIX, chainId];
}

function chainSettingsKey(chainId: SupportedChainId): KvKey {
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
  return (
    !previous ||
    previous.latestBlock !== next.latestBlock ||
    previous.safeBlock !== next.safeBlock ||
    previous.finalizedBlock !== next.finalizedBlock
  );
}

function maximum(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function addEventMutations(atomic: KvAtomic, event: OutboxEventRecord): KvAtomic {
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
  kv: Kv,
  clock: Clock,
  invoiceEntry: KvEntryMaybe<InvoiceRecord>,
  openEntry: KvEntryMaybe<OpenInvoiceIndex>,
  openKey: KvKey,
  wakeups?: WakeupPort,
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
  return (
    await (wakeups?.commit(atomic, [
      { kind: "invoice", id: invoice.id, dueAt: Date.parse(invoice.expiresAt), reason: "expiry" },
    ]) ?? atomic.commit())
  ).ok
    ? next
    : null;
}
