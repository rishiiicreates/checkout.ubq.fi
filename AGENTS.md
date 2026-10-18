# Ubiquity Checkout Guidance

- Use Bun 1.4.0, TypeScript, and Web APIs for application development, scripts, and tests. Production runs in Cloudflare Workers (`workerd`), so keep Bun-only modules outside the Worker import graph.
- Use the pinned Bun lockfile and `bun install --frozen-lockfile`. Supported Node is permitted only for Cloudflare's Wrangler/Miniflare tooling; it is not an application runtime.
- Treat Workers as stateless. Persist authoritative cross-request state through the existing `UOS_KV` service binding to `ubq-kv`, using the existing Checkout keyspace and token. Do not provision a replacement database or rotate the signing key during runtime migrations.
- Use isolated Bun SQLite databases for local development and offline tests. Keep the portable KV contract independent of runtime globals.
- Represent token amounts as integer base units with `bigint`; serialize public amounts as decimal strings. Preserve the versioned Checkout storage codec and legacy JSON reads.
- Never expose merchant keys, signing keys, or treasury administration credentials to browser code.
- Browser RPC observations are hints. The server independently verifies every payment against the canonical token log and block state before emitting a signed event.
- Worker webhook delivery uses the original HTTPS hostname, public DNS validation, platform public egress enforcement (`global_fetch_strictly_public` and `no_cots_on_external_fetch`), fresh headers, a bounded abort signal, and no redirect replay. Bun delivery additionally verifies the connected peer against the validated DNS result set before writing application bytes.
- Keep default tests fully offline with isolated storage and mocked upstream services. The workerd harness must exercise the Worker entry and its configured compatibility flags.
- Keep Workers Free compatibility: no paid resource bindings and bounded subrequests. Chain push detects payments. No cron, interval sweep, periodic backstop/retention/repair, discovery alarm, or chain-ingress drain alarm exists in any runtime. Expiry owns one finite captured-range backup pass; known-payment sealed/safe/finalized milestones and merchant retries own their due jobs. A final confirmation miss waits for a related event. Use SQLite DOs or the durable local KV delayed queue, recovering only on startup, related requests/writes, or the original work alarm.
- Derive local development trust only from the Bun listener's actual socket. The Worker always strips the internal peer marker.
- Use `uos` for internal identifiers. Public domains and required deployment slugs may contain `ubq.fi`.
- Do not include `"ok": true` in public API responses; successful HTTP status codes indicate success. Preserve the existing private KV service wire protocol.
- Read `DECISIONS.md` before changing runtime, persistence, trust, deployment, or maintenance behavior.
- Run `bun run check` before committing. Deployment also requires `bun run deploy:dry-run` and the requested live acceptance.
