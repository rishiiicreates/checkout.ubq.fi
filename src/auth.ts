export type UserRole = "user" | "admin" | "super_admin";

export type PasswordRecord = {
  salt: string;
  hash: string;
  iterations: number;
  algorithm: "PBKDF2-SHA-256";
  updatedAt: string;
};

export type UserRecord = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  scopes: string[];
  referralCode: string;
  referredByUserId?: string;
  password: PasswordRecord;
  createdAt: string;
  updatedAt: string;
};

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  scopes: string[];
  referralCode: string;
  referredByUserId?: string;
  createdAt: string;
  updatedAt: string;
};

type SessionAuth = "password" | "agent_token";

type SessionRecord = {
  tokenHash: string;
  userId: string;
  auth: SessionAuth;
  createdAt: string;
  expiresAt: string;
};

type AgentTokenRecord = {
  id: string;
  tokenHash: string;
  userId: string;
  label: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
};

export type AgentTokenInfo = Omit<AgentTokenRecord, "tokenHash"> & {
  user: Pick<PublicUser, "id" | "email" | "name" | "role"> | null;
  createdBy: Pick<PublicUser, "id" | "email" | "name" | "role"> | null;
};

export type AuthSession = {
  session: SessionRecord;
  user: PublicUser;
};

export type AuthResult = {
  user: PublicUser;
  session: SessionRecord;
  sessionToken: string;
};

export type AuthService = ReturnType<typeof createAuthService>;

const PREFIX = ["auth_template", "v1", "checkout-ubq-fi"];
const USERS_PREFIX = [...PREFIX, "users"];
const EMAILS_PREFIX = [...PREFIX, "emails"];
const REFERRALS_PREFIX = [...PREFIX, "referrals"];
const SESSIONS_PREFIX = [...PREFIX, "sessions"];
const AGENT_TOKENS_PREFIX = [...PREFIX, "agent_tokens"];
const AGENT_TOKEN_HASHES_PREFIX = [...PREFIX, "agent_token_hashes"];
const PASSWORD_ITERATIONS = 210_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AGENT_TOKEN_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_TOKEN_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const defaultScopesByRole: Record<UserRole, string[]> = {
  user: ["account:read", "account:write"],
  admin: ["account:read", "account:write", "admin:read", "admin:write"],
  super_admin: [
    "account:read",
    "account:write",
    "admin:read",
    "admin:write",
    "super_admin:write",
  ],
};

const userKey = (id: string) => [...USERS_PREFIX, id];
const emailKey = (email: string) => [...EMAILS_PREFIX, email];
const referralCodeKey = (code: string) => [...REFERRALS_PREFIX, code];
const sessionKey = (tokenHash: string) => [...SESSIONS_PREFIX, tokenHash];
const agentTokenKey = (id: string) => [...AGENT_TOKENS_PREFIX, id];
const agentTokenHashKey = (tokenHash: string) => [...AGENT_TOKEN_HASHES_PREFIX, tokenHash];

export function createAuthService(kv: Deno.Kv) {
  return {
    hasUsers: () => hasUsers(kv),
    register: (input: Record<string, unknown>) => register(kv, input),
    login: (input: Record<string, unknown>) => login(kv, input),
    loginWithAgentToken: (input: Record<string, unknown>) => loginWithAgentToken(kv, input),
    logout: (request: Request) => logout(kv, request),
    sessionFromRequest: (request: Request) => sessionFromRequest(kv, request),
    requireSession: (request: Request) => requireSession(kv, request),
    requireAdmin: (request: Request) => requireAdmin(kv, request),
    requireSuperAdmin: (request: Request) => requireSuperAdmin(kv, request),
    updateOwnProfile: (userId: string, input: Record<string, unknown>) =>
      updateOwnProfile(kv, userId, input),
    referralsForUser: (userId: string) => referralsForUser(kv, userId),
    listUsers: () => listUsers(kv),
    adminCreateUser: (actor: PublicUser, input: Record<string, unknown>) =>
      adminCreateUser(kv, actor, input),
    setUserRole: (actor: PublicUser, userId: string, input: Record<string, unknown>) =>
      setUserRole(kv, actor, userId, input),
    createAgentToken: (actor: PublicUser, input: Record<string, unknown>) =>
      createAgentToken(kv, actor, input),
    listAgentTokens: () => listAgentTokens(kv),
    revokeAgentToken: (id: string) => revokeAgentToken(kv, id),
  };
}

async function hasUsers(kv: Deno.Kv): Promise<boolean> {
  for await (const _entry of kv.list<UserRecord>({ prefix: USERS_PREFIX })) {
    return true;
  }
  return false;
}

