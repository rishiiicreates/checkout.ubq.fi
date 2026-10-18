import { type Clock, systemClock } from "./payment_catalog.ts";

const WORK_PREFIX: Deno.KvKey = ["uos_checkout", "v1", "work"];
const LEASE_MS = 60_000;
const WAKE_TYPE = "uos_checkout_work";

export type WorkType = "reconcile_invoice" | "expire_invoice" | "deliver_event";
export type WorkRecord = {
  type: WorkType;
  id: string;
  dueAt: number;
  attempts: number;
  leaseId?: string;
  leaseUntil?: number;
};

export function workKey(type: WorkType, id: string): Deno.KvKey {
  return [...WORK_PREFIX, type, id];
}

export function putWork(
  atomic: Deno.AtomicOperation,
  work: WorkRecord,
  now: number,
): Deno.AtomicOperation {
  atomic = atomic.set(workKey(work.type, work.id), work);
  // The hosted D1 adapter deliberately has no queue API. Native KV can persist
  // the wake in the same transaction, including a wake for abandoned leases.
  if (typeof atomic.enqueue === "function") {
    atomic = atomic.enqueue({ type: WAKE_TYPE, key: workKey(work.type, work.id) }, {
      delay: Math.max(0, availableAt(work) - now),
    });
  }
  return atomic;
}

export function scheduleWork(
  atomic: Deno.AtomicOperation,
  type: WorkType,
  id: string,
  dueAt: number,
  now: number,
): Deno.AtomicOperation {
  return putWork(atomic, { type, id, dueAt, attempts: 0 }, now);
}

export type WorkQueue = ReturnType<typeof createWorkQueue>;

