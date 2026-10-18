import { assert, assertEquals } from "@std/assert";
import { JsonKvService } from "./kv_test_fixture.ts";
import { UbqKv } from "./ubq_kv.ts";
import { createWorkQueue, putWork, scheduleWork, workKey, type WorkRecord } from "./work_queue.ts";

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

Deno.test("D1 recovery wakes deliver and expire unrelated jobs while an invoice handler stalls", async () => {
  const store = new JsonKvService();
  const kv = new UbqKv({
    url: "https://kv.example",
    token: "offline",
    fetchImpl: store.fetch,
  }) as unknown as Deno.Kv;
  let now = 0;
  let invoiceCalls = 0;
  const completed: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
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
    handle: async (work) => {
      if (work.id === "stalled") {
        invoiceCalls++;
        if (invoiceCalls === 1) {
          entered.resolve();
          await release.promise;
          return now + 60_000;
        }
      }
      completed.push(work.id);
      return undefined;
    },
  });
  try {
    await scheduleWork(kv.atomic(), "reconcile_invoice", "stalled", 0, now).commit();
    await scheduleWork(kv.atomic(), "deliver_event", "delivery", 1_000, now).commit();
    await scheduleWork(kv.atomic(), "expire_invoice", "expiry", 2_000, now).commit();
    await queue.start();
    await tick();
    fire(timers);
    await entered.promise;
    await tick();
    assertEquals(timers.size, 1, "a running handler must retain an independent recovery wake");
    assertEquals([...timers.values()][0].delay, 1_000);
    now = 1_000;
    fire(timers);
    await tick();
    assertEquals(completed, ["delivery"]);
    now = 2_000;
    fire(timers);
    await tick();
    assertEquals(completed, ["delivery", "expiry"]);
    assertEquals(invoiceCalls, 1);
    assertEquals([...timers.values()][0].delay, 58_000);
    now = 60_000;
    fire(timers);
    await tick();
    assertEquals(
      invoiceCalls,
      2,
      "the persisted lease recovers without another request or restart",
    );
    assertEquals(completed, ["delivery", "expiry", "stalled"]);
    assertEquals(timers.size, 0);
    assertEquals(store.records.size, 0);
  } finally {
    release.resolve();
    await queue.stop();
  }
  assertEquals(store.records.size, 0, "the stale handler cannot recreate completed work");
  assertEquals(timers.size, 0);
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

