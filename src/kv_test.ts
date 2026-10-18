import { test } from "bun:test";
import { deepStrictEqual as equal, ok, rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteKv } from "./sqlite_kv.ts";
import { UbqKv } from "./ubq_kv.ts";
import { decodeKvValue, encodeKvValue } from "./kv_codec.ts";
import { createPersistentJwsSigner } from "./jws.ts";

const collect = async <T>(iterator: AsyncIterable<T>) => {
  const values: T[] = [];
  for await (const value of iterator) values.push(value);
  return values;
};

test("versioned KV codec preserves bigint, tag-shaped JSON, and legacy records", () => {
  const value = {
    amount: 123456789012345678901n,
    nested: [
      { type: "bigint", value: "99" },
      { format: "uos_checkout_kv", version: 1, value: { type: "bigint", value: "3" } },
    ],
    zero: 0n,
  };
  equal(decodeKvValue(JSON.parse(JSON.stringify(encodeKvValue(value)))), value);
  const legacy = { amount: "1000000", type: "bigint", value: "99", product: { arbitrary: true } };
  equal(decodeKvValue(legacy), legacy);
  equal(decodeKvValue({ type: "bigint", value: "99" }), { type: "bigint", value: "99" });
  equal(
    decodeKvValue(
      encodeKvValue({
        format: "uos_checkout_kv",
        version: 1,
        value: { type: "bigint", value: "3" },
      }),
    ),
    { format: "uos_checkout_kv", version: 1, value: { type: "bigint", value: "3" } },
  );
});

test("SQLite KV enforces CAS atomically across connections and retains signing identity after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "uos-checkout-kv-"));
  const path = join(directory, "store.sqlite");
  let first = new SqliteKv(path);
  const second = new SqliteKv(path);
  try {
    const absent = await first.get(["owner"]);
    const a = first.atomic().check(absent).set(["owner"], "first").set(["amount"], 1000000n);
    const b = second.atomic().check(absent).set(["owner"], "second").set(["leak"], true);
    equal((await a.commit()).ok, true);
    equal(await b.commit(), { ok: false, versionstamp: null });
    equal((await second.get(["owner"])).value, "first");
    equal((await second.get(["leak"])).value, null);
    equal((await second.get(["amount"])).value, 1000000n);
    const signer = createPersistentJwsSigner(first);
    const before = await signer.jwks();
    first.close();
    first = new SqliteKv(path);
    equal(await createPersistentJwsSigner(first).jwks(), before);
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true });
  }
});

test("SQLite TTL is absent to reads, lists, and atomic checks; values are snapshots", async () => {
  let now = 1000;
  const kv = new SqliteKv(":memory:", () => now);
  try {
    const original = { count: 1, amount: 5n };
    await kv.set(["ttl"], original, { expireIn: 10 });
    original.count = 9;
    const snapshot = await kv.get<typeof original>(["ttl"]);
    equal(snapshot.value?.count, 1);
    snapshot.value!.count = 8;
    equal((await kv.get<typeof original>(["ttl"])).value?.count, 1);
    now = 1010;
    equal((await kv.get(["ttl"])).versionstamp, null);
    equal(await collect(kv.list({ prefix: [] })), []);
    equal((await kv.atomic().check(snapshot).set(["bad"], true).commit()).ok, false);
    equal(
      (
        await kv
          .atomic()
          .check({ key: ["ttl"], versionstamp: null })
          .set(["ttl"], "new")
          .commit()
      ).ok,
      true,
    );
    await rejects(() => kv.set(["bad"], 1, { expireIn: 0 }));
  } finally {
    kv.close();
  }
});

test("SQLite tuples sort numerically and apply prefix/range/reverse before limit", async () => {
  const kv = new SqliteKv();
  try {
    for (const number of [10, 2, 1, 100]) await kv.set(["outbox", number, "event"], number);
    await kv.set(["unrelated", 3], 3);
    equal(
      (
        await collect(kv.list<number>({ start: ["outbox", 2], end: ["outbox", 100] }, { limit: 2 }))
      ).map((e) => e.value),
      [2, 10],
    );
    equal(
      (await collect(kv.list<number>({ prefix: ["outbox"] }, { reverse: true, limit: 2 }))).map(
        (e) => e.value,
      ),
      [100, 10],
    );
  } finally {
    kv.close();
  }
});

