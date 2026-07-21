import { createAuthService } from "./auth.ts";

Deno.test("auth service supports roles, referrals, and agent tokens", async () => {
  await withKv(async (kv) => {
    const service = createAuthService(kv);

    const admin = await service.register({
      email: "owner@example.com",
      password: "correct horse battery staple",
      name: "Owner",
    });
    assertEquals(admin.user.role, "super_admin");
    assert(!("password" in admin.user));

    const user = await service.register({
      email: "friend@example.com",
      password: "correct horse battery staple",
      name: "Friend",
      referralCode: admin.user.referralCode,
    });
    assertEquals(user.user.role, "user");
    assertEquals(user.user.referredByUserId, admin.user.id);

    const referrals = await service.referralsForUser(admin.user.id);
    assertEquals(referrals.count, 1);
    assertEquals(referrals.users[0].email, "friend@example.com");

    const created = await service.adminCreateUser(admin.user, {
      email: "admin@example.com",
      password: "correct horse battery staple",
      name: "Admin",
      role: "admin",
    });
    assertEquals(created.role, "admin");

    const token = await service.createAgentToken(admin.user, {
      email: "friend@example.com",
      label: "Codex",
      ttlDays: 1,
    });
    assert(token.token.startsWith("agent_"));
    assertEquals(token.agentToken.user?.email, "friend@example.com");
    assert(!("tokenHash" in token.agentToken));

    const agentLogin = await service.loginWithAgentToken({ token: token.token });
    assertEquals(agentLogin.user.email, "friend@example.com");
    assertEquals(agentLogin.session.auth, "agent_token");

    const tokens = await service.listAgentTokens();
    assertEquals(tokens.length, 1);
    assertEquals(tokens[0].lastUsedAt !== undefined, true);

    await service.revokeAgentToken(token.agentToken.id);
    let revoked = false;
    try {
      await service.loginWithAgentToken({ token: token.token });
    } catch {
      revoked = true;
    }
    assertEquals(revoked, true);
  });
});

Deno.test("super admin cannot demote itself", async () => {
  await withKv(async (kv) => {
    const service = createAuthService(kv);
    const admin = await service.register({
      email: "owner@example.com",
      password: "correct horse battery staple",
      name: "Owner",
    });

    let rejected = false;
    try {
      await service.setUserRole(admin.user, admin.user.id, { role: "admin" });
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
  });
});

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const path = await Deno.makeTempFile({ prefix: "auth-template-", suffix: ".sqlite" });
  const kv = await Deno.openKv(path);
  try {
    await fn(kv);
  } finally {
    kv.close();
    await Deno.remove(path).catch(() => {});
  }
}

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Expected value to be truthy.");
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}
