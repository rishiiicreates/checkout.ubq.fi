import { assert } from "@std/assert";

/** Offline implementation of the service's generic-JSON wire contract. */
export class JsonKvService {
  records = new Map<string, { key: unknown[]; value: unknown; versionstamp: string }>();
  requests = 0;
  revision = 0;

  seed(key: unknown[], value: unknown): void {
    this.records.set(JSON.stringify(key), { key, value, versionstamp: String(++this.revision) });
  }

  fetch: typeof fetch = async (input, init) => {
    this.requests++;
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = await request.json();
    const entry = (key: unknown[]) => this.records.get(JSON.stringify(key)) ?? null;
    const response = (value: object) => Response.json({ ok: true, ...value });
    if (path === "/kv/get") return response({ entry: entry(body.key) });
    if (path === "/kv/getMany") return response({ entries: body.keys.map(entry) });
    if (path === "/kv/list") {
      assert(Array.isArray(body.prefix));
      const entries = [...this.records.values()].filter((item) =>
        body.prefix.every((part: unknown, index: number) => item.key[index] === part)
      )
        .sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
      const start = body.cursor
        ? entries.findIndex((item) => JSON.stringify(item.key) === body.cursor) + 1
        : 0;
      const page = entries.slice(start, start + body.limit);
      return response({
        entries: page,
        cursor: start + page.length < entries.length ? JSON.stringify(page.at(-1)!.key) : null,
      });
    }
    if (path === "/kv/set") {
      this.seed(body.key, body.value);
      return response({ versionstamp: String(this.revision) });
    }
    if (path === "/kv/delete") {
      this.records.delete(JSON.stringify(body.key));
      return response({});
    }
    if (path === "/kv/atomic") {
      if (
        body.checks.some((check: { key: unknown[]; versionstamp: string | null }) =>
          (entry(check.key)?.versionstamp ?? null) !== check.versionstamp
        )
      ) return Response.json({ ok: false });
      const versionstamp = String(++this.revision);
      for (const mutation of body.mutations) {
        const key = JSON.stringify(mutation.key);
        if (mutation.type === "delete") this.records.delete(key);
        else this.records.set(key, { key: mutation.key, value: mutation.value, versionstamp });
      }
      return response({ versionstamp });
    }
    throw new Error(`unexpected offline KV path: ${path}`);
  };
}
