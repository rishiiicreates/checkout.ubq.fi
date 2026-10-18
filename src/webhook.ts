export type ResolvedWebhookTarget = {
  url: URL;
  addresses: string[];
};

export type WebhookDeliveryResponse = {
  status: number;
  ok: boolean;
};

export type WebhookConnection = {
  read(buffer: Uint8Array): Promise<number | null>;
  write(buffer: Uint8Array): Promise<number>;
  close(): void;
};

export type WebhookDialResult = {
  connection: WebhookConnection;
  remoteAddress: string;
};

export type WebhookDialer = (
  hostname: string,
  port: number,
  signal: AbortSignal,
) => Promise<WebhookDialResult>;

type PinnedWebhookOptions = {
  dial: WebhookDialer;
};

const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;

export async function postPinnedWebhook(
  target: ResolvedWebhookTarget,
  body: string,
  signal: AbortSignal,
  options: PinnedWebhookOptions,
): Promise<WebhookDeliveryResponse> {
  const dial = options.dial;
  return await postToResolvedTarget(target, body, signal, dial);
}

async function postToResolvedTarget(
  target: ResolvedWebhookTarget,
  body: string,
  signal: AbortSignal,
  dial: WebhookDialer,
): Promise<WebhookDeliveryResponse> {
  if (signal.aborted) throw signal.reason;
  const url = target.url;
  const port = url.port ? Number(url.port) : 443;
  const tlsHostname = normalizedHostname(url.hostname);
  const { connection, remoteAddress } = await dial(tlsHostname, port, signal);
  const approvedAddresses = new Set(target.addresses.map(canonicalIpAddress));
  if (!approvedAddresses.has(canonicalIpAddress(remoteAddress))) {
    connection.close();
    throw new Error("webhook_address_changed");
  }
  const abort = () => connection.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    const bodyBytes = new TextEncoder().encode(body);
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    const pathname = `${url.pathname || "/"}${url.search}`;
    const head = new TextEncoder().encode(
      `POST ${pathname} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        "Accept: application/json\r\n" +
        "Content-Type: application/json\r\n" +
        "User-Agent: Ubiquity-Checkout/1.0\r\n" +
        `Content-Length: ${bodyBytes.byteLength}\r\n` +
        "Connection: close\r\n\r\n",
    );
    await writeAll(connection, head);
    await writeAll(connection, bodyBytes);
    const status = await readStatus(connection);
    return { status, ok: status >= 200 && status < 300 };
  } finally {
    signal.removeEventListener("abort", abort);
    connection.close();
  }
}

async function writeAll(connection: WebhookConnection, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = await connection.write(bytes.subarray(written));
    if (count <= 0) throw new Error("webhook_connection_closed");
    written += count;
  }
}

async function readStatus(connection: WebhookConnection): Promise<number> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_RESPONSE_HEADER_BYTES) {
    const chunk = new Uint8Array(Math.min(4096, MAX_RESPONSE_HEADER_BYTES - total));
    const count = await connection.read(chunk);
    if (count === null) break;
    if (count === 0) continue;
    const received = chunk.slice(0, count);
    chunks.push(received);
    total += received.byteLength;
    const header = concat(chunks, total);
    const end = indexOfHeaderEnd(header);
    if (end === -1) continue;
    const statusLine = new TextDecoder().decode(header.subarray(0, header.indexOf(13)));
    const match = statusLine.match(/^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |$)/u);
    if (!match) throw new Error("webhook_invalid_http_response");
    return Number(match[1]);
  }
  throw new Error(
    total >= MAX_RESPONSE_HEADER_BYTES
      ? "webhook_response_headers_too_large"
      : "webhook_incomplete_http_response",
  );
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    )
      return index;
  }
  return -1;
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "");
}

function canonicalIpAddress(address: string): string {
  const normalized = normalizedHostname(address);
  try {
    const hostname = normalized.includes(":")
      ? new URL(`http://[${normalized}]`).hostname
      : new URL(`http://${normalized}`).hostname;
    return normalizedHostname(hostname);
  } catch {
    return "";
  }
}