async function register(kv: Deno.Kv, input: Record<string, unknown>): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const password = text(input.password, 500);
  const name = text(input.name, 120) || email.split("@")[0];
  const referralCode = normalizeCode(input.referralCode ?? input.ref);
  if (!email) throw new AuthError(400, "email_required");
  validatePassword(password);

  const firstUser = !(await hasUsers(kv));
  const role: UserRole = firstUser ? "super_admin" : "user";
  const referredByUserId = referralCode
    ? (await kv.get<string>(referralCodeKey(referralCode))).value ?? undefined
    : undefined;
  const user = await createUserRecord(kv, { email, password, name, role, referredByUserId });
  return createSessionResult(kv, user, "password");
}

async function login(kv: Deno.Kv, input: Record<string, unknown>): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const password = text(input.password, 500);
  if (!email || !password) throw new AuthError(401, "invalid_credentials");
  const user = await userByEmail(kv, email);
  if (!user || !(await verifyPassword(password, user.password))) {
    throw new AuthError(401, "invalid_credentials");
  }
  return createSessionResult(kv, user, "password");
}

async function loginWithAgentToken(
  kv: Deno.Kv,
  input: Record<string, unknown>,
): Promise<AuthResult> {
  const rawToken = text(input.token, 500);
  if (!rawToken.startsWith("agent_")) {
    throw new AuthError(401, "invalid_agent_token");
  }
  const tokenHash = await sha256Base64Url(rawToken);
  const tokenId = (await kv.get<string>(agentTokenHashKey(tokenHash))).value;
  if (!tokenId) throw new AuthError(401, "invalid_agent_token");
  const token = (await kv.get<AgentTokenRecord>(agentTokenKey(tokenId))).value;
  if (!token || token.tokenHash !== tokenHash) {
    throw new AuthError(401, "invalid_agent_token");
  }
  const expiresAtMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    await deleteAgentToken(kv, token);
    throw new AuthError(401, "invalid_agent_token");
  }
  const user = await getUser(kv, token.userId);
  if (!user) throw new AuthError(401, "invalid_agent_token");

  const remainingTtlMs = Math.max(1, expiresAtMs - Date.now());
  await kv.set(agentTokenKey(token.id), { ...token, lastUsedAt: nowIso() }, {
    expireIn: remainingTtlMs,
  });
  return createSessionResult(kv, user, "agent_token");
}

async function logout(kv: Deno.Kv, request: Request): Promise<void> {
  const sessionToken = cookieValue(request, "auth_template_session");
  if (!sessionToken) return;
  await kv.delete(sessionKey(await sha256Base64Url(sessionToken)));
}

async function sessionFromRequest(kv: Deno.Kv, request: Request): Promise<AuthSession | null> {
  const sessionToken = cookieValue(request, "auth_template_session");
  if (!sessionToken) return null;
  const tokenHash = await sha256Base64Url(sessionToken);
  const session = (await kv.get<SessionRecord>(sessionKey(tokenHash))).value;
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    if (session) await kv.delete(sessionKey(tokenHash));
    return null;
  }
  const user = await getUser(kv, session.userId);
  if (!user) return null;
  return { session, user: publicUser(user) };
}

async function requireSession(kv: Deno.Kv, request: Request): Promise<AuthSession> {
  const session = await sessionFromRequest(kv, request);
  if (!session) throw new AuthError(401, "unauthorized");
  return session;
}

async function requireAdmin(kv: Deno.Kv, request: Request): Promise<AuthSession> {
  const session = await requireSession(kv, request);
  if (session.user.role !== "admin" && session.user.role !== "super_admin") {
    throw new AuthError(403, "forbidden");
  }
  return session;
}

async function requireSuperAdmin(kv: Deno.Kv, request: Request): Promise<AuthSession> {
  const session = await requireSession(kv, request);
  if (session.user.role !== "super_admin") {
    throw new AuthError(403, "forbidden");
  }
  return session;
}

async function updateOwnProfile(
  kv: Deno.Kv,
  userId: string,
  input: Record<string, unknown>,
): Promise<PublicUser> {
  const user = await getUser(kv, userId);
  if (!user) throw new AuthError(404, "user_not_found");
  const name = text(input.name, 120);
  if (!name) throw new AuthError(400, "name_required");
  const next = { ...user, name, updatedAt: nowIso() };
  await kv.set(userKey(user.id), next);
  return publicUser(next);
}

