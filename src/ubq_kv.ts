/**
 * Client for the UBQ KV service (kv-service/): a Deno-KV-shaped store on
 * Cloudflare D1. The auth hub selects it with AUTH_KV_SERVICE_URL +
 * AUTH_KV_SERVICE_TOKEN; unset keeps the local sqlite/remote Deno KV default.
 *
 * Only the Deno.Kv surface the hub uses is implemented: get, getMany, set,
 * delete, list, and atomic (check/set/delete/commit). Keys are strings,
 * numbers, or booleans, matching the hub's stored keys.
 */

export type UbqKvKey = readonly (string | number | boolean)[];

export type UbqKvEntryMaybe<T> = {
  key: UbqKvKey;
  value: T | null;
  versionstamp: string | null;
};

export type UbqKvListSelector = { prefix?: UbqKvKey };

type WireEntry = { key: UbqKvKey; value: unknown; versionstamp: string };

type CheckInput = { key: UbqKvKey; versionstamp: string | null };

const REQUEST_TIMEOUT_MS = 15_000;

export class UbqKvAtomic {
  private readonly checks: CheckInput[] = [];
  private readonly mutations: Array<
    { type: "set" | "delete"; key: UbqKvKey; value?: unknown; expireInMs?: number }
  > = [];

  constructor(private readonly client: UbqKv) {}

  check(...entries: CheckInput[]): this {
    this.checks.push(...entries);
    return this;
  }

  set(key: UbqKvKey, value: unknown, options?: { expireIn?: number }): this {
    this.mutations.push({ type: "set", key, value, expireInMs: options?.expireIn });
    return this;
  }

  delete(key: UbqKvKey): this {
    this.mutations.push({ type: "delete", key });
    return this;
  }

  async commit(): Promise<{ ok: boolean; versionstamp: string | null }> {
    const result = await this.client.request<{ ok: boolean; versionstamp?: string }>(
      "/kv/atomic",
      {
        checks: this.checks.map((check) => ({
          key: check.key,
          versionstamp: check.versionstamp,
        })),
        mutations: this.mutations,
      },
    );
    if (!result.ok) return { ok: false, versionstamp: null };
    return { ok: true, versionstamp: result.versionstamp ?? null };
  }
}

export class UbqKv {
  constructor(
    private readonly options: {
      url: string;
      token: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch;
  }

  async request<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.options.url.replace(/\/$/, "")}${path}`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      message?: string;
    } & Record<string, unknown>;
    if (!response.ok || payload.ok !== true) {
      throw new Error(
        `ubq_kv_request_failed:${path}:${response.status}:${payload.error ?? "unknown"}`,
      );
    }
    return payload as T;
  }

  async get<T>(key: UbqKvKey): Promise<UbqKvEntryMaybe<T>> {
    const result = await this.request<{ entry: WireEntry | null }>("/kv/get", { key });
    return toEntryMaybe<T>(key, result.entry);
  }

  async getMany<T>(keys: UbqKvKey[]): Promise<UbqKvEntryMaybe<T>[]> {
    if (keys.length === 0) return [];
    const result = await this.request<{ entries: (WireEntry | null)[] }>("/kv/getMany", {
      keys,
    });
    return result.entries.map((entry, index) => toEntryMaybe<T>(keys[index], entry));
  }

  async set(
    key: UbqKvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ ok: true; versionstamp: string }> {
    const result = await this.request<{ versionstamp: string }>("/kv/set", {
      key,
      value,
      expireInMs: options?.expireIn,
    });
    return { ok: true, versionstamp: result.versionstamp };
  }

  async delete(key: UbqKvKey): Promise<void> {
    await this.request("/kv/delete", { key });
  }

  list<T>(
    selector: UbqKvListSelector = {},
    options?: { limit?: number },
  ): AsyncIterableIterator<UbqKvEntryMaybe<T>> {
    const iterator = this.listEntries<T>(selector, options);
    return iterator[Symbol.asyncIterator]();
  }

  private async *listEntries<T>(
    selector: UbqKvListSelector,
    options?: { limit?: number },
  ): AsyncIterableIterator<UbqKvEntryMaybe<T>> {
    let cursor: string | null = null;
    let remaining = options?.limit ?? Number.POSITIVE_INFINITY;
    while (remaining > 0) {
      const pageSize = Math.min(remaining, 100);
      const page: { entries: WireEntry[]; cursor: string | null } = await this.request<
        { entries: WireEntry[]; cursor: string | null }
      >("/kv/list", {
        prefix: selector.prefix,
        limit: pageSize,
        cursor: cursor ?? undefined,
      });
      for (const entry of page.entries) {
        yield {
          key: entry.key,
          value: entry.value as T,
          versionstamp: entry.versionstamp,
        };
        remaining -= 1;
        if (remaining <= 0) return;
      }
      cursor = page.cursor;
      if (!cursor || page.entries.length === 0) return;
    }
  }

  atomic(): UbqKvAtomic {
    return new UbqKvAtomic(this);
  }
}

function toEntryMaybe<T>(key: UbqKvKey, entry: WireEntry | null): UbqKvEntryMaybe<T> {
  if (!entry) return { key, value: null, versionstamp: null };
  return { key: entry.key, value: entry.value as T, versionstamp: entry.versionstamp };
}
