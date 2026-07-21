import { createHandler } from "./main.ts";
import { createAuthService } from "./src/auth.ts";

Deno.test("http auth flow bootstraps super admin and agent-token session", async () => {
  await withApp(async (request) => {
    const anonymous = await request("/api/account/session");
    assertEquals(anonymous.status, 200);
    assertEquals((await anonymous.json()).setupRequired, true);

    const register = await request("/api/auth/register", {
      method: "POST",
      body: {
        email: "owner@example.com",
        password: "correct horse battery staple",
        name: "Owner",
      },
    });
    assertEquals(register.status, 201);
    const adminCookie = cookie(register);
    const adminBody = await register.json();
    assertEquals(adminBody.user.role, "super_admin");
    assertEquals("ok" in adminBody, false);

    const user = await request("/api/admin/users", {
      method: "POST",
      cookie: adminCookie,
      body: {
        email: "friend@example.com",
        password: "correct horse battery staple",
        name: "Friend",
        role: "user",
      },
    });
    assertEquals(user.status, 201);

    const token = await request("/api/admin/agent-tokens", {
      method: "POST",
      cookie: adminCookie,
      body: { email: "friend@example.com", label: "Codex" },
    });
    assertEquals(token.status, 201);
    const tokenBody = await token.json();
    assert(tokenBody.token.startsWith("agent_"));
    assertEquals("tokenHash" in tokenBody.agentToken, false);

    const login = await request("/api/auth/agent-token/login", {
      method: "POST",
      body: { token: tokenBody.token },
    });
    assertEquals(login.status, 200);
    const agentCookie = cookie(login);

    const session = await request("/api/account/session", { cookie: agentCookie });
    const sessionBody = await session.json();
    assertEquals(sessionBody.authenticated, true);
    assertEquals(sessionBody.auth, "agent_token");
    assertEquals(sessionBody.user.email, "friend@example.com");
  });
});

async function withApp(fn: (request: RequestFn) => Promise<void>) {
  const path = await Deno.makeTempFile({ prefix: "auth-template-http-", suffix: ".sqlite" });
  const kv = await Deno.openKv(path);
  const handler = createHandler(createAuthService(kv));

  try {
    await fn(async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.body !== undefined) headers.set("content-type", "application/json");
      if (init.cookie) headers.set("cookie", init.cookie);
      return await handler(
        new Request(`http://localhost${path}`, {
          method: init.method ?? "GET",
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        }),
      );
    });
  } finally {
    kv.close();
    await Deno.remove(path).catch(() => {});
  }
}

type RequestFn = (
  path: string,
  init?: {
    method?: string;
    headers?: HeadersInit;
    cookie?: string;
    body?: unknown;
  },
) => Promise<Response>;

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie") ?? "";
  return value.split(";")[0];
}

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Expected value to be truthy.");
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}
