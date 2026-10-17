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
    atomic = atomic.enqueue({ type: WAKE_TYPE }, {
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
  let started = false;
  let timer: number | undefined;
  let pumping: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let listener: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  let notified = false;

  async function entries(): Promise<Deno.KvEntry<WorkRecord>[]> {
    const result: Deno.KvEntry<WorkRecord>[] = [];
    for await (const entry of kv.list<WorkRecord>({ prefix: WORK_PREFIX })) result.push(entry);
    return result.sort((a, b) =>
      availableAt(a.value) - availableAt(b.value) ||
      a.value.id.localeCompare(b.value.id)
    );
  }

  function notify(): void {
    if (!started || native) return;
    notified = true;
    if (pumping) return;
    pumping = (async () => {
      while (notified && started) {
        notified = false;
        if (timer !== undefined) clearTimer(timer);
        timer = undefined;
        const next = (await entries())[0];
        if (!next) return;
        const delay = Math.max(0, availableAt(next.value) - clock.now().getTime());
        timer = setTimer(() => {
          timer = undefined;
          draining = runDue();
          draining.then(notify, (error) => {
            onError(error);
            if (started) timer = setTimer(notify, LEASE_MS);
          });
        }, Math.min(delay, 2_147_483_647));
      }
    })().catch((error) => {
      onError(error);
      if (started) timer = setTimer(notify, LEASE_MS);
    }).finally(() => {
      pumping = undefined;
      if (notified) notify();
    });
  }

  function runDue(): Promise<void> {
    const operation = drainDue();
    active.add(operation);
    operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  }

  async function drainDue(): Promise<void> {
    for (const candidate of (await entries()).slice(0, 100)) {
      const entry = await kv.get<WorkRecord>(candidate.key);
      const now = clock.now().getTime();
      if (!entry.value || availableAt(entry.value) > now) continue;
      const leased: WorkRecord = {
        ...entry.value,
        leaseId: crypto.randomUUID(),
        leaseUntil: now + LEASE_MS,
      };
      if (!(await putWork(kv.atomic().check(entry), leased, now).commit()).ok) continue;
      let nextDue: number | undefined;
      try {
        nextDue = await handle(leased);
      } catch (error) {
        onError(error);
        nextDue = clock.now().getTime() +
          Math.min(60_000 * 2 ** Math.min(leased.attempts, 10), 30 * 60_000);
      }
      const current = await kv.get<WorkRecord>(entry.key);
      if (current.value?.leaseId !== leased.leaseId) continue;
      let atomic = kv.atomic().check(current);
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
    notify,
    runDue,
    async start(recover: () => Promise<void> = () => Promise.resolve()): Promise<void> {
      if (started) return;
      await recover();
      started = true;
      if (native) {
        listener = kv.listenQueue(async (message) => {
          if (started && message?.type === WAKE_TYPE) await runDue();
        }).catch((error) => {
          if (started) onError(error);
        });
        for (const entry of await entries()) {
          await putWork(kv.atomic().check(entry), entry.value, clock.now().getTime()).commit();
        }
      } else {
        notify();
      }
    },
    async stop(): Promise<void> {
      started = false;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      await pumping;
      await draining;
      await Promise.allSettled([...active]);
    },
    // Native listenQueue belongs to the KV lifetime. Close KV before awaiting
    // this during shutdown; stopping this scheduler never closes a shared store.
    settled: () => listener ?? Promise.resolve(),
  };
}

function availableAt(work: WorkRecord): number {
  return Math.max(work.dueAt, work.leaseUntil ?? 0);
}
