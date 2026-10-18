import { withPeerAddress } from "../main.ts";
import { postBunWebhook, resolveDns } from "./bun_webhook.ts";
import { SqliteKv } from "./sqlite_kv.ts";
import { UbqKv } from "./ubq_kv.ts";
import type { Kv } from "./kv.ts";

const STATIC_ROOT = new URL("../public/", import.meta.url);

export async function fetchPublicAsset(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!["index.html", "styles.css", "app.js"].includes(name))
    return new Response(null, { status: 404 });
  const file = Bun.file(new URL(name, STATIC_ROOT));
  return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
}

export function openCheckoutKv(env: Record<string, string | undefined> = process.env): Kv {
  const url = env.CHECKOUT_KV_SERVICE_URL?.trim();
  const token = env.CHECKOUT_KV_SERVICE_TOKEN?.trim();
  if (url || token) {
    if (!url || !token) throw new Error("checkout_kv_service_credentials_incomplete");
    return new UbqKv({ url, token });
  }
  return new SqliteKv(env.CHECKOUT_KV_URL?.trim() || ".uos-checkout.sqlite");
}

export const bunServiceOptions = {
  assetFetcher: fetchPublicAsset,
  resolveDns,
  webhookSender: postBunWebhook,
};

/** Only the established local reverse proxy may reconstruct the canonical HTTPS origin. */
export function withBunIngress(request: Request, peerAddress: string): Request {
  const url = new URL(request.url);
  // Default dual-stack listeners can report an IPv4 loopback socket in either mapped form.
  const normalizedPeer =
    peerAddress === "::ffff:127.0.0.1" || peerAddress === "::ffff:7f00:1"
      ? "127.0.0.1"
      : peerAddress;
  const loopback = normalizedPeer === "127.0.0.1" || normalizedPeer === "::1";
  if (
    loopback &&
    url.protocol === "http:" &&
    url.host === "checkout.ubq.fi" &&
    request.headers.get("x-forwarded-proto") === "https"
  ) {
    url.protocol = "https:";
  }
  return withPeerAddress(request, normalizedPeer, url.toString());
}
