import type { FetchLike } from "./rpc.ts";

/** Leave headroom beneath the Free plan's 50-subrequest ceiling. */
export class WorkerRequestBudget {
  private used = 0;
  constructor(
    private readonly maximum: number,
    private readonly signal?: AbortSignal,
  ) {}
  reserve(): void {
    this.signal?.throwIfAborted();
    if (this.used >= this.maximum) throw new WorkerBudgetError();
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