async function referralsForUser(kv: Deno.Kv, userId: string) {
  const user = await getUser(kv, userId);
  if (!user) throw new AuthError(404, "user_not_found");
  const referred: PublicUser[] = [];
  for await (const entry of kv.list<UserRecord>({ prefix: USERS_PREFIX })) {
    if (entry.value.referredByUserId === userId) {
      referred.push(publicUser(entry.value));
    }
  }
  referred.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    referralCode: user.referralCode,
    count: referred.length,
    users: referred,
  };
}

async function listUsers(kv: Deno.Kv): Promise<PublicUser[]> {
  const users: PublicUser[] = [];
  for await (const entry of kv.list<UserRecord>({ prefix: USERS_PREFIX })) {
    users.push(publicUser(entry.value));
  }
  users.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return users;
}

async function adminCreateUser(
  kv: Deno.Kv,
  actor: PublicUser,
  input: Record<string, unknown>,
): Promise<PublicUser> {
  const email = normalizeEmail(input.email);
  const password = text(input.password, 500);
  const name = text(input.name, 120) || email.split("@")[0];
  const requestedRole = parseRole(input.role) ?? "user";
  const role = actor.role === "super_admin" ? requestedRole : "user";
  if (!email) throw new AuthError(400, "email_required");
  validatePassword(password);
  return publicUser(await createUserRecord(kv, { email, password, name, role }));
}

async function setUserRole(
  kv: Deno.Kv,
  actor: PublicUser,
  userId: string,
  input: Record<string, unknown>,
): Promise<PublicUser> {
  const role = parseRole(input.role);
  if (!role) throw new AuthError(400, "role_required");
  const user = await getUser(kv, userId);
  if (!user) throw new AuthError(404, "user_not_found");
  if (actor.id === user.id && user.role === "super_admin" && role !== "super_admin") {
    throw new AuthError(400, "cannot_demote_self");
  }
  const next = {
    ...user,
    role,
    scopes: scopesForRole(role),
    updatedAt: nowIso(),
  };
  await kv.set(userKey(next.id), next);
  return publicUser(next);
}

async function createAgentToken(
  kv: Deno.Kv,
  actor: PublicUser,
  input: Record<string, unknown>,
): Promise<{ token: string; agentToken: AgentTokenInfo }> {
  const target = await resolveTargetUser(kv, input);
  const ttlMs = agentTokenTtlMs(input);
  const rawToken = `agent_${randomBase64Url(32)}`;
  const tokenHash = await sha256Base64Url(rawToken);
  const now = nowIso();
  const record: AgentTokenRecord = {
    id: crypto.randomUUID(),
    tokenHash,
    userId: target.id,
    label: text(input.label, 120) || `Agent token for ${target.email}`,
    createdByUserId: actor.id,
    createdAt: now,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  await kv.atomic()
    .check({ key: agentTokenKey(record.id), versionstamp: null })
    .check({ key: agentTokenHashKey(tokenHash), versionstamp: null })
    .set(agentTokenKey(record.id), record, { expireIn: ttlMs })
    .set(agentTokenHashKey(tokenHash), record.id, { expireIn: ttlMs })
    .commit();
  return { token: rawToken, agentToken: await agentTokenInfo(kv, record) };
}

async function listAgentTokens(kv: Deno.Kv): Promise<AgentTokenInfo[]> {
  const tokens: AgentTokenInfo[] = [];
  for await (const entry of kv.list<AgentTokenRecord>({ prefix: AGENT_TOKENS_PREFIX })) {
    tokens.push(await agentTokenInfo(kv, entry.value));
  }
  tokens.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return tokens;
}

async function revokeAgentToken(kv: Deno.Kv, id: string): Promise<void> {
  const token = (await kv.get<AgentTokenRecord>(agentTokenKey(id))).value;
  if (token) {
    await deleteAgentToken(kv, token);
  }
}

async function createUserRecord(
  kv: Deno.Kv,
  input: {
    email: string;
    password: string;
    name: string;
    role: UserRole;
    referredByUserId?: string;
  },
): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  if ((await kv.get(emailKey(email))).value) {
    throw new AuthError(409, "email_exists");
  }

  const now = nowIso();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    email,
    name: input.name.trim(),
    role: input.role,
    scopes: scopesForRole(input.role),
    referralCode: await uniqueReferralCode(kv, input.name || email),
    referredByUserId: input.referredByUserId,
    password: await hashPassword(input.password),
    createdAt: now,
    updatedAt: now,
  };

  const commit = await kv.atomic()
    .check({ key: userKey(user.id), versionstamp: null })
    .check({ key: emailKey(user.email), versionstamp: null })
    .check({ key: referralCodeKey(user.referralCode), versionstamp: null })
    .set(userKey(user.id), user)
    .set(emailKey(user.email), user.id)
    .set(referralCodeKey(user.referralCode), user.id)
    .commit();
  if (!commit.ok) throw new AuthError(409, "user_conflict");
  return user;
}

