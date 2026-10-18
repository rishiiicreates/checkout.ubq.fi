# Deno to Bun and Workers Free migration blueprint

Apply this workflow to one explicitly selected active repository; return a working migration and its evidence.

Bun runs the application locally, scripts, dependency installation, and tests. Production Workers run in `workerd`. Supported Node is a narrow exception for official Cloudflare Wrangler/Miniflare tooling. Keep Bun-only APIs outside the Worker import graph, and keep the deployment within the explicitly authorized free resources.

## 1. Establish the repository contract

Read applicable instructions and the existing decision record. Identify the canonical branch, revision, active writers, dirty work, and release owner. Isolate the candidate and preserve unrelated work.

| Inventory             | Record before implementation                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and imports   | Entrypoints, Deno globals, Deno/JSR/npm imports, permissions, filesystem access, sockets/DNS, subprocesses, signals, environment reads, and top-level I/O.           |
| State semantics       | Namespaces, value schemas, key types/order, CAS checks, transaction groups, TTL, indexes, prefix/range/cursor behavior, list limits, and retry/progress records.     |
| Trust and interfaces  | Public origins, proxy/listener boundaries, internal headers, auth issuer/audience, callback URLs, merchant scopes, signing identity, and external service contracts. |
| Tooling and release   | Lockfile, exact quality gate, test discovery/timeouts, generated types, asset routes/headers, CI triggers, current deployment/route, and sole scheduler owner.       |
| Baseline and recovery | Public behavior, release identity, JWKS key ID, authenticated behavior, state binding identity, and a codec-compatible rollback target.                              |

Separate external dependencies from runtime code. Checkout retains its external Auth Hub origin and issuer, including their legacy hostname; migrating this repository does not migrate that authentication service or change its accepted claims.

Record runtime/storage/trust decisions and update AGENTS runtime policy and check commands. Verify version pins for the selected repository.

## 2. Split portable logic from runtime adapters

