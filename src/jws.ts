const ACTIVE_SIGNING_KEY: Deno.KvKey = ["uos_checkout", "v1", "jws", "active"];

export type SigningKeyRecord = {
  schemaVersion: 1;
  kid: string;
  algorithm: "RS256";
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
  createdAt: string;
};

export type PublicRsaJwk = {
  kty: "RSA";
  n: string;
  e: string;
  alg: "RS256";
  use: "sig";
  kid: string;
};

export type Jwks = { keys: PublicRsaJwk[] };

export interface CompactJwsSigner {
  sign(payload: Record<string, unknown>): Promise<string>;
  jwks(): Promise<Jwks>;
  kid(): Promise<string>;
}

export function createPersistentJwsSigner(
  kv: Deno.Kv,
  clock: { now(): Date } = { now: () => new Date() },
): CompactJwsSigner {
  let cachedRecord: SigningKeyRecord | undefined;
  let cachedPrivateKey: CryptoKey | undefined;

  async function record(): Promise<SigningKeyRecord> {
    if (cachedRecord) return cachedRecord;
    cachedRecord = await loadOrCreateSigningKey(kv, clock);
    return cachedRecord;
  }

  return {
    async sign(payload: Record<string, unknown>): Promise<string> {
      const keyRecord = await record();
      cachedPrivateKey ??= await crypto.subtle.importKey(
        "jwk",
        keyRecord.privateJwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const protectedHeader = base64UrlEncode(
        new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyRecord.kid })),
      );
      let encodedPayload: string;
      try {
        encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
      } catch (error) {
        throw new JwsError("jws_payload_not_json", error);
      }
      const signingInput = `${protectedHeader}.${encodedPayload}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        cachedPrivateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
    },
    async jwks(): Promise<Jwks> {
      const keyRecord = await record();
      return { keys: [publicJwk(keyRecord)] };
    },
    async kid(): Promise<string> {
      return (await record()).kid;
    },
  };
}

export async function loadOrCreateSigningKey(
  kv: Deno.Kv,
  clock: { now(): Date } = { now: () => new Date() },
): Promise<SigningKeyRecord> {
  while (true) {
    const existing = await kv.get<SigningKeyRecord>(ACTIVE_SIGNING_KEY);
    if (existing.value) {
      validateSigningKeyRecord(existing.value);
      return existing.value;
    }

    const generated = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
    const exportedPublicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
    if (
      exportedPublicJwk.kty !== "RSA" || typeof exportedPublicJwk.n !== "string" ||
      typeof exportedPublicJwk.e !== "string"
    ) {
      throw new JwsError("generated_rsa_jwk_invalid");
    }
    const kid = await publicKeyId(exportedPublicJwk.n, exportedPublicJwk.e);
    const publicKeyJwk: JsonWebKey = {
      kty: "RSA",
      n: exportedPublicJwk.n,
      e: exportedPublicJwk.e,
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
      ext: true,
    };
    const privateKeyJwk: JsonWebKey = {
      ...privateJwk,
      alg: "RS256",
      use: "sig",
      key_ops: ["sign"],
      ext: true,
    };
    const created: SigningKeyRecord = {
      schemaVersion: 1,
      kid,
      algorithm: "RS256",
      privateJwk: privateKeyJwk,
      publicJwk: publicKeyJwk,
      createdAt: clock.now().toISOString(),
    };
    const committed = await kv.atomic().check(existing).set(ACTIVE_SIGNING_KEY, created).commit();
    if (committed.ok) return created;
  }
}

export async function verifyCompactJws(
  compactJws: string,
  jwks: Jwks,
): Promise<{ header: { alg: "RS256"; typ: "JWT"; kid: string }; payload: unknown }> {
  const parts = compactJws.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new JwsError("invalid_compact_jws");
  }
  const header = parseJsonPart(parts[0], "invalid_jws_header");
  if (
    !header || typeof header !== "object" || Array.isArray(header) ||
    (header as Record<string, unknown>).alg !== "RS256" ||
    (header as Record<string, unknown>).typ !== "JWT" ||
    typeof (header as Record<string, unknown>).kid !== "string"
  ) {
    throw new JwsError("invalid_jws_header");
  }
  const typedHeader = header as { alg: "RS256"; typ: "JWT"; kid: string };
  const jwk = jwks.keys.find((candidate) => candidate.kid === typedHeader.kid);
  if (!jwk || jwk.alg !== "RS256" || jwk.use !== "sig") {
    throw new JwsError("jws_key_not_found");
  }
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const decodedSignature = base64UrlDecode(parts[2]);
  const signature = new Uint8Array(decodedSignature.byteLength);
  signature.set(decodedSignature);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new JwsError("invalid_jws_signature");
  return { header: typedHeader, payload: parseJsonPart(parts[1], "invalid_jws_payload") };
}

export class JwsError extends Error {
  constructor(
    public readonly code: string,
    public override readonly cause?: unknown,
  ) {
    super(code);
    this.name = "JwsError";
  }
}

function validateSigningKeyRecord(record: SigningKeyRecord): void {
  if (
    record.schemaVersion !== 1 || record.algorithm !== "RS256" || !record.kid ||
    record.privateJwk.kty !== "RSA" || record.publicJwk.kty !== "RSA" ||
    typeof record.publicJwk.n !== "string" || typeof record.publicJwk.e !== "string"
  ) {
    throw new JwsError("stored_signing_key_invalid");
  }
}

function publicJwk(record: SigningKeyRecord): PublicRsaJwk {
  const { n, e } = record.publicJwk;
  if (typeof n !== "string" || typeof e !== "string") {
    throw new JwsError("stored_signing_key_invalid");
  }
  return { kty: "RSA", n, e, alg: "RS256", use: "sig", kid: record.kid };
}

async function publicKeyId(n: string, e: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${n}.${e}`));
  return `uos-pay-${base64UrlEncode(new Uint8Array(digest)).slice(0, 24)}`;
}

function parseJsonPart(value: string, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
  } catch (error) {
    throw new JwsError(code, error);
  }
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new JwsError("invalid_base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch (error) {
    throw new JwsError("invalid_base64url", error);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
