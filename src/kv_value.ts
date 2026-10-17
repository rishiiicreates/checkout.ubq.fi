const CODEC_FIELD = "__uos_checkout_kv";

type Node =
  | ["null"]
  | ["undefined"]
  | ["boolean", boolean]
  | ["number", number | string]
  | ["string", string]
  | ["bigint", string]
  | ["array", Node[]]
  | ["object", [string, Node][]];

/** The service stores arbitrary JSON unchanged; all client types are explicit. */
export function encodeKvValue(value: unknown): unknown {
  return { [CODEC_FIELD]: 1, tree: encode(value) };
}

export function decodeKvValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record[CODEC_FIELD] !== 1 || Object.keys(record).length !== 2 || !("tree" in record)) {
    return value;
  }
  return decode(record.tree);
}

function encode(value: unknown): Node {
  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "number") {
    return ["number", Object.is(value, -0) ? "-0" : Number.isFinite(value) ? value : String(value)];
  }
  if (Array.isArray(value)) return ["array", value.map(encode)];
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return ["object", Object.entries(value).map(([key, item]) => [key, encode(item)])];
  }
  throw new Error("uos_kv_value_type_unsupported");
}

function decode(value: unknown): unknown {
  if (!Array.isArray(value) || typeof value[0] !== "string") return invalid();
  const [tag, data] = value;
  if (tag === "null" && value.length === 1) return null;
  if (tag === "undefined" && value.length === 1) return undefined;
  if (value.length !== 2) return invalid();
  if (tag === "boolean" && typeof data === "boolean") return data;
  if (tag === "string" && typeof data === "string") return data;
  if (tag === "bigint" && typeof data === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(data)) {
    return BigInt(data);
  }
  if (tag === "number") {
    if (typeof data === "number" && Number.isFinite(data)) return data;
    if (["-0", "NaN", "Infinity", "-Infinity"].includes(data)) return Number(data);
  }
  if (tag === "array" && Array.isArray(data)) return data.map(decode);
  if (tag === "object" && Array.isArray(data)) {
    const keys = new Set<string>();
    const entries = data.map((entry): [string, unknown] => {
      if (
        !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
        keys.has(entry[0])
      ) return invalid();
      keys.add(entry[0]);
      return [entry[0], decode(entry[1])];
    });
    return Object.fromEntries(entries);
  }
  return invalid();
}

function invalid(): never {
  throw new Error("uos_kv_value_codec_invalid");
}