test("D1 adapter preserves wire paths, atomics, TTL, legacy keys and paginated ranges", async () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let stored: unknown;
  const kv = new UbqKv({
    url: "https://kv.invalid",
    token: "offline-test-only",
    fetchImpl: async (url, init) => {
      equal(new Headers(init.headers).get("authorization"), "Bearer offline-test-only");
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      if (path === "/kv/set") {
        stored = body.value;
        return Response.json({ ok: true, versionstamp: "2" });
      }
      if (path === "/kv/get")
        return Response.json({
          ok: true,
          entry: { key: body.key, value: stored ?? { legacy: "100" }, versionstamp: "2" },
        });
      if (path === "/kv/atomic") return Response.json({ ok: false });
      if (path === "/kv/list") {
        const entries = body.cursor ? [2, 100] : [1, 10];
        return Response.json({
          ok: true,
          entries: entries.map((n) => ({
            key: ["outbox", n, "e"],
            value: `event-${n}`,
            versionstamp: "1",
          })),
          cursor: body.cursor ? null : "page-2",
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });
  equal((await kv.get<{ legacy: string }>(["existing-signing-key"])).value, { legacy: "100" });
  await kv.set(["invoice"], { amount: 123n }, { expireIn: 500 });
  equal((await kv.get(["invoice"])).value, { amount: 123n });
  equal(calls.find((call) => call.path === "/kv/set")?.body.expireInMs, 500);
  equal(
    await kv
      .atomic()
      .check({ key: ["owner"], versionstamp: null })
      .set(["owner"], "x")
      .commit(),
    { ok: false, versionstamp: null },
  );
  const entries = await collect(
    kv.list<string>({ start: ["outbox", 2], end: ["outbox", 100] }, { limit: 1 }),
  );
  equal(
    entries.map((entry) => entry.value),
    ["event-2"],
  );
  equal(
    calls.filter((call) => call.path === "/kv/list").map((call) => call.body.prefix),
    [["outbox"], ["outbox"]],
  );
  ok(calls.every((call) => !JSON.stringify(call.body).includes("must-not-leak")));
});

test("D1 adapter throws service/auth errors rather than misreporting CAS conflicts", async () => {
  const kv = new UbqKv({
    url: "https://kv.invalid",
    token: "offline",
    fetchImpl: async () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 }),
  });
  await rejects(() => kv.atomic().set(["key"], 1).commit(), /uos_kv_request_failed/);
});

test("D1 deep prefix stays inside Checkout root and filters unrelated Checkout pages", async () => {
  const root = ["uos_checkout", "v1"];
  const prefix = [...root, "merchant_auth", "merchants"];
  const calls: Record<string, unknown>[] = [];
  const kv = new UbqKv({
    url: "https://kv.invalid",
    token: "offline",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      equal(body.prefix, root);
      const values = body.cursor
        ? [{ key: [...prefix, "b"], value: { id: "b" }, versionstamp: "2" }]
        : [
            { key: [...root, "payments", "events", "x"], value: "must-filter", versionstamp: "1" },
            { key: [...prefix, "a"], value: { id: "a" }, versionstamp: "1" },
          ];
      return Response.json({ ok: true, entries: values, cursor: body.cursor ? null : "next" });
    },
  });
  equal(
    (await collect(kv.list<{ id: string }>({ prefix }, { limit: 1 }))).map((entry) => entry.value),
    [{ id: "a" }],
  );
  equal(calls.length, 2);
});

test("D1 atomic checks project decoded bigint entries to wire keys and versions", async () => {
  const invoiceKey = ["uos_checkout", "v1", "payments", "invoices", "offline"];
  const cursorKey = [
    "uos_checkout",
    "v1",
    "payments",
    "invoice_reconciliation_cursors",
    8453,
    "offline",
  ];
  const values = new Map<string, unknown>([
    [JSON.stringify(invoiceKey), { paidAmountUnits: 123n, minimumBlock: 101n }],
    [JSON.stringify(cursorKey), { blockNumber: 100n }],
  ]);
  let versionstamp = "1";
  let commits = 0;
  const kv = new UbqKv({
    url: "https://kv.invalid",
    token: "offline",
    fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init.body));
      if (input.endsWith("/kv/get"))
        return Response.json({
          ok: true,
          entry: {
            key: body.key,
            value: encodeKvValue(values.get(JSON.stringify(body.key))),
            versionstamp,
          },
        });
      commits++;
      equal(body.checks, [
        { key: invoiceKey, versionstamp: "1" },
        { key: cursorKey, versionstamp: "1" },
      ]);
      if (versionstamp !== "1") return Response.json({ ok: false });
      versionstamp = "2";
      return Response.json({ ok: true, versionstamp });
    },
  });
  const invoice = await kv.get(invoiceKey);
  const cursor = await kv.get(cursorKey);
  const updated = { paidAmountUnits: 123n, minimumBlock: 101n, status: "confirming" };
  equal(
    await kv
      .atomic()
      .check(invoice, cursor)
      .set(invoiceKey, updated)
      .set(cursorKey, { blockNumber: 200n })
      .commit(),
    { ok: true, versionstamp: "2" },
  );
  equal(await kv.atomic().check(invoice, cursor).set(invoiceKey, updated).commit(), {
    ok: false,
    versionstamp: null,
  });
  equal(commits, 2);
});
