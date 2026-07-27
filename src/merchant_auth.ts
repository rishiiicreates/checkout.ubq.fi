import { LOCAL_PEER_HEADER } from "./admin_auth.ts";
import type { ResolvedWebhookTarget } from "./webhook.ts";

export type MerchantScope =
  | "catalog:write"
  | "invoice:create"
  | "invoice:read"
  | "claim:create";

export type MerchantRecord = {
  id: string;
  name: string;
  settlementWebhookUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type MerchantKeyInfo = {
  id: string;
  merchantId: string;
  label: string;
  scopes: MerchantScope[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

type MerchantKeyRecord = MerchantKeyInfo & { tokenHash: string };

export type MerchantPrincipal = {
  merchant: MerchantRecord;
  key: MerchantKeyInfo;
};

const PREFIX = ["uos_checkout", "v1", "merchant_auth"];
const merchantKey = (merchantId: string) => [...PREFIX, "merchants", merchantId];
const apiKeyKey = (keyId: string) => [...PREFIX, "keys", keyId];
const tokenHashKey = (tokenHash: string) => [...PREFIX, "token_hashes", tokenHash];

const ALL_SCOPES: MerchantScope[] = [
  "catalog:write",
  "invoice:create",
  "invoice:read",
  "claim:create",
];

type MerchantAuthOptions = {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  randomUuid?: () => string;
  resolveDns?: (hostname: string, recordType: "A" | "AAAA") => Promise<string[]>;
};

export function createMerchantAuthService(kv: Deno.Kv, options: MerchantAuthOptions = {}) {
  const now = options.now ?? Date.now;
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID());
  const randomBytes = options.randomBytes ??
    ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  const resolveDns = options.resolveDns ??
    ((hostname, recordType) => Deno.resolveDns(hostname, recordType) as Promise<string[]>);

  const resolveWebhookTarget = async (
    settlementWebhookUrl: string,
  ): Promise<ResolvedWebhookTarget> => {
    const url = new URL(webhookUrl(settlementWebhookUrl));
    const hostname = normalizedHostname(url.hostname);
    if (isIpAddress(hostname)) {
      if (!isPublicIpAddress(hostname)) {
        throw new MerchantAuthError(400, "unsafe_webhook_url");
      }
      return { url, addresses: [hostname] };
    }
    const answers = await Promise.allSettled([
      resolveDns(hostname, "A"),
      resolveDns(hostname, "AAAA"),
    ]);
    const addresses = answers.flatMap((answer) =>
      answer.status === "fulfilled" ? answer.value : []
    );
    if (addresses.length === 0) {
      const failure = answers.find((answer) => answer.status === "rejected");
      throw new MerchantAuthError(
        400,
        "webhook_dns_failed",
        failure?.status === "rejected" ? failure.reason : undefined,
      );
    }
    if (addresses.some((address) => !isPublicIpAddress(address))) {
      throw new MerchantAuthError(400, "unsafe_webhook_url");
    }
    return { url, addresses: [...new Set(addresses.map(normalizedHostname))] };
  };

  const validateWebhookTarget = async (settlementWebhookUrl: string): Promise<void> => {
    await resolveWebhookTarget(settlementWebhookUrl);
  };

  return {
    async getMerchant(merchantIdInput: string): Promise<MerchantRecord | null> {
      const merchantId = identifier(merchantIdInput, "merchant_id");
      return (await kv.get<MerchantRecord>(merchantKey(merchantId))).value;
    },
    validateWebhookTarget,
    resolveWebhookTarget,
    async upsertMerchant(input: {
      id: string;
      name: string;
      settlementWebhookUrl: string;
    }): Promise<MerchantRecord> {
      const id = identifier(input.id, "merchant_id");
      const name = text(input.name, 120, "merchant_name");
      const settlementWebhookUrl = webhookUrl(input.settlementWebhookUrl);
      await validateWebhookTarget(settlementWebhookUrl);
      const existing = await kv.get<MerchantRecord>(merchantKey(id));
      const timestamp = nowIso(now());
      const merchant: MerchantRecord = {
        id,
        name,
        settlementWebhookUrl,
        createdAt: existing.value?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const result = await kv.atomic().check(existing).set(merchantKey(id), merchant).commit();
      if (!result.ok) throw new MerchantAuthError(409, "merchant_changed");
      return merchant;
    },
    async createKey(input: {
      merchantId: string;
      label: string;
      scopes?: MerchantScope[];
    }): Promise<{ token: string; key: MerchantKeyInfo }> {
      const merchantId = identifier(input.merchantId, "merchant_id");
      const merchant = (await kv.get<MerchantRecord>(merchantKey(merchantId))).value;
      if (!merchant) throw new MerchantAuthError(404, "merchant_not_found");
      const label = text(input.label, 120, "key_label");
      const scopes = normalizeScopes(input.scopes ?? ALL_SCOPES);
      const id = randomUuid();
      const token = `uos_checkout_${base64Url(randomBytes(32))}`;
      const tokenHash = await sha256(token);
      const record: MerchantKeyRecord = {
        id,
        merchantId,
        label,
        scopes,
        tokenHash,
        createdAt: nowIso(now()),
      };
      const existingHash = await kv.get<string>(tokenHashKey(tokenHash));
      const result = await kv.atomic()
        .check(existingHash)
        .set(apiKeyKey(id), record)
        .set(tokenHashKey(tokenHash), id)
        .commit();
      if (!result.ok) throw new MerchantAuthError(409, "merchant_key_collision");
      return { token, key: publicKey(record) };
    },
    async listKeys(merchantId: string): Promise<MerchantKeyInfo[]> {
      const keys: MerchantKeyInfo[] = [];
      for await (const entry of kv.list<MerchantKeyRecord>({ prefix: [...PREFIX, "keys"] })) {
        if (entry.value.merchantId === merchantId) keys.push(publicKey(entry.value));
      }
      return keys.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async revokeKey(keyId: string): Promise<void> {
      const entry = await kv.get<MerchantKeyRecord>(apiKeyKey(keyId));
      if (!entry.value || entry.value.revokedAt) {
        throw new MerchantAuthError(404, "merchant_key_not_found");
      }
      const revoked = { ...entry.value, revokedAt: nowIso(now()) };
      const result = await kv.atomic()
        .check(entry)
        .set(apiKeyKey(keyId), revoked)
        .delete(tokenHashKey(entry.value.tokenHash))
        .commit();
      if (!result.ok) throw new MerchantAuthError(409, "merchant_key_changed");
    },
    async authenticate(request: Request, scopes: MerchantScope[]): Promise<MerchantPrincipal> {
      if (isTrustedLocalRequest(request)) {
        return {
          merchant: {
            id: "linkedin-scraper-2025",
            name: "Local LinkedIn Sales Agent",
            settlementWebhookUrl: "http://127.0.0.1:8001/api/billing/crypto-settlements",
            createdAt: nowIso(now()),
            updatedAt: nowIso(now()),
          },
          key: {
            id: "local-loopback",
            merchantId: "local-linkedin",
            label: "Loopback development",
            scopes: ALL_SCOPES,
            createdAt: nowIso(now()),
          },
        };
      }

      const token = bearerToken(request);
      if (!token.startsWith("uos_checkout_")) throw new MerchantAuthError(401, "unauthorized");
      const tokenHash = await sha256(token);
      const keyId = (await kv.get<string>(tokenHashKey(tokenHash))).value;
      if (!keyId) throw new MerchantAuthError(401, "unauthorized");
      const entry = await kv.get<MerchantKeyRecord>(apiKeyKey(keyId));
      if (!entry.value || entry.value.revokedAt || entry.value.tokenHash !== tokenHash) {
        throw new MerchantAuthError(401, "unauthorized");
      }
      if (scopes.some((scope) => !entry.value!.scopes.includes(scope))) {
        throw new MerchantAuthError(403, "insufficient_scope");
      }
      const merchant = (await kv.get<MerchantRecord>(merchantKey(entry.value.merchantId))).value;
      if (!merchant) throw new MerchantAuthError(401, "unauthorized");

      const used = { ...entry.value, lastUsedAt: nowIso(now()) };
      await kv.atomic().check(entry).set(apiKeyKey(entry.value.id), used).commit();
      return { merchant, key: publicKey(used) };
    },
  };
}

function normalizeScopes(scopes: MerchantScope[]): MerchantScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new MerchantAuthError(400, "scopes_required");
  }
  const unique = [...new Set(scopes)];
  if (unique.some((scope) => !ALL_SCOPES.includes(scope))) {
    throw new MerchantAuthError(400, "invalid_scope");
  }
  return ALL_SCOPES.filter((scope) => unique.includes(scope));
}

function publicKey(record: MerchantKeyRecord): MerchantKeyInfo {
  const { tokenHash: _, ...key } = record;
  return key;
}

function webhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MerchantAuthError(400, "invalid_webhook_url");
  }
  if (url.protocol !== "https:") throw new MerchantAuthError(400, "invalid_webhook_url");
  if (url.username || url.password || url.hash) {
    throw new MerchantAuthError(400, "invalid_webhook_url");
  }
  const hostname = normalizedHostname(url.hostname);
  if (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    hostname.endsWith(".internal") || hostname.endsWith(".home.arpa") ||
    (isIpAddress(hostname) && !isPublicIpAddress(hostname))
  ) throw new MerchantAuthError(400, "unsafe_webhook_url");
  return url.toString();
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "");
}

