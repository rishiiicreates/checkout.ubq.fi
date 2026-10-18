export const SUPPORTED_CHAIN_IDS = [1, 10, 8453] as const;

export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export const DEFAULT_CHAIN_ID: SupportedChainId = 8453;
export const USDC_DECIMALS = 6 as const;
export const TOKEN_SYMBOL = "USDC" as const;
export const INVOICE_TTL_MS = 60 * 60 * 1000;
export const RECENTLY_EXPIRED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MINIMUM_PRODUCT_PRICE_CENTS = 100;
export const MAX_DISCOUNT_UNITS = 999_999n;
export const MIN_DISCOUNT_UNITS = 1n;

export type ChainConfiguration = {
  chainId: SupportedChainId;
  networkName: string;
  tokenAddress: string;
  tokenSymbol: typeof TOKEN_SYMBOL;
  tokenDecimals: typeof USDC_DECIMALS;
};

// Circle-native USDC contracts. Bridged USDC variants are intentionally unsupported.
export const CHAIN_CONFIGURATIONS: Readonly<Record<SupportedChainId, ChainConfiguration>> = {
  1: {
    chainId: 1,
    networkName: "Ethereum",
    tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    tokenSymbol: TOKEN_SYMBOL,
    tokenDecimals: USDC_DECIMALS,
  },
  10: {
    chainId: 10,
    networkName: "Optimism",
    tokenAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    tokenSymbol: TOKEN_SYMBOL,
    tokenDecimals: USDC_DECIMALS,
  },
  8453: {
    chainId: 8453,
    networkName: "Base",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenSymbol: TOKEN_SYMBOL,
    tokenDecimals: USDC_DECIMALS,
  },
};

export type TreasuryByChain = Readonly<Record<SupportedChainId, string>>;

export type PaymentChainSettings = {
  schemaVersion: 1;
  chainId: SupportedChainId;
  enabled: boolean;
  treasuryAddress: string;
  revision: number;
  updatedAt: string;
};

export type PaymentChainConfigurationJson = ChainConfiguration & {
  enabled: boolean;
  treasuryAddress: string | null;
  revision: number;
  updatedAt: string | null;
};

export type ProductKind = "credit_pack" | "prepaid_plan";

export type CatalogProduct = {
  productId: string;
  label: string;
  kind: ProductKind;
  priceCents: number;
  enabled: boolean;
};

export type CatalogProjection = {
  currency: "USD";
  products: CatalogProduct[];
};

export type CatalogVersionRecord = {
  schemaVersion: 1;
  pricingVersionId: string;
  digest: string;
  projection: CatalogProjection;
  canonicalJson: string;
  createdAt: string;
};

export type InvoiceStatus =
  | "awaiting_payment"
  | "confirming"
  | "provisionally_paid"
  | "settled"
  | "finalized"
  | "expired"
  | "late_payment"
  | "manual_review"
  | "reverted";

export type InvoiceRecord = {
  schemaVersion: 1;
  id: string;
  merchant: string;
  idempotencyKey: string;
  customerReference: string;
  pricingVersionId: string;
  catalogDigest: string;
  productId: string;
  productKind: ProductKind;
  chainId: SupportedChainId;
  networkName: string;
  tokenAddress: string;
  tokenSymbol: typeof TOKEN_SYMBOL;
  tokenDecimals: typeof USDC_DECIMALS;
  treasuryAddress: string;
  listAmountUnits: bigint;
  paidAmountUnits: bigint;
  discountUnits: bigint;
  minimumBlock: bigint;
  status: InvoiceStatus;
  paymentId?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  expiredAt?: string;
  acceptedAt?: string;
  settledAt?: string;
  finalizedAt?: string;
  revertedAt?: string;
  requiresManualReview?: boolean;
};

export type PaymentPhase =
  "confirming" | "accepted" | "settled" | "finalized" | "late" | "duplicate" | "reverted";

export type PaymentRecord = {
  schemaVersion: 1;
  id: string;
  invoiceId: string;
  chainId: SupportedChainId;
  transactionHash: string;
  logIndex: number;
  payer: string;
  tokenAddress: string;
  treasuryAddress: string;
  amountUnits: bigint;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: string;
  phase: PaymentPhase;
  firstObservedAt: string;
  updatedAt: string;
  acceptedAt?: string;
  settledAt?: string;
  finalizedAt?: string;
  revertedAt?: string;
};

export type ChainHeadRecord = {
  schemaVersion: 1;
  chainId: SupportedChainId;
  latestBlock: bigint;
  safeBlock: bigint | null;
  finalizedBlock: bigint | null;
  updatedAt: string;
};

export type PaymentEventType = "payment.accepted.v1" | "payment.settled.v1" | "payment.reverted.v1";

export type PaymentEventPayload = {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  type: PaymentEventType;
  occurredAt: string;
  merchantId: string;
  customerReference: string;
  invoiceId: string;
  productId: string;
  pricingVersionId: string;
  catalogDigest: string;
  chainId: SupportedChainId;
  tokenAddress: string;
  tokenDecimals: typeof USDC_DECIMALS;
  treasuryAddress: string;
  listAmountUnits: string;
  paidAmountUnits: string;
  discountUnits: string;
  txHash: string;
  logIndex: string;
  blockNumber: string;
  blockHash: string;
  payer: string;
  includedAt: string;
  reason?: string;
};