export function createWorkQueue(options: {
  kv: Deno.Kv;
  handle: (work: WorkRecord) => Promise<number | undefined>;
  clock?: Clock;
  setTimer?: (callback: () => void, delay: number) => number;
  clearTimer?: (timer: number) => void;
  onError?: (error: unknown) => void;
}) {
  const { kv, handle } = options;
  const clock = options.clock ?? systemClock;
  const setTimer = options.setTimer ??
    ((callback: () => void, delay: number) => Number(setTimeout(callback, delay)));
  const clearTimer = options.clearTimer ?? clearTimeout;
  const onError = options.onError ?? ((error) => console.error("checkout_work_failed", error));
  const native = typeof kv.listenQueue === "function" && typeof kv.enqueue === "function" &&
    typeof kv.atomic().enqueue === "function";
  type Lifecycle = {
    started: boolean;
    stopped: boolean;
    notified: boolean;
    timer?: number;
    pumping?: Promise<void>;
    starting?: Promise<void>;
    stopping?: Promise<void>;
    active: Set<Promise<void>>;
  };
  const newLifecycle = (): Lifecycle => ({
    started: false,
    stopped: false,
    notified: false,
    active: new Set(),
  });
  let lifecycle = newLifecycle();
  let listener: Promise<void> | undefined;

  function current(run: Lifecycle): boolean {
    return lifecycle === run && !run.stopped;
  }

  async function entries(run: Lifecycle): Promise<Deno.KvEntry<WorkRecord>[]> {
    if (!current(run)) return [];
    const result: Deno.KvEntry<WorkRecord>[] = [];
    for await (const entry of kv.list<WorkRecord>({ prefix: WORK_PREFIX })) {
      if (!current(run)) return [];
      result.push(entry);
    }
    return result.sort((a, b) =>
      availableAt(a.value) - availableAt(b.value) ||
      a.value.id.localeCompare(b.value.id)
    );
  }

  function retry(run: Lifecycle): void {
    if (!current(run) || !run.started) return;
    if (run.timer !== undefined) clearTimer(run.timer);
    run.timer = setTimer(() => {
      if (!current(run)) return;
      run.timer = undefined;
      notify(run);
    }, LEASE_MS);
  }

  function notify(run = lifecycle): void {
    if (!current(run) || !run.started || native) return;
    run.notified = true;
    if (run.pumping) return;
    run.pumping = (async () => {
      while (run.notified && current(run)) {
        run.notified = false;
        if (run.timer !== undefined) clearTimer(run.timer);
        run.timer = undefined;
        const next = (await entries(run))[0];
        if (!current(run) || !next) return;
        const delay = Math.max(0, availableAt(next.value) - clock.now().getTime());
        run.timer = setTimer(() => {
          if (!current(run)) return;
          run.timer = undefined;
          runDue(undefined, run).then(() => notify(run), (error) => {
            if (!current(run)) return;
            onError(error);
            retry(run);
          });
        }, Math.min(delay, 2_147_483_647));
      }
    })().catch((error) => {
      if (!current(run)) return;
      onError(error);
      retry(run);
    }).finally(() => {
      run.pumping = undefined;
      if (current(run) && run.notified) notify(run);
    });
  }

  function runDue(key?: Deno.KvKey, run = lifecycle): Promise<void> {
    if (!current(run)) return Promise.resolve();
    const operation = drainDue(run, key);
    run.active.add(operation);
    operation.then(() => run.active.delete(operation), () => run.active.delete(operation));
    return operation;
  }

  async function drainDue(run: Lifecycle, key?: Deno.KvKey): Promise<void> {
    const keys = key ? [key] : (await entries(run)).slice(0, 100).map((entry) => entry.key);
    for (const candidate of keys) {
      if (!current(run)) return;
      const entry = await kv.get<WorkRecord>(candidate);
      if (!current(run)) return;
      const now = clock.now().getTime();
      if (!entry.value || availableAt(entry.value) > now) continue;
      const leased: WorkRecord = {
        ...entry.value,
        leaseId: crypto.randomUUID(),
        leaseUntil: now + LEASE_MS,
      };
      if (!(await putWork(kv.atomic().check(entry), leased, now).commit()).ok) continue;
      if (!current(run)) return;
      // D1 has no native lease wake. Keep the next persisted due time armed
      // independently of this handler, including recovery if it never settles.
      notify(run);
      let nextDue: number | undefined;
      try {
        nextDue = await handle(leased);
      } catch (error) {
        if (!current(run)) return;
        onError(error);
        nextDue = clock.now().getTime() +
          Math.min(60_000 * 2 ** Math.min(leased.attempts, 10), 30 * 60_000);
      }
      if (!current(run)) return;
      const currentEntry = await kv.get<WorkRecord>(entry.key);
      if (!current(run)) return;
      if (currentEntry.value?.leaseId !== leased.leaseId) continue;
      let atomic = kv.atomic().check(currentEntry);
      if (nextDue === undefined) {
        atomic = atomic.delete(entry.key);
      } else {
        atomic = putWork(atomic, {
          type: leased.type,
          id: leased.id,
          dueAt: nextDue,
          attempts: leased.attempts + 1,
        }, clock.now().getTime());
      }
      await atomic.commit();
    }
  }

  return {
    notify: () => notify(),
    runDue: (key?: Deno.KvKey) => runDue(key),
    start(recover: () => Promise<void> = () => Promise.resolve()): Promise<void> {
      if (!lifecycle.stopped && lifecycle.starting) return lifecycle.starting;
      if (lifecycle.started) return Promise.resolve();
      const previous = lifecycle;
      const previousStop = previous.stopping;
      const run = previous.stopped ? newLifecycle() : previous;
      lifecycle = run;
      run.starting = Promise.resolve().then(async () => {
        if (previousStop) await previousStop;
        if (!current(run)) return;
        await recover();
        if (!current(run)) return;
        run.started = true;
        if (!native) {
          notify(run);
          return;
        }
        listener ??= kv.listenQueue(async (message) => {
          const run = lifecycle;
          // Startup rearms every persisted record with a keyed wake, covering
          // older unkeyed messages without scanning the backlog for each one.
          if (
            current(run) && run.started && message?.type === WAKE_TYPE &&
            Array.isArray(message.key) &&
            message.key.length === WORK_PREFIX.length + 2 &&
            WORK_PREFIX.every((part, index) => message.key[index] === part) &&
            typeof message.key[3] === "string" && typeof message.key[4] === "string"
          ) await runDue(message.key, run);
        }).catch((error) => {
          if (current(lifecycle) && lifecycle.started) onError(error);
        });
        for (const entry of await entries(run)) {
          if (!current(run)) return;
          await putWork(kv.atomic().check(entry), entry.value, clock.now().getTime()).commit();
        }
      }).catch((error) => {
        run.started = false;
        throw error;
      }).finally(() => {
        run.starting = undefined;
      });
      return run.starting;
    },
    stop(): Promise<void> {
      const run = lifecycle;
      run.stopped = true;
      run.started = false;
      run.notified = false;
      if (run.timer !== undefined) clearTimer(run.timer);
      run.timer = undefined;
      return run.stopping ??= Promise.allSettled([
        run.starting,
        run.pumping,
        ...run.active,
      ]).then(() => {});
    },
    // Native listenQueue belongs to the KV lifetime. Close KV before awaiting
    // this during shutdown; stopping this scheduler never closes a shared store.
    settled: () => listener ?? Promise.resolve(),
  };
}

function availableAt(work: WorkRecord): number {
  return Math.max(work.dueAt, work.leaseUntil ?? 0);
}
