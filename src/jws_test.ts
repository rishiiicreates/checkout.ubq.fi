import { createPersistentJwsSigner, JwsError, verifyCompactJws } from "./jws.ts";

Deno.test("RS256 keypair and kid persist in KV and publish a verifiable JWKS", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const first = createPersistentJwsSigner(kv, {
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });
    const compact = await first.sign({
      iss: "https://checkout.ubq.fi",
      aud: "linkedin-scraper-2025",
      type: "payment.accepted.v1",
      paidAmountUnits: "999999",
    });
    const jwks = await first.jwks();
    assertEquals(jwks.keys.length, 1);
    assertEquals("d" in jwks.keys[0], false);

    const verified = await verifyCompactJws(compact, jwks);
    assertEquals(verified.header.alg, "RS256");
    assertEquals(verified.header.typ, "JWT");
    assertEquals(verified.header.kid, jwks.keys[0].kid);
    assertEquals((verified.payload as Record<string, unknown>).paidAmountUnits, "999999");

    const reloaded = createPersistentJwsSigner(kv);
    assertEquals(await reloaded.kid(), await first.kid());
    const second = await reloaded.sign({ event: "settled" });
    await verifyCompactJws(second, jwks);
  } finally {
    kv.close();
  }
});

Deno.test("concurrent signer initialization converges on one active key", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const signers = Array.from({ length: 4 }, () => createPersistentJwsSigner(kv));
    const kids = await Promise.all(signers.map((signer) => signer.kid()));
    assertEquals(new Set(kids).size, 1);
  } finally {
    kv.close();
  }
});

Deno.test("tampered compact JWS fails verification", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const signer = createPersistentJwsSigner(kv);
    const compact = await signer.sign({ amount: "1" });
    const parts = compact.split(".");
    const replacement = parts[1].endsWith("A") ? "B" : "A";
    parts[1] = `${parts[1].slice(0, -1)}${replacement}`;
    const jwks = await signer.jwks();
    await assertRejectsCode(
      () => verifyCompactJws(parts.join("."), jwks),
      "invalid_jws_signature",
    );
  } finally {
    kv.close();
  }
});

async function assertRejectsCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof JwsError && error.code === code) return;
    throw new Error(`Expected ${code}, got ${String(error)}`);
  }
  throw new Error(`Expected rejection ${code}`);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}