Deno.test("native KV wakes use bounded reads per retained job, including abandoned leases", async () => {
  const kv = await Deno.openKv(":memory:");
  const jobs = 100;
  const released = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  let listed = 0;
  let reads = 0;
  let messages = 0;
  let calls = 0;
  const errors: unknown[] = [];
  const instrumented = new Proxy(kv, {
    get(target, property) {
      if (property === "list") {
        return async function* (selector: Deno.KvListSelector) {
          for await (const entry of target.list(selector)) {
            listed++;
            yield entry;
          }
        };
      }
      if (property === "get") {
        return (key: Deno.KvKey) => {
          reads++;
          return target.get(key);
        };
      }
      if (property === "listenQueue") {
        return (handler: (message: unknown) => Promise<void>) =>
          target.listenQueue(async (message) => {
            await released.promise;
            await handler(message);
            if (++messages === jobs * 2) drained.resolve();
          });
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const queue = createWorkQueue({
    kv: instrumented,
    handle: () => {
      calls++;
      return Promise.resolve(Date.now() + 24 * 60 * 60_000);
    },
    onError: (error) => errors.push(error),
  });
  const deadline = setTimeout(() => drained.reject(new Error("native wakes stalled")), 10_000);
  try {
    const now = Date.now();
    for (let index = 0; index < jobs; index++) {
      const work: WorkRecord = {
        type: "deliver_event",
        id: `retained-${index}`,
        dueAt: now,
        attempts: 0,
        ...(index === 0 ? { leaseId: "abandoned", leaseUntil: now + 50 } : {}),
      };
      if (index % 2 === 0) {
        // Old instances persisted unkeyed wakes. Startup must replace them with
        // keyed wakes, including the remaining time on an abandoned lease.
        await kv.atomic().set(workKey(work.type, work.id), work).enqueue({
          type: "uos_checkout_work",
        }, { delay: Math.max(0, (work.leaseUntil ?? now) - now) }).commit();
      } else {
        await putWork(kv.atomic(), work, now).commit();
      }
    }
    await queue.start();
    released.resolve();
    await drained.promise;
    await queue.stop();
    assertEquals(calls, jobs);
    assertEquals(errors, []);
    const retained = [];
    for await (const entry of kv.list<WorkRecord>({ prefix: ["uos_checkout", "v1", "work"] })) {
      retained.push(entry.value);
    }
    assertEquals(retained.length, jobs);
    assert(retained.every((work) => work.attempts === 1 && work.dueAt > Date.now()));
    console.log("native_read_amplification", { jobs, messages, calls, listed, reads });
    assert(listed <= jobs, `native wakes listed ${listed} records for ${jobs} retained jobs`);
    assert(reads <= jobs * 3, `native wakes read ${reads} records for ${jobs} retained jobs`);
  } finally {
    clearTimeout(deadline);
    released.resolve();
    await queue.stop();
    kv.close();
    await queue.settled();
  }
});

Deno.test("native duplicate keyed wakes preserve an active handler lease", async () => {
  const kv = await Deno.openKv(":memory:");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const skipped = Promise.withResolvers<void>();
  const timedOut = Promise.withResolvers<never>();
  let calls = 0;
  const instrumented = new Proxy(kv, {
    get(target, property) {
      if (property === "get") {
        return async (key: Deno.KvKey) => {
          const entry = await target.get<WorkRecord>(key);
          if (entry.value?.leaseId) skipped.resolve();
          return entry;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const queue = createWorkQueue({
    kv: instrumented,
    handle: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return undefined;
    },
  });
  const deadline = setTimeout(
    () => timedOut.reject(new Error("native lease wake stalled")),
    10_000,
  );
  const key = workKey("deliver_event", "active-lease");
  try {
    await queue.start();
    await scheduleWork(kv.atomic(), "deliver_event", "active-lease", Date.now(), Date.now())
      .commit();
    await Promise.race([entered.promise, timedOut.promise]);
    const leased = await kv.get<WorkRecord>(key);
    assert(leased.value?.leaseId);
    await kv.enqueue({ type: "uos_checkout_work", key });
    await Promise.race([skipped.promise, timedOut.promise]);
    assertEquals(calls, 1);
    assertEquals((await kv.get<WorkRecord>(key)).value?.leaseId, leased.value.leaseId);
    release.resolve();
    await queue.stop();
    assertEquals(calls, 1);
    assertEquals(
      (await kv.get<WorkRecord>(key)).value?.leaseId,
      leased.value.leaseId,
      "shutdown retains the unfinished lease for recovery",
    );
  } finally {
    clearTimeout(deadline);
    release.resolve();
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

for (const boundary of ["list", "get", "lease", "handler", "completion_get", "completion_commit"]) {
  Deno.test(`queue shutdown fences the ${boundary} continuation`, async () => {
    const fixture = lifecycleFixture({ boundary });
    await fixture.seed();
    const running = fixture.queue.runDue();
    await fixture.entered.promise;
    const requests = fixture.store.requests;
    let stopped = false;
    const stopping = fixture.queue.stop().then(() => {
      stopped = true;
    });
    await tick();
    assertEquals(stopped, false, "shutdown waits for its in-flight operation");
    fixture.release.resolve();
    await Promise.all([running, stopping]);
    assertEquals(
      fixture.calls(),
      boundary.startsWith("completion") || boundary === "handler" ? 1 : 0,
    );
    assertEquals(
      fixture.store.requests,
      requests,
      "no later store operation starts after shutdown",
    );
    assertEquals(fixture.timers.size, 0);
    await fixture.queue.runDue();
    fixture.queue.notify();
    assertEquals(fixture.store.requests, requests, "stopped manual drains remain inert");
  });
}

Deno.test("queue shutdown does not arm a timer after a blocked notification scan", async () => {
  const fixture = lifecycleFixture({ boundary: "list" });
  await fixture.seed();
  await fixture.queue.start();
  await fixture.entered.promise;
  const requests = fixture.store.requests;
  const stopping = fixture.queue.stop();
  fixture.release.resolve();
  await stopping;
  assertEquals(fixture.timers.size, 0);
  assertEquals(fixture.calls(), 0);
  assertEquals(fixture.store.requests, requests);
});

Deno.test("queue concurrent starts share recovery and shutdown fences pending startup", async () => {
  const fixture = lifecycleFixture();
  const recovery = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let recoveries = 0;
  const recover = () => {
    recoveries++;
    entered.resolve();
    return recovery.promise;
  };
  const starting = fixture.queue.start(recover);
  await entered.promise;
  const duplicate = fixture.queue.start(recover);
  let stopped = false;
  const stopping = fixture.queue.stop().then(() => {
    stopped = true;
  });
  await tick();
  const stoppedBeforeRecovery = stopped;
  recovery.resolve();
  await Promise.all([starting, duplicate, stopping]);
  assertEquals(stoppedBeforeRecovery, false);
  assertEquals(recoveries, 1);
  assertEquals(fixture.store.requests, 0);
  assertEquals(fixture.timers.size, 0);
  await fixture.queue.runDue();
  assertEquals(fixture.store.requests, 0);
});

for (const boundary of ["list", "lease"]) {
  Deno.test(`native startup shutdown fences the ${boundary} continuation`, async () => {
    const fixture = lifecycleFixture({ boundary, native: true });
    await fixture.seed();
    const starting = fixture.queue.start();
    await fixture.entered.promise;
    const requests = fixture.store.requests;
    let stopped = false;
    const stopping = fixture.queue.stop().then(() => {
      stopped = true;
    });
    await tick();
    const stoppedBeforeStartup = stopped;
    fixture.release.resolve();
    await Promise.all([starting, stopping]);
    assertEquals(stoppedBeforeStartup, false);
    assertEquals(fixture.store.requests, requests);
    assertEquals(fixture.calls(), 0);
    fixture.listener.resolve();
    await fixture.queue.settled();
  });
}

Deno.test("stale timer callbacks cannot drain or replace a restarted lifecycle timer", async () => {
  const fixture = lifecycleFixture();
  await fixture.seed();
  await fixture.queue.start();
  await tick();
  const stale = [...fixture.timers.values()][0].callback;
  await fixture.queue.stop();
  await fixture.queue.start();
  await tick();
  const requests = fixture.store.requests;
  const current = [...fixture.timers.keys()];
  stale();
  await tick();
  await fixture.queue.stop();
  assertEquals(fixture.calls(), 0);
  assertEquals(fixture.store.requests, requests);
  assertEquals(current.length, 1);
  assertEquals(fixture.timers.size, 0);
});

Deno.test("native restarts retain one listener and ignore stopped keyed wakes", async () => {
  const fixture = lifecycleFixture({ native: true });
  await fixture.queue.start();
  await fixture.queue.stop();
  const requests = fixture.store.requests;
  await fixture.wake();
  assertEquals(fixture.store.requests, requests);
  await fixture.queue.start();
  await fixture.queue.stop();
  assertEquals(fixture.listeners(), 1);
  fixture.listener.resolve();
  await fixture.queue.settled();
});

Deno.test("same-turn start and stop settle without beginning recovery", async () => {
  const fixture = lifecycleFixture();
  let recoveries = 0;
  const starting = fixture.queue.start(() => {
    recoveries++;
    return Promise.resolve();
  });
  const stopping = fixture.queue.stop();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([starting, stopping]),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("startup shutdown deadlocked")), 1_000);
      }),
    ]);
    assertEquals(recoveries, 0);
    assertEquals(fixture.store.requests, 0);
  } finally {
    clearTimeout(deadline);
  }
});

Deno.test("native restart fences an admitted old wake and accepts new keyed wakes", async () => {
  const fixture = lifecycleFixture({ native: true, boundary: "get" });
  await fixture.seed();
  await fixture.queue.start();
  const stale = fixture.wake();
  await fixture.entered.promise;
  const stopping = fixture.queue.stop();
  const restarting = fixture.queue.start();
  fixture.release.resolve();
  await Promise.all([stale, stopping, restarting]);
  assertEquals(fixture.calls(), 0);
  await fixture.wake();
  assertEquals(fixture.calls(), 1);
  await fixture.queue.stop();
  assertEquals(fixture.listeners(), 1);
  fixture.listener.resolve();
  await fixture.queue.settled();
});

function lifecycleFixture(options: { boundary?: string; native?: boolean } = {}) {
  const store = new JsonKvService();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const listener = Promise.withResolvers<void>();
  let gets = 0;
  let commits = 0;
  let calls = 0;
  let listeners = 0;
  let onMessage: ((message: unknown) => Promise<void>) | undefined;
  const client = new UbqKv({
    url: "https://kv.example",
    token: "offline",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const response = await store.fetch(request);
      if (path === "/kv/get") gets++;
      if (path === "/kv/atomic") commits++;
      if (
        (options.boundary === "list" && path === "/kv/list") ||
        (options.boundary === "get" && path === "/kv/get" && gets === 1) ||
        (options.boundary === "completion_get" && path === "/kv/get" && gets === 2) ||
        (options.boundary === "lease" && path === "/kv/atomic" && commits === 1) ||
        (options.boundary === "completion_commit" && path === "/kv/atomic" && commits === 2)
      ) {
        entered.resolve();
        await release.promise;
      }
      return response;
    },
  });
  const kv = (options.native
    ? new Proxy(client, {
      get(target, property) {
        if (property === "enqueue") return () => Promise.resolve();
        if (property === "listenQueue") {
          return (handler: (message: unknown) => Promise<void>) => {
            listeners++;
            onMessage = handler;
            return listener.promise;
          };
        }
        if (property === "atomic") {
          return () => {
            const atomic = target.atomic();
            return Object.assign(atomic, { enqueue: () => atomic });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
    : client) as unknown as Deno.Kv;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const queue = createWorkQueue({
    kv,
    clock: { now: () => new Date(0) },
    setTimer: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    handle: async () => {
      calls++;
      if (options.boundary === "handler") {
        entered.resolve();
        await release.promise;
      }
      return undefined;
    },
  });
  return {
    store,
    queue,
    timers,
    entered,
    release,
    listener,
    calls: () => calls,
    listeners: () => listeners,
    wake: () => onMessage?.({ type: "uos_checkout_work", key: workKey("deliver_event", "a") }),
    seed: async () => {
      for (const id of ["a", "b"]) {
        await kv.set(
          workKey("deliver_event", id),
          {
            type: "deliver_event",
            id,
            dueAt: 0,
            attempts: 0,
          } satisfies WorkRecord,
        );
      }
      // Boundary counters exclude fixture preparation.
      store.requests = 0;
    },
  };
}
