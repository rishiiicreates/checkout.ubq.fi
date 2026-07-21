import { type AuthService, createAuthService, type PublicUser, type UserRole } from "./src/auth.ts";

const STATIC_ROOT = new URL("./public/", import.meta.url);

export function createHandler(service: AuthService): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      return await route(request, service);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "internal_error";
      return json({ error: message }, { status });
    }
  };
}

async function route(request: Request, service: AuthService): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" || request.method === "HEAD") {
    const staticResponse = maybeStatic(request, url);
    if (staticResponse) {
      return staticResponse;
    }
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ status: "ready" });
  }

  if (url.pathname === "/api/account/session" && request.method === "GET") {
    const session = await service.sessionFromRequest(request);
    if (!session) {
      return json({
        authenticated: false,
        setupRequired: !(await service.hasUsers()),
      });
    }
    return json({
      authenticated: true,
      auth: session.session.auth,
      user: session.user,
      expiresAt: session.session.expiresAt,
    });
  }

  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    const result = await service.register(await requestJson(request));
    return withSessionCookie(request, json({ user: result.user }, { status: 201 }), result);
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const result = await service.login(await requestJson(request));
    return withSessionCookie(request, json({ user: result.user }), result);
  }

  if (url.pathname === "/api/auth/agent-token/login" && request.method === "POST") {
    const result = await service.loginWithAgentToken(await requestJson(request));
    return withSessionCookie(request, json({ user: result.user, auth: "agent_token" }), result);
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    await service.logout(request);
    const response = json({}, { status: 204 });
    response.headers.set("set-cookie", clearSessionCookie(request));
    return response;
  }

  if (url.pathname === "/api/account/me" && request.method === "GET") {
    const auth = await service.requireSession(request);
    return json({ user: auth.user });
  }

  if (url.pathname === "/api/account/me" && request.method === "PATCH") {
    const auth = await service.requireSession(request);
    const user = await service.updateOwnProfile(auth.user.id, await requestJson(request));
    return json({ user });
  }

  if (url.pathname === "/api/account/referrals" && request.method === "GET") {
    const auth = await service.requireSession(request);
    return json(await service.referralsForUser(auth.user.id));
  }

  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    await service.requireAdmin(request);
    return json({ users: await service.listUsers() });
  }

  if (url.pathname === "/api/admin/users" && request.method === "POST") {
    const auth = await service.requireAdmin(request);
    const user = await service.adminCreateUser(auth.user, await requestJson(request));
    return json({ user }, { status: 201 });
  }

  const roleMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
  if (roleMatch && request.method === "PATCH") {
    const auth = await service.requireSuperAdmin(request);
    const user = await service.setUserRole(auth.user, roleMatch[1], await requestJson(request));
    return json({ user });
  }

  if (url.pathname === "/api/admin/agent-tokens" && request.method === "GET") {
    await service.requireAdmin(request);
    return json({ agentTokens: await service.listAgentTokens() });
  }

  if (url.pathname === "/api/admin/agent-tokens" && request.method === "POST") {
    const auth = await service.requireAdmin(request);
    const token = await service.createAgentToken(auth.user, await requestJson(request));
    return json(token, { status: 201 });
  }

  const agentTokenMatch = url.pathname.match(/^\/api\/admin\/agent-tokens\/([^/]+)$/);
  if (agentTokenMatch && request.method === "DELETE") {
    await service.requireAdmin(request);
    await service.revokeAgentToken(agentTokenMatch[1]);
    return json({}, { status: 204 });
  }

  throw new HttpError(404, "not_found");
}

function maybeStatic(request: Request, url: URL): Response | Promise<Response> | null {
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return staticFile("index.html", "text/html; charset=utf-8", request.method);
  }
  if (url.pathname === "/styles.css") {
    return staticFile("styles.css", "text/css; charset=utf-8", request.method);
  }
  if (url.pathname === "/app.js") {
    return staticFile("app.js", "text/javascript; charset=utf-8", request.method);
  }
  return null;
}

async function staticFile(name: string, contentType: string, method: string): Promise<Response> {
  const headers = new Headers({
    "cache-control": "public, max-age=60",
    "content-type": contentType,
  });
  if (method === "HEAD") {
    return new Response(null, { headers });
  }
  return new Response(await Deno.readFile(new URL(name, STATIC_ROOT)), { headers });
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "json_object_required");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid_json");
  }
}

function withSessionCookie(
  request: Request,
  response: Response,
  result: { sessionToken: string; session: { expiresAt: string } },
): Response {
  response.headers.set(
    "set-cookie",
    sessionCookie(result.sessionToken, result.session.expiresAt, request),
  );
  return response;
}

function sessionCookie(token: string, expiresAt: string, request: Request): string {
  const expires = new Date(expiresAt);
  const parts = [
    `auth_template_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expires.toUTCString()}`,
    `Max-Age=${Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000))}`,
  ];
  if (new URL(request.url).protocol === "https:") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearSessionCookie(request: Request): string {
  const parts = [
    "auth_template_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
  ];
  if (new URL(request.url).protocol === "https:") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(init.status === 204 ? null : JSON.stringify(body), { ...init, headers });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type { PublicUser, UserRole };

if (import.meta.main) {
  const kv = await Deno.openKv();
  Deno.serve(createHandler(createAuthService(kv)));
}