export type OutboxEventRecord = {
  schemaVersion: 1;
  id: string;
  invoiceId: string;
  paymentId: string;
  type: PaymentEventType;
  payload: PaymentEventPayload;
  compactJws: string;
  createdAt: string;
  deliveredAt?: string;
};

export type InvoiceJson = Omit<
  InvoiceRecord,
  | "schemaVersion"
  | "merchant"
  | "customerReference"
  | "idempotencyKey"
  | "listAmountUnits"
  | "paidAmountUnits"
  | "discountUnits"
  | "minimumBlock"
> & {
  listAmountUnits: string;
  paidAmountUnits: string;
  discountUnits: string;
  minimumBlock: string;
};

export function invoiceJson(invoice: InvoiceRecord): InvoiceJson {
  const {
    schemaVersion: _schemaVersion,
    merchant: _merchant,
    customerReference: _customerReference,
    idempotencyKey: _idempotencyKey,
    listAmountUnits,
    paidAmountUnits,
    discountUnits,
    minimumBlock,
    ...publicFields
  } = invoice;
  return {
    ...publicFields,
    listAmountUnits: listAmountUnits.toString(),
    paidAmountUnits: paidAmountUnits.toString(),
    discountUnits: discountUnits.toString(),
    minimumBlock: minimumBlock.toString(),
  };
}

export class PaymentDomainError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "PaymentDomainError";
  }
}

export function supportedChainId(value: unknown): SupportedChainId {
  if (value === 1 || value === 10 || value === 8453) return value;
  throw new PaymentDomainError("unsupported_chain");
}

export function validateTreasuryByChain(input: TreasuryByChain): TreasuryByChain {
  const keys = Object.keys(input).sort();
  const expected = SUPPORTED_CHAIN_IDS.map(String).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new PaymentDomainError("treasury_required_for_every_supported_chain");
  }
  return Object.freeze({
    1: normalizeAddress(input[1]),
    10: normalizeAddress(input[10]),
    8453: normalizeAddress(input[8453]),
  });
}

export function normalizeAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new PaymentDomainError("invalid_evm_address");
  }
  return value.toLowerCase();
}

export function normalizeTransactionHash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new PaymentDomainError("invalid_transaction_hash");
  }
  return value.toLowerCase();
}

export function boundedText(value: unknown, field: string, maximumLength = 256): string {
  if (typeof value !== "string") throw new PaymentDomainError(`${field}_required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new PaymentDomainError(`invalid_${field}`);
  }
  return normalized;
}

export function isOpenInvoiceStatus(status: InvoiceStatus): boolean {
  return (
    status === "awaiting_payment" ||
    status === "confirming" ||
    status === "provisionally_paid" ||
    status === "settled"
  );
}

export function compareCatalogProducts(a: CatalogProduct, b: CatalogProduct): number {
  return (
    compareCodePoints(a.productId, b.productId) ||
    compareCodePoints(a.kind, b.kind) ||
    compareCodePoints(a.label, b.label) ||
    a.priceCents - b.priceCents ||
    Number(a.enabled) - Number(b.enabled)
  );
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeCatalogProjection(input: unknown): CatalogProjection {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PaymentDomainError("catalog_object_required");
  }
  const record = input as Record<string, unknown>;
  if (record.currency !== "USD") throw new PaymentDomainError("catalog_currency_must_be_usd");
  if (!Array.isArray(record.products) || record.products.length === 0) {
    throw new PaymentDomainError("catalog_products_required");
  }

  const productIds = new Set<string>();
  const products = record.products
    .map((value): CatalogProduct => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new PaymentDomainError("invalid_catalog_product");
      }
      const product = value as Record<string, unknown>;
      const productId = boundedText(product.productId, "product_id", 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(productId)) {
        throw new PaymentDomainError("invalid_product_id");
      }
      if (productIds.has(productId)) throw new PaymentDomainError("duplicate_product_id");
      productIds.add(productId);
      const label = boundedText(product.label, "product_label", 200);
      if (product.kind !== "credit_pack" && product.kind !== "prepaid_plan") {
        throw new PaymentDomainError("invalid_product_kind");
      }
      if (
        typeof product.priceCents !== "number" ||
        !Number.isSafeInteger(product.priceCents) ||
        product.priceCents < MINIMUM_PRODUCT_PRICE_CENTS
      ) {
        throw new PaymentDomainError("invalid_product_price_cents");
      }
      if (typeof product.enabled !== "boolean") {
        throw new PaymentDomainError("invalid_product_enabled");
      }
      return {
        productId,
        label,
        kind: product.kind,
        priceCents: product.priceCents,
        enabled: product.enabled,
      };
    })
    .sort(compareCatalogProducts);

  return { currency: "USD", products };
}

export function canonicalCatalogJson(projection: CatalogProjection): string {
  const normalized = normalizeCatalogProjection(projection);
  return JSON.stringify({
    currency: normalized.currency,
    products: normalized.products.map((product) => ({
      productId: product.productId,
      label: product.label,
      kind: product.kind,
      priceCents: product.priceCents,
      enabled: product.enabled,
    })),
  });
}

export function listAmountUnits(priceCents: number): bigint {
  if (!Number.isSafeInteger(priceCents) || priceCents < MINIMUM_PRODUCT_PRICE_CENTS) {
    throw new PaymentDomainError("invalid_product_price_cents");
  }
  return BigInt(priceCents) * 10_000n;
}
