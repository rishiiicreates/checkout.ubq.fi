import type { FetchLike } from "./rpc.ts";
import type { ResolvedWebhookTarget, WebhookDeliveryResponse } from "./webhook.ts";

const DNS_TIMEOUT_MS = 5_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const DNS_RESPONSE_LIMIT = 64 * 1024;

/** Workers enforces public egress at its actual connection; it exposes no peer IP. */
export function createWorkerTransport(fetcher: FetchLike = fetch) {
  return {
    async resolveDns(hostname: string, recordType: "A" | "AAAA"): Promise<string[]> {
      const url = new URL("https://cloudflare-dns.com/dns-query");
      url.searchParams.set("name", hostname);
      url.searchParams.set("type", recordType);
      const response = await fetcher(url, {
        headers: { accept: "application/dns-json" },
        redirect: "manual",
        signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("webhook_dns_failed");
      }
      const body = await boundedJson(response);
      if (body.Status !== 0) throw new Error("webhook_dns_failed");
      if (body.Answer === undefined) return [];
      if (!Array.isArray(body.Answer)) throw new Error("webhook_dns_invalid_response");
      const type = recordType === "A" ? 1 : 28;
      return body.Answer.flatMap((answer: unknown) => {
        if (!answer || typeof answer !== "object") return [];
        const record = answer as { type?: unknown; data?: unknown };
        return record.type === type && typeof record.data === "string" ? [record.data] : [];
      });
    },
    async webhookSender(
      target: ResolvedWebhookTarget,
      body: string,
      signal: AbortSignal,
    ): Promise<WebhookDeliveryResponse> {
      signal.throwIfAborted();
      const url = target.url;
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !target.addresses.length
      )
        throw new Error("invalid_webhook_target");
      // Fresh headers and the original hostname retain platform TLS verification.
      // Never forward an incoming Host, cf override, or credential-bearing redirect.
      const response = await fetcher(url.toString(), {
        method: "POST",
        redirect: "manual",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "Ubiquity-Checkout/1.0",
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)]),
      });
      await response.body?.cancel().catch(() => {});
      return { status: response.status, ok: response.status >= 200 && response.status < 300 };
    },
  };
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("webhook_dns_invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DNS_RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("webhook_dns_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("webhook_dns_invalid_response");
  return value as Record<string, unknown>;
}