| Existing Deno surface        | Bun/local replacement                                                      | Worker replacement                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Deno.serve`                 | `Bun.serve`, actual `server.requestIP()`, owned `server.stop()` lifecycle. | Exported `fetch` handler with request-local services and generated binding types.                              |
| `Deno.openKv` and KV globals | Explicit store interface; isolated Bun SQLite adapter.                     | Existing transactional service/database adapter selected by semantics.                                         |
| Asset filesystem reads       | Inject a local asset reader.                                               | `ASSETS.fetch`, exact routes/HEAD behavior, preserved CSP/cache headers, and appropriate Worker-first routing. |
| Environment/arguments        | Explicit process/Bun configuration at the local entry.                     | Handler bindings; no import-time credential or I/O assumptions.                                                |
| DNS/TLS sockets              | Bun transport preserving required DNS, certificate, and peer checks.       | Native platform transport with its documented enforcement boundary and real runtime proof.                     |
| Cron/timers                  | Explicitly owned optional local timer.                                     | Awaited `scheduled` work with bounded durable progress.                                                        |
| Child processes/signals      | `Bun.spawn`, signal handlers, and complete cleanup.                        | Keep local demos/tool subprocesses outside the Worker runtime.                                                 |
| Tests and deployment scripts | Native `bun:test`, local helpers, locked Bun tooling.                      | Actual workerd tests and official Cloudflare packaging/deployment tooling.                                     |

Convert test objects/substeps and assertions while preserving isolation, timeouts, and cleanup. Replace obsolete deployment scripts/workflows.

Generate binding/runtime types from the final configuration. Inspect the packaged Worker and public assets: no SQLite/native socket/process modules in the Worker graph, and no credential files or private key material in browser assets.

## 3. Choose storage by behavior

| Requirement                                           | Suitable migration decision                                                                                               | Acceptance                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-key CAS or atomic ownership/payment transitions | Retain the proven transactional database/service and its namespace.                                                       | All checked keys and mutations succeed together; conflicts remain retryable outcomes rather than transport errors.                             |
| Expiry and ordered queries                            | Preserve TTL, typed tuple comparison, indexes, range boundaries, pagination, reverse/limit behavior, and value isolation. | Expired rows act absent in reads/checks; limits apply after selection; complete scans and empty pages behave correctly.                        |
| Bigint or structured values                           | Use a versioned, collision-safe codec and legacy reads.                                                                   | Nested values roundtrip without coercing arbitrary numeric strings; public amounts stay decimal strings.                                       |
| Rebuildable data with explicit stale-read tolerance   | Evaluate caching separately.                                                                                              | Eventual consistency must fit the data; Workers KV is not a replacement for transactional authoritative state merely because both APIs say KV. |

Checkout preserves `UOS_KV` → existing `ubq-kv`, its D1 state, Checkout namespace, owner/member and merchant records, invoices/events, and RS256 signing key. Its adapter handles the existing service's CAS response envelope, then applies typed range/filter/limit semantics across prefix pages.

Project the exact wire schema: a CAS check sends only `{ key, versionstamp }`, never a whole decoded entry. Review caught a bigint invoice value leaking into JSON serialization through `.check(entry)` even though SQLite tests passed. Exercise a positive payment claim/JWS/replay transition through the actual consumer adapter and service binding with isolated upstreams; local storage success does not prove wire compatibility.

Inventory real service limits before choosing scan strategies. Checkout's shared D1 LIKE pattern is limited to 50 bytes; a long derived prefix falls back only to the wholly Checkout-owned prefix before filtering. Never broaden a fallback into another application's state. Pagination and codec work consume I/O, CPU, and memory even when only one result is requested.

Stage a rollback release that reads both legacy and newly encoded values before the first new-format write. Checkout's migrated Bun release shares the Worker codec; the old adapter cannot safely resume after enveloped writes. Route rollback does not roll back database contents.

Preserve existing secret names and owning service boundaries. Bootstrap an absent Worker secret once from the existing protected value through stdin; later deployments retain it. Record public identifiers and bindings, never secret values. Local tests use isolated stores and fresh test keys.

## 4. Preserve ingress and HTTPS boundaries

Worker ingress strips the internal peer marker, including on forged localhost URLs. Bun derives development trust from the actual socket plus an allowed local HTTP origin. Test the production listener defaults: a dual-stack socket may report `::ffff:127.0.0.1` or `::ffff:7f00:1` even when an IPv4-only fixture passed. Normalize only exact recognized loopback forms; forwarded headers never grant development access.

If a local reverse proxy requires HTTPS-origin reconstruction, constrain it to the established peer, exact canonical Host, and exact forwarded scheme; retain normal authentication. Checkout accepts that reconstruction only from loopback with Host `checkout.ubq.fi` and `x-forwarded-proto: https`.

For Worker webhooks, retain public DNS validation, the original normalized HTTPS hostname, fresh application headers, bounded cancellation/response handling, and `redirect: "manual"`. A redirect is a failed delivery; signed bytes are never replayed to its target. This recipe explicitly retains `global_fetch_strictly_public` and `no_cots_on_external_fetch`.

Document the runtime distinction: Bun compares the connected peer with the approved DNS answer set before sending HTTP bytes; Worker native fetch relies on platform public-egress and TLS enforcement. Workers do not expose equivalent observed-peer pinning through `node:https` or outbound socket metadata.

Prove TLS behavior on the actual public entrypoint. Checkout's transport probe on both workers.dev and the canonical route returned 200 for valid controls and 526 for self-signed, wrong-host, expired, and same-zone invalid certificates while the zone used SSL Full. That proves those transport cases, separately from application deployment acceptance. Local workerd mocks cannot replace this check.

## 5. Make background progress durable under free limits

Confirm current limits and account-wide usage before adding schedules. The verified Workers Free reference has 10 ms CPU per invocation, 50 external subrequests, and 100,000 daily requests shared across the account; repositories and Workers do not multiply that allowance. Budget aggregate existing traffic and cron usage. Report behavior that exceeds the authorized free design without adding paid prerequisites.

Count attempted storage, DNS, RPC, asset, and webhook I/O in a conservative application budget, and enforce an elapsed deadline. Stop with unfinished work retryable. A deadline does not increase the platform CPU allowance.

Persist bounded scan ranges and fair work selection. Checkout separates a CAS-protected per-chain invoice rotation pointer from each invoice's scan cursor: rotation prevents a failing invoice from starving later ones; scan progress commits only after completed work.

The reference cron runs every minute: 1,440 ticks/day, three-chain rotation, at most one outbox event and one invoice per tick, up to 1,000 blocks with 128-block overlap, a 24-call budget, and a 20-second deadline. HTTP uses a 40-call budget. Each chain gets a turn every three minutes; total backlog determines per-invoice completion time.

Keep exactly one hosted scheduler active during cutover and rollback. Request-local services, in-memory locks, or multiple timers do not establish cross-isolate ownership.

## 6. Validate the complete candidate

The Checkout script contract is:

```bash
bun install --frozen-lockfile
bun run deploy:types
bun --no-env-file run check
bun --no-env-file run test:anvil
bun --no-env-file run deploy:dry-run
```

`check` includes `fmt`, `lint`, `typecheck`, `test`, and `test:workers`; `test:anvil` is networked. Local commands are `bun run dev`, `bun run start`, and `bun run demo`. Verify each repository's exact scripts.

- Offline tests must cover state conflicts, codec/legacy reads, TTL/ranges/indexes, canonical payment verification, auth/scopes, idempotency, retries, and interrupted progress.
- Real Bun listener/TLS tests must exercise socket-derived trust, proxy handling, certificate failures, exact request bytes, and zero application bytes before rejected peer approval.
- Actual workerd tests must execute the real entrypoint, configured flags, binding protocol, assets/security headers, auth redirects, protected API behavior, persistent signing identity, and scheduled work with isolated upstreams.
- Where the product uses a local chain demo, verify its real fork lifecycle and reorg behavior. Scope transactions to the local fork, verify the official tool release, bound processes, and settle listeners/children.
- Run the repository's complete gate after writers settle, inspect the deployment artifact, and complete its actual local review. Focused tests, mocks, and a dry-run prove distinct surfaces.

Retain commands/actions, exit/status, tested revision/config, executed-versus-cached status, and result references. Reuse unchanged evidence; rerun when inputs change or acceptance remains unresolved.

## 7. Ship, prove, and clean up

CI installs the frozen Bun graph, provides supported Node only for Cloudflare tooling, checks generated types, runs the complete gate and packaging dry-run, and serializes production deployment from the canonical branch. Verify action/runtime versions before changing pins. Candidate CI must not automatically write shared production state.

Keep candidate routes and cron empty during validation. Compare the public baseline, preserve the remote signing identity and secrets, and prepare the codec-compatible rollback release. Transfer scheduler ownership as part of the guarded route change.

```bash
bun run deploy
bun run deploy:verify
```

Public smoke checks are only part of acceptance. Verify the canonical served runtime/version, assets and headers, retained JWKS key ID, authenticated login/callback and protected API behavior, plus a real scheduled cycle. Record what remains unproved. A successful upload or health response does not establish these outcomes.

Integrate through the repository's accepted PR/review path and prove the accepted revision is reachable from the canonical branch. Retire obsolete runtime/deployment files and only the owned temporary resources after acceptance; preserve the working rollback release and authoritative state.

## Checkout reference and release receipt

Verified on 2026-10-18: Bun 1.4.0 application/tooling, Node 24.20.0 Cloudflare tooling, Wrangler 4.151.1, and TypeScript 5.9.3. Revalidate pins for another repository.

The accepted application passed 75 offline tests, one real workerd claim/JWS/replay test, and two real Anvil fork tests, with zero failures. Production serves the native Worker at `https://checkout.ubq.fi`; nine public GET checks passed, covering assets, unchanged JWKS, a 302 login redirect, `authenticated: false`, and protected-route 401s. Signed-in OAuth callback behavior was not exercised.

