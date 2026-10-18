import { test } from "bun:test";
import { equal, ok } from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { startCheckoutServer } from "../bun.ts";
import { createCheckoutServices, createHandler } from "../main.ts";
import { withBunIngress } from "./bun_runtime.ts";
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

test("Bun default dual-stack listener reconstructs only trusted canonical proxy requests", async () => {
  const kv = new SqliteKv();
  const handler = createHandler(createCheckoutServices(kv));
  const peers: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, listener) {
      const peer = listener.requestIP(request)?.address ?? "";
      peers.push(peer);
      return handler(withBunIngress(request, peer));
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const proxyHeaders = {
    host: "checkout.ubq.fi",
    "x-forwarded-proto": "https",
    [LOCAL_PEER_HEADER]: "127.0.0.1",
  };
  try {
    const login = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
      headers: proxyHeaders,
    });
    console.log(
      JSON.stringify({
        listener: "default-dual-stack",
        actualPeer: peers[0],
        loginStatus: login.status,
      }),
    );
    equal(login.status, 302);
    const location = new URL(login.headers.get("location")!);
    equal(location.origin, AUTH_HUB_ORIGIN);
    equal(location.searchParams.get("redirect_uri"), "https://checkout.ubq.fi/auth/callback");
    const protectedResponse = await fetch(`${origin}/api/v1/admin/overview`, {
      headers: proxyHeaders,
    });
    equal(protectedResponse.status, 401);
    equal(
      (await (await fetch(`${origin}/api/v1/admin/session`, { headers: proxyHeaders })).json())
        .authenticated,
      false,
    );
    const forgedHost = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
      headers: { ...proxyHeaders, host: "arbitrary.invalid" },
    });
    equal(forgedHost.status, 400);
    const local = await fetch(`${origin}/api/v1/admin/session`, {
      headers: { "x-forwarded-proto": "https" },
    });
    equal((await local.json()).authenticated, true);
    const address = Object.values(networkInterfaces())
      .flat()
      .find((info) => info && !info.internal && info.family === "IPv4")?.address;
    if (!address) throw new Error("non_loopback_interface_required_for_trust_test");
    const remoteOrigin = `http://${address}:${server.port}`;
    const forgedHeaders = {
      ...proxyHeaders,
      "x-forwarded-for": "127.0.0.1",
      "cf-connecting-ip": "127.0.0.1",
    };
    const remote = await fetch(`${remoteOrigin}/api/auth/login`, {
      redirect: "manual",
      headers: forgedHeaders,
    });
    equal(remote.status, 400);
    equal(
      (await fetch(`${remoteOrigin}/api/v1/admin/overview`, { headers: forgedHeaders })).status,
      401,
    );
  } finally {
    await server.stop(true);
    kv.close();
  }
});

test("Bun mapped loopback recognition uses exact socket-address forms", () => {
  const request = () =>
    new Request("http://checkout.ubq.fi/api/v1/admin/session", {
      headers: { "x-forwarded-proto": "https", [LOCAL_PEER_HEADER]: "127.0.0.1" },
    });
  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    const normalized = withBunIngress(request(), peer);
    equal(new URL(normalized.url).origin, "https://checkout.ubq.fi");
    equal(normalized.headers.get(LOCAL_PEER_HEADER), peer === "::1" ? "::1" : "127.0.0.1");
  }
  for (const peer of [
    "",
    "::ffff:127.0.0.2",
    "::ffff:7f00:2",
    "::ffff:192.168.1.1",
    "::ffff:c0a8:101",
    "::ffff:10.0.0.1",
    "127.0.0.1.evil",
    "x::ffff:127.0.0.1",
    "::ffff:127.0.0.1.evil",
  ]) {
    const normalized = withBunIngress(request(), peer);
    equal(new URL(normalized.url).origin, "http://checkout.ubq.fi");
    equal(normalized.headers.has(LOCAL_PEER_HEADER), false);
  }
});
