import { test } from "bun:test";
import { equal, ok } from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { startCheckoutServer } from "../bun.ts";
import { SqliteKv } from "./sqlite_kv.ts";
import { AUTH_HUB_ORIGIN, LOCAL_PEER_HEADER } from "./admin_auth.ts";

// A real listener proves trust comes from the socket, including forged Host/header inputs.
test("Bun serves assets and derives loopback access only from its actual socket", async () => {
  const app = startCheckoutServer({ kv: new SqliteKv(), hostname: "0.0.0.0", port: 0 });
  const port = app.server.port;
  try {
    const origin = `http://127.0.0.1:${port}`;
    const session = await fetch(`${origin}/api/v1/admin/session`);
    equal((await session.json()).authenticated, true);
    const publicHost = await fetch(`${origin}/api/v1/admin/session`, {
      headers: {
        host: "checkout.ubq.fi",
        origin: "https://checkout.ubq.fi",
        [LOCAL_PEER_HEADER]: "127.0.0.1",
      },
    });
    equal((await publicHost.json()).authenticated, false);
    const publicMerchant = await fetch(`${origin}/api/v1/invoices`, {
      method: "POST",
      headers: {
        host: "checkout.ubq.fi",
        [LOCAL_PEER_HEADER]: "127.0.0.1",
        "content-type": "application/json",
        "idempotency-key": "proxy-spoof",
      },
      body: "{}",
    });
    equal(publicMerchant.status, 401);
    const proxyHeaders = {
      host: "checkout.ubq.fi",
      "x-forwarded-proto": "https",
      [LOCAL_PEER_HEADER]: "127.0.0.1",
    };
    const proxyLogin = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
      headers: proxyHeaders,
    });
    equal(proxyLogin.status, 302);
    const authLocation = new URL(proxyLogin.headers.get("location")!);
    equal(authLocation.origin, AUTH_HUB_ORIGIN);
    equal(authLocation.searchParams.get("redirect_uri"), "https://checkout.ubq.fi/auth/callback");
    equal(
      (await (await fetch(`${origin}/api/v1/admin/session`, { headers: proxyHeaders })).json())
        .authenticated,
      false,
    );
    const arbitrary = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
      headers: { host: "arbitrary.invalid", "x-forwarded-proto": "https" },
    });
    equal(arbitrary.status, 400);
    const localOrigin = await fetch(`${origin}/api/v1/admin/session`, {
      headers: { "x-forwarded-proto": "https" },
    });
    equal((await localOrigin.json()).authenticated, true);
    const index = await fetch(origin);
    equal(index.status, 200);
    ok((await index.text()).includes("Ubiquity Checkout"));
    ok(index.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
    const head = await fetch(`${origin}/app.js`, { method: "HEAD" });
    equal(head.status, 200);
    equal(await head.text(), "");
    const address = Object.values(networkInterfaces())
      .flat()
      .find((info) => info && !info.internal && info.family === "IPv4")?.address;
    if (!address) throw new Error("non_loopback_interface_required_for_trust_test");
    const remote = await fetch(`http://${address}:${port}/api/v1/admin/session`, {
      headers: {
        host: `localhost:${port}`,
        [LOCAL_PEER_HEADER]: "127.0.0.1",
        "x-forwarded-for": "127.0.0.1",
        "cf-connecting-ip": "127.0.0.1",
      },
    });
    equal((await remote.json()).authenticated, false);
    const forgedProxy = await fetch(`http://${address}:${port}/api/auth/login`, {
      redirect: "manual",
      headers: proxyHeaders,
    });
    equal(forgedProxy.status, 400);
    const protectedResponse = await fetch(`http://${address}:${port}/api/v1/admin/overview`, {
      headers: { host: `localhost:${port}`, [LOCAL_PEER_HEADER]: "127.0.0.1" },
    });
    equal(protectedResponse.status, 401);
  } finally {
    await app.close();
  }
});