async function createSessionResult(
  kv: Deno.Kv,
  user: UserRecord,
  auth: SessionAuth,
): Promise<AuthResult> {
  const rawToken = `session_${randomBase64Url(32)}`;
  const now = Date.now();
  const session: SessionRecord = {
    tokenHash: await sha256Base64Url(rawToken),
    userId: user.id,
    auth,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  await kv.set(sessionKey(session.tokenHash), session, { expireIn: SESSION_TTL_MS });
  return { user: publicUser(user), session, sessionToken: rawToken };
}

async function resolveTargetUser(kv: Deno.Kv, input: Record<string, unknown>): Promise<UserRecord> {
  const userId = text(input.userId, 120);
  const email = normalizeEmail(input.email);
  if (userId) {
    const user = await getUser(kv, userId);
    if (!user) throw new AuthError(404, "user_not_found");
    return user;
  }
  if (email) {
    const user = await userByEmail(kv, email);
    if (!user) throw new AuthError(404, "user_not_found");
    return user;
  }
  throw new AuthError(400, "target_user_required");
}

async function agentTokenInfo(kv: Deno.Kv, token: AgentTokenRecord): Promise<AgentTokenInfo> {
  const user = await getUser(kv, token.userId);
  const createdBy = await getUser(kv, token.createdByUserId);
  return {
    id: token.id,
    userId: token.userId,
    label: token.label,
    createdByUserId: token.createdByUserId,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    user: user ? publicUserSummary(user) : null,
    createdBy: createdBy ? publicUserSummary(createdBy) : null,
  };
}

async function deleteAgentToken(kv: Deno.Kv, token: AgentTokenRecord): Promise<void> {
  await kv.atomic()
    .delete(agentTokenKey(token.id))
    .delete(agentTokenHashKey(token.tokenHash))
    .commit();
}

async function getUser(kv: Deno.Kv, userId: string): Promise<UserRecord | null> {
  return (await kv.get<UserRecord>(userKey(userId))).value ?? null;
}

async function userByEmail(kv: Deno.Kv, email: string): Promise<UserRecord | null> {
  const userId = (await kv.get<string>(emailKey(normalizeEmail(email)))).value;
  return userId ? await getUser(kv, userId) : null;
}

function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    scopes: user.scopes,
    referralCode: user.referralCode,
    referredByUserId: user.referredByUserId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function publicUserSummary(user: UserRecord): Pick<PublicUser, "id" | "email" | "name" | "role"> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

function scopesForRole(role: UserRole): string[] {
  return [...defaultScopesByRole[role]];
}

function parseRole(value: unknown): UserRole | null {
  return value === "user" || value === "admin" || value === "super_admin" ? value : null;
}

function normalizeEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function normalizeCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 64);
}

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function validatePassword(password: string): void {
  if (password.length < 10) {
    throw new AuthError(400, "password_too_short");
  }
}

async function uniqueReferralCode(kv: Deno.Kv, seed: string): Promise<string> {
  const base = normalizeCode(seed).replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) ||
    "user";
  for (let index = 0; index < 8; index += 1) {
    const suffix = index === 0 ? "" : `-${randomBase64Url(3).toLowerCase()}`;
    const candidate = `${base}${suffix}`;
    if (!(await kv.get(referralCodeKey(candidate))).value) {
      return candidate;
    }
  }
  return `user-${randomBase64Url(8).toLowerCase()}`;
}

function agentTokenTtlMs(input: Record<string, unknown>): number {
  const raw = input.ttlDays ?? input.days;
  if (raw === undefined || raw === null || raw === "") return AGENT_TOKEN_DEFAULT_TTL_MS;
  const days = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(days) || days <= 0) {
    throw new AuthError(400, "ttl_days_invalid");
  }
  return Math.round(Math.min(days * 24 * 60 * 60 * 1000, AGENT_TOKEN_MAX_TTL_MS));
}

async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PASSWORD_ITERATIONS);
  return {
    salt: base64Url(salt),
    hash: base64Url(hash),
    iterations: PASSWORD_ITERATIONS,
    algorithm: "PBKDF2-SHA-256",
    updatedAt: nowIso(),
  };
}

async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const hash = await pbkdf2(password, base64UrlDecode(record.salt), record.iterations);
  return constantTimeEqual(base64Url(hash), record.hash);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: arrayBuffer(salt), iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function randomBase64Url(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function cookieValue(request: Request, name: string): string {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return "";
}

function nowIso(): string {
  return new Date().toISOString();
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "AuthError";
  }
}
