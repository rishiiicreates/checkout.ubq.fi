type EncodedValue =
  | null
  | boolean
  | number
  | string
  | { type: "bigint"; value: string }
  | { type: "array"; value: EncodedValue[] }
  | { type: "object"; value: [string, EncodedValue][] };

/** Versioned Checkout-owned envelope; ordinary objects never share the tag namespace. */
export function encodeKvValue(value: unknown): unknown {
  return { format: "uos_checkout_kv", version: 1, value: encode(value) };
}

export function decodeKvValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 3 ||
    envelope.format !== "uos_checkout_kv" ||
    envelope.version !== 1 ||
    !("value" in envelope)
  )
    return value;
  return decode(envelope.value as EncodedValue);
}

function encode(value: unknown): EncodedValue {
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return { type: "array", value: value.map(encode) };
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return {
      type: "object",
      value: Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, encode(item)]),
    };
  }
  throw new TypeError("unsupported_kv_value");
}

function decode(value: EncodedValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value.type === "bigint" && /^-?(?:0|[1-9][0-9]*)$/.test(value.value))
    return BigInt(value.value);
  if (value.type === "array" && Array.isArray(value.value)) return value.value.map(decode);
  if (value.type === "object" && Array.isArray(value.value))
    return Object.fromEntries(value.value.map(([key, item]) => [key, decode(item)]));
  throw new TypeError("invalid_kv_value_envelope");
}