function isIpAddress(value: string): boolean {
  return isIpv4(value) || value.includes(":");
}

function isPublicIpAddress(value: string): boolean {
  const normalized = normalizedHostname(value);
  if (isIpv4(normalized)) return isPublicIpv4(normalized);
  return isPublicIpv6(normalized);
}

function isIpv4(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/u.test(octet) && Number(octet) <= 255);
}

function isPublicIpv4(value: string): boolean {
  const [a, b, c] = value.split(".").map(Number);
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPublicIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  if (!normalized.includes(":") || normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIpv4(mapped) && isPublicIpv4(mapped);
  }
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(first)) return false;
  return first >= 0x2000 && first <= 0x3fff &&
    normalized !== "2001:db8" && !normalized.startsWith("2001:db8:");
}

function identifier(value: string, field: string): string {
  const normalized = value?.trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/i.test(normalized)) {
    throw new MerchantAuthError(400, field);
  }
  return normalized;
}

function text(value: string, limit: number, field: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > limit) throw new MerchantAuthError(400, field);
  return normalized;
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

function isTrustedLocalRequest(request: Request): boolean {
  const peer = request.headers.get(LOCAL_PEER_HEADER);
  const url = new URL(request.url);
  const localOrigin = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  return localOrigin && (peer === "127.0.0.1" || peer === "::1");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

export class MerchantAuthError extends Error {
  constructor(readonly status: number, message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "MerchantAuthError";
  }
}
