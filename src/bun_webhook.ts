import { resolve4, resolve6 } from "node:dns/promises";
import { connect } from "node:tls";
import { isIP } from "node:net";
import { once } from "node:events";
import { postPinnedWebhook, type ResolvedWebhookTarget, type WebhookDialer } from "./webhook.ts";

export const resolveDns = (hostname: string, type: "A" | "AAAA") =>
  type === "A" ? resolve4(hostname) : resolve6(hostname);
export const postBunWebhook = (target: ResolvedWebhookTarget, body: string, signal: AbortSignal) =>
  postPinnedWebhook(target, body, signal, { dial: dialTls });

/** Hostname-verified TLS plus peer pinning; no payload is written before validation. */
export const dialTls: WebhookDialer = async (hostname, port, signal) => {
  signal.throwIfAborted();
  const socket = connect({
    host: hostname,
    port,
    servername: isIP(hostname) ? undefined : hostname,
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  });
  socket.on("error", () => {});
  const abort = () =>
    socket.destroy(signal.reason instanceof Error ? signal.reason : new Error("webhook_aborted"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    await once(socket, "secureConnect", { signal });
    if (!socket.authorized) throw new Error("webhook_tls_unauthorized");
    if (socket.alpnProtocol && socket.alpnProtocol !== "http/1.1")
      throw new Error("webhook_http_1_required");
    const remoteAddress = socket.remoteAddress;
    if (!remoteAddress) throw new Error("webhook_peer_address_missing");
    const iterator = socket[Symbol.asyncIterator]();
    let pending = new Uint8Array(0);
    const close = () => {
      signal.removeEventListener("abort", abort);
      socket.destroy();
    };
    return {
      remoteAddress,
      connection: {
        async read(buffer) {
          if (!pending.byteLength) {
            const result = await iterator.next();
            if (result.done) return null;
            pending = new Uint8Array(result.value);
          }
          const count = Math.min(buffer.byteLength, pending.byteLength);
          buffer.set(pending.subarray(0, count));
          pending = pending.subarray(count);
          return count;
        },
        async write(buffer) {
          await new Promise<void>((resolve, reject) =>
            socket.write(buffer, (error) => (error ? reject(error) : resolve())),
          );
          return buffer.byteLength;
        },
        close,
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    socket.destroy();
    throw error;
  }
};
