import { assertEquals } from "@std/assert";
import { JsonKvService } from "./kv_test_fixture.ts";
import { UbqKv } from "./ubq_kv.ts";
import { createWorkQueue, scheduleWork, workKey, type WorkRecord } from "./work_queue.ts";

Deno.test("D1-shaped durable queue uses one due timer, retries, and stays idle after completion", async () => {
  const store = new JsonKvService();
  const kv = new UbqKv({
    url: "https://kv.example",
    token: "offline",
    fetchImpl: store.fetch,
  }) as unknown as Deno.Kv;
  let now = 0;
  let attempts = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const queue = createWorkQueue({
    kv,
    clock: { now: () => new Date(now) },
    setTimer: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    handle: () => {
      attempts++;
      if (attempts === 1) throw new Error("retryable offline failure");
      return Promise.resolve(undefined);
    },
    onError: () => {},
  });
  await queue.start();
  await tick();
  assertEquals(timers.size, 0);
  const idleRequests = store.requests;
  await tick();
  assertEquals(store.requests, idleRequests);
  await scheduleWork(kv.atomic(), "reconcile_invoice", "invoice", 1_000, now).commit();
  queue.notify();
  await tick();
  assertEquals(timers.size, 1);
  assertEquals([...timers.values()][0].delay, 1_000);
  now = 1_000;
  fire(timers);
  await tick();
  assertEquals(attempts, 1);
  assertEquals([...timers.values()][0].delay, 60_000);
  const persisted = (await kv.get<WorkRecord>(workKey("reconcile_invoice", "invoice"))).value;
  assertEquals(persisted?.attempts, 1);
  now += 60_000;
  fire(timers);
  await tick();
  assertEquals(attempts, 2);
  assertEquals(timers.size, 0);
  const completedRequests = store.requests;
  await tick();
  assertEquals(store.requests, completedRequests);
  assertEquals(store.records.size, 0);
  await queue.stop();
});

Deno.test("duplicate workers acquire one persisted lease and a restart recovers an abandoned lease", async () => {
  const kv = await Deno.openKv(":memory:");
  let now = 0;
  let calls = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const handler = async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return undefined;
  };
  const first = createWorkQueue({ kv, clock: { now: () => new Date(now) }, handle: handler });
  const second = createWorkQueue({ kv, clock: { now: () => new Date(now) }, handle: handler });
  try {
    await scheduleWork(kv.atomic(), "deliver_event", "event", 0, now).commit();
    const running = first.runDue();
    await entered.promise;
    await second.runDue();
    assertEquals(calls, 1);
    release.resolve();
    await running;
    await second.runDue();
    assertEquals(calls, 1);
    await kv.set(
      workKey("deliver_event", "abandoned"),
      {
        type: "deliver_event",
        id: "abandoned",
        dueAt: 0,
        attempts: 2,
        leaseId: "dead-worker",
        leaseUntil: 60_000,
      } satisfies WorkRecord,
    );
    await second.runDue();
    assertEquals(calls, 1);
    now = 60_000;
    await second.runDue();
    assertEquals(calls, 2);
    assertEquals((await kv.get(workKey("deliver_event", "abandoned"))).value, null);
  } finally {
    kv.close();
  }
});

Deno.test("native KV commits domain state, work, and durable wake atomically", async () => {
  const kv = await Deno.openKv(":memory:");
  const completed = Promise.withResolvers<void>();
  let calls = 0;
  const queue = createWorkQueue({
    kv,
    handle: async () => {
      assertEquals((await kv.get(["domain"])).value, "committed");
      calls++;
      completed.resolve();
      return undefined;
    },
  });
  try {
    await queue.start();
    await scheduleWork(
      kv.atomic().set(["domain"], "committed"),
      "deliver_event",
      "native",
      Date.now(),
      Date.now(),
    ).commit();
    await completed.promise;
    await queue.stop();
    assertEquals(calls, 1);
  } finally {
    await queue.stop();
    kv.close();
    await queue.settled();
  }
});

function fire(timers: Map<number, { callback: () => void; delay: number }>): void {
  assertEquals(timers.size, 1);
  const [id, timer] = [...timers][0];
  timers.delete(id);
  timer.callback();
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
