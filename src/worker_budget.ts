import type { FetchLike } from "./rpc.ts";

/** Leave headroom beneath the Free plan's 50-subrequest ceiling. */
export class WorkerRequestBudget {
  private used = 0;
  private held = 0;
  constructor(
    private readonly maximum: number,
    private readonly signal?: AbortSignal,
  ) {}
  get remaining(): number {
    return this.maximum - this.used - this.held;
  }
  hasCapacity(calls: number): boolean {
    return !this.signal?.aborted && this.remaining >= calls;
  }
  /** Keep persistence and the HTTP response possible after a search yields. */
  reserveForCompletion(calls: number): () => void {
    if (!this.hasCapacity(calls)) throw new WorkerBudgetError();
    this.held += calls;
    let released = false;
    return () => {
      if (!released) this.held -= calls;
      released = true;
    };
  }
  reserve(): void {
    this.signal?.throwIfAborted();
    if (this.remaining <= 0) throw new WorkerBudgetError();
    this.used++;
  }
  wrap(fetcher: FetchLike): FetchLike {
    return (input, init) => {
      this.reserve();
      const signals = [this.signal, init?.signal].filter((value): value is AbortSignal =>
        Boolean(value),
      );
      return fetcher(input, {
        ...init,
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      });
    };
  }
}

export class WorkerBudgetError extends Error {
  readonly status = 503;
  constructor() {
    super("worker_subrequest_budget_exhausted");
  }
}
