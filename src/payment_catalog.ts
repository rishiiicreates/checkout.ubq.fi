import type { KvKey, Kv } from "./kv.ts";
import {
  boundedText,
  canonicalCatalogJson,
  type CatalogProjection,
  type CatalogVersionRecord,
  normalizeCatalogProjection,
  PaymentDomainError,
} from "./payment_types.ts";

const CATALOG_PREFIX: KvKey = ["uos_checkout", "v1", "catalog_versions"];

export type Clock = { now(): Date };

export const systemClock: Clock = { now: () => new Date() };

export function catalogVersionKey(merchantId: string, pricingVersionId: string): KvKey {
  return [...CATALOG_PREFIX, merchantId, pricingVersionId];
}

export async function publishCatalogVersion(
  kv: Kv,
  merchantIdInput: unknown,
  pricingVersionIdInput: unknown,
  projectionInput: unknown,
  clock: Clock = systemClock,
): Promise<CatalogVersionRecord> {
  const merchantId = boundedText(merchantIdInput, "merchant_id", 128);
  const pricingVersionId = boundedText(pricingVersionIdInput, "pricing_version_id", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(pricingVersionId)) {
    throw new PaymentDomainError("invalid_pricing_version_id");
  }
  const projection = normalizeCatalogProjection(projectionInput);
  const canonicalJson = canonicalCatalogJson(projection);
  const digest = await sha256Hex(canonicalJson);
  const key = catalogVersionKey(merchantId, pricingVersionId);

  while (true) {
    const existing = await kv.get<CatalogVersionRecord>(key);
    if (existing.value) {
      if (existing.value.digest === digest && existing.value.canonicalJson === canonicalJson) {
        return existing.value;
      }
      throw new PaymentDomainError("catalog_version_conflict");
    }

    const record: CatalogVersionRecord = {
      schemaVersion: 1,
      pricingVersionId,
      digest,
      projection,
      canonicalJson,
      createdAt: clock.now().toISOString(),
    };
    const committed = await kv.atomic().check(existing).set(key, record).commit();
    if (committed.ok) return record;
  }
}

export async function getCatalogVersion(
  kv: Kv,
  merchantIdInput: unknown,
  pricingVersionIdInput: unknown,
): Promise<CatalogVersionRecord> {
  const merchantId = boundedText(merchantIdInput, "merchant_id", 128);
  const pricingVersionId = boundedText(pricingVersionIdInput, "pricing_version_id", 128);
  const version = (
    await kv.get<CatalogVersionRecord>(catalogVersionKey(merchantId, pricingVersionId))
  ).value;
  if (!version) throw new PaymentDomainError("catalog_version_not_found");
  return version;
}

export async function listCatalogVersions(
  kv: Kv,
  merchantIdInput: unknown,
): Promise<CatalogVersionRecord[]> {
  const merchantId = boundedText(merchantIdInput, "merchant_id", 128);
  const versions: CatalogVersionRecord[] = [];
  for await (const entry of kv.list<CatalogVersionRecord>({
    prefix: [...CATALOG_PREFIX, merchantId],
  })) {
    versions.push(entry.value);
  }
  return versions.sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.pricingVersionId.localeCompare(b.pricingVersionId),
  );
}

export function catalogProjectionJson(version: CatalogVersionRecord): CatalogProjection {
  return {
    currency: version.projection.currency,
    products: version.projection.products.map((product) => ({ ...product })),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