The old hosted service is disabled; an immutable codec-compatible Bun rollback release is retained. Initial cutover held Worker cron inactive for sole activation by the canonical CI deployment. The one-minute schedule above is the configured contract; natural scheduled-cycle acceptance belongs in the release handback.

Return this receipt with each migration rather than embedding changing deployment identifiers in documentation:

| Receipt field          | Required evidence                                                              |
| ---------------------- | ------------------------------------------------------------------------------ |
| Source and integration | Accepted SHA, review/PR, canonical ancestry, and exact tested revision.        |
| Deployment             | Worker/version readback, canonical/candidate URLs, and served runtime/version. |
| Client acceptance      | Public and signed-in results separately; exact unproved boundaries.            |
| Scheduler              | Active owner, previous timer retirement, and observed natural-cycle result.    |
| Recovery               | Codec-compatible installed release, route target, and rollback limitations.    |

Migrate the selected repository from Deno to Bun locally and to Workers within its authorized free resources, preserve state and trust contracts, pass its offline and real-runtime gates, integrate through review, deploy with a codec-compatible rollback and one scheduler, and return canonical client-visible evidence with the release receipt.

Primary references: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), [Node HTTPS compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/), [request redirects](https://developers.cloudflare.com/workers/runtime-apis/request/), [scheduled handlers](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/), [static assets](https://developers.cloudflare.com/workers/static-assets/binding/), and [Wrangler installation](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
