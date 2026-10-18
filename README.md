# Ubiquity Checkout

Ubiquity Checkout is a small, non-custodial USDC payment service for Ubiquity products. A customer stays signed in to the product they are buying, sends an exact USDC amount directly to the configured treasury, and the product receives a signed payment event from Checkout.

Version 1 supports Circle-native USDC on Base (`8453`), Optimism (`10`), and Ethereum (`1`). Base is the product default. ETH, WBTC, swaps, token approvals, Permit2, subscriptions, and automatic monthly withdrawals are outside the one-shot v1 contract.

## Trust boundary

- The merchant API key exists only in the product backend. It is never returned to customer code.
- Chain-provider notifications and browser observations are untrusted hints. Checkout independently verifies the receipt, exact ERC-20 Transfer log, canonical block, amount, recipient, and chain heads through `https://rpc.ubq.fi/{chainId}`.
- Checkout signs accepted, settled, and reverted events with a persistent RS256 key in the authoritative KV service. The product verifies the compact JWS and applies fulfillment exactly once.
- Worker webhook delivery validates public DNS answers, uses the original HTTPS hostname and platform TLS verification, sends fresh application headers, and never follows a redirect with signed event bytes. The `global_fetch_strictly_public` and `no_cots_on_external_fetch` compatibility flags are part of this boundary.
- Bun webhook delivery completes hostname-verified TLS and compares the connected peer with the validated DNS result set before writing HTTP request bytes. Workers enforce the actual public destination at the platform boundary and do not expose peer-address pinning.
- Production state remains in the existing `ubq-kv` service on Cloudflare D1. Request-local objects and process memory are not authoritative storage.

An invoice uses a reserved six-decimal discount as its payment fingerprint. That gives each list-price/chain/treasury tuple 999,999 possible exact amounts. Unpaid, late, disputed, and reverted fingerprints are never recycled, because doing so creates ambiguity when a customer pays an old invoice late. A successfully finalized fingerprint becomes reusable after a 24-hour quarantine; allocation uses a bounded probe count so saturation fails quickly. The replacement invoice starts after the old canonical payment's block, and the old transaction locator remains bound to the finalized invoice, so the original transfer cannot replay against the reused fingerprint.

## Payment states

1. `awaiting_payment` — the invoice has an exact amount and a minimum block.
2. `confirming` — the canonical transfer exists but has fewer than three later heads.
3. `provisionally_paid` — three blocks have been sealed after inclusion; the signed accepted event can grant fast product access.
4. `settled` — the payment block is at or behind the chain's `safe` head.
5. `finalized` — the payment block is at or behind the chain's `finalized` head.

A reorg after provisional acceptance produces a signed `payment.reverted.v1` event. Duplicate and late payments are retained for manual review instead of being silently assigned.

Signed chain-provider webhooks are the primary payment detector. A payer's four-coordinate report and `POST /api/v1/invoices/:invoiceId/claims` with `{}` remain immediate backups. The expiry job owns one finite minimum-block-to-captured-head discovery pass, with durable bounded chunks and no moving head or repeated pass. Known-payment confirmation uses finite sealed/safe/finalized milestones; a final miss waits for a related event. Merchant events schedule their own delivery/retry jobs. There is no customer WebSocket watcher/watchdog or periodic payment search in this repository. See the [chain-event owner setup guide](docs/checkout-chain-events-setup.md).

## Local development

Install Bun `1.4.0` and Node `24.20.0`, then install the locked dependencies and start the application:

```bash
bun install --frozen-lockfile
bun run dev
```

Open [http://localhost:8000](http://localhost:8000). Bun runs the application, scripts, demo, and tests. Node is used only by Cloudflare's supported Wrangler/Miniflare tooling; deployed Worker code runs in `workerd`.

The Bun listener removes and rebuilds its internal peer marker from the actual socket. Both a loopback peer and a local HTTP origin are required for the development owner/merchant identity. A forged header or production hostname does not create local trust. Worker ingress always removes that marker.

Local state defaults to `.uos-checkout.sqlite`. Set `CHECKOUT_KV_URL` to choose another local SQLite path. A Bun process can select the existing hosted HTTP adapter with `CHECKOUT_KV_SERVICE_URL` and `CHECKOUT_KV_SERVICE_TOKEN`; ordinary local development and offline tests use isolated local storage. Use a new local database path when moving from Deno KV, whose SQLite representation is not this adapter's interchange format.

Run the complete offline quality and runtime gate:

```bash
bun run check
```

This checks formatting, lint, both TypeScript entry points, isolated payment/auth/storage tests, real Bun listener/TLS behavior, and the Worker entry in the actual workerd runtime with mocked upstream services. Tests use `--no-env-file` and do not write production state. The focused Worker harness is `bun run test:workers`.

## Anvil checkout demo

With [Foundry](https://getfoundry.sh/) installed, start the localhost-only customer demo:

```bash
bun run demo
```

Open [http://127.0.0.1:8010](http://127.0.0.1:8010). The demo forks Base at pinned block `48933428`, executes Circle's deployed USDC contract, impersonates a funded holder only inside Anvil, and sends each invoice's exact amount to the configured Ether.fi treasury. The interface lets you advance the invoice through transfer inclusion, three sealed blocks, safe settlement, and finalization. No wallet, signature, or mainnet funds are used.

Anvil does not model Base's safe and finalized heads for locally mined blocks. The demo RPC adapter advances those two tags explicitly after Checkout has verified the real receipt and ERC-20 Transfer log. The fork uses Base's public RPC because Anvil needs pinned historical state; production payment verification continues to use `rpc.ubq.fi`.

Run the complete flow as a separate automated test:

```bash
bun run test:anvil
```

This test requires network access to pinned Base state and is separate from the default offline suite. The Worker packages the portable application and `public/` assets; the Anvil demo remains a local Bun application.

## Operator setup

Production operators sign in through Auth Hub. If an owner has not yet been claimed, the first Auth Hub administrator to complete Checkout SSO atomically claims the Checkout `owner` role; later operators must be granted an app-local role. Auth Hub agent tokens are rejected.

In the operator console:

1. Set and enable the initial Ether.fi USDC treasury `0x5DD4d53Df5d2F578c613D09525dE1A7352250143` on Base (`8453`), Optimism (`10`), and Ethereum (`1`). The same EVM deposit address is used on all three networks.
2. Set the LinkedIn Sales Agent settlement webhook.
3. Generate a merchant key and copy the one-time value into the LinkedIn deployment secret named `CHECKOUT_API_KEY`.
4. Invite later operators by their normalized Auth Hub handle and choose `admin` or `viewer`. The invitation is consumed atomically when that handle next completes Checkout SSO. Owners can update either role from the same console.

Only the token hash is retained by Checkout. Revocation takes effect on the next API request.

The owner-only membership API is `GET /api/v1/admin/members` and `PUT /api/v1/admin/members/:handle` with `{ "role": "admin" | "viewer" }`.

## Merchant API

All merchant routes use `Authorization: Bearer uos_checkout_…` outside loopback development.

- `PUT /api/v1/catalog/versions/:pricingVersionId`
- `POST /api/v1/invoices` with `Idempotency-Key`
- `GET /api/v1/invoices/:invoiceId`
- `POST /api/v1/invoices/:invoiceId/claims`
- `GET /.well-known/jwks.json`

Pricing is not pinned to a single launch catalog. The merchant publishes every immutable product pricing version it already uses, and each invoice records that version plus its canonical digest. Checkout stores price identity; the merchant remains authoritative for credits and access fulfillment.

## Production storage

The Worker accesses the existing `ubq-kv` service through its `UOS_KV` binding and the existing `CHECKOUT_KV_SERVICE_TOKEN` secret. The migration retains the Checkout keyspace, owner/member records, merchant keys, payment state, reconciliation cursors, outbox, and RS256 signing key.

The adapter preserves atomic checks/mutations, TTL, typed tuple ordering, range selection, and paginated prefix scans. New writes use a versioned codec for structured values and bigint; legacy JSON values remain readable. Public token amounts remain decimal strings.

The shared D1 service limits LIKE patterns to 50 bytes. Oversized derived list prefixes fall back only to the Checkout-owned `["uos_checkout", "v1"]` prefix, then filter locally. Broader Checkout scans consume additional I/O budget as state grows.

## Workers Free deployment

Canonical production origin: [https://checkout.ubq.fi](https://checkout.ubq.fi). Checkout now serves the native Cloudflare Worker `checkout-ubq-fi` on route `checkout.ubq.fi/*` with a Workers Free-compatible configuration. Public acceptance verified assets, unchanged JWKS, the Auth Hub login redirect, anonymous session behavior, and protected-route rejection; it did not exercise a signed-in OAuth callback. The former hosted service is disabled, and an immutable Bun release with the same storage codec is retained for rollback. See the [Bun and Workers migration blueprint](docs/bun-workers-migration-blueprint.md) for the reusable workflow and release receipt contract.

The event design targets Workers Free without cron, maintenance intervals, periodic repair/retention, discovery alarms or chain-ingress drain alarms. SQLite Durable Objects deliver original expiry, finite known-payment milestone and merchant-retry jobs. Bun uses the same job core through a durable local KV delayed queue with one finite adoption pass at each process startup and one-shot callbacks for recorded work. Startup preserves valid existing job generations, leases, deadlines and expiry progress; it is not a periodic scan or permanent migration marker. Existing state migrates in bounded ordinary-request slices; pending application requests return 503 migration_pending, while GET /api/health stays 200 and advances migration. The owner completes a finite GET health batch until x-checkout-events-migration reports complete, including one final observation request after the last pending slice; migration has no timer of its own. Quotas, partial expiry coverage and the finite provider retry window remain operational limits. Owner-configured signed chain delivery, older-webhook createdAt compatibility, migration coverage and public acceptance must be verified separately before declaring the event deployment ready.

The `candidate` environment has no routes or cron. It uses the existing storage service, so candidate writes require deliberate release validation rather than an automatic CI exercise.

Read [DECISIONS.md](DECISIONS.md) before changing runtime, persistence, webhook enforcement, trust, or scheduling.

The owner must install CHECKOUT_ALCHEMY_WEBHOOK_KEYS on the existing Worker before deploying the reviewed event code, because production and candidate mark it required. Follow the [owner setup order](docs/checkout-chain-events-setup.md): prepare hook keys, install the map, deploy, finish bounded GET health migration until the complete header, then activate/cut over notifications. No provider setup or production action was performed for this change.

Prepare the production artifact:

```bash
bun run deploy:types
bun run check
bun run deploy:dry-run
```

Cloudflare tooling reads the existing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` deployment credentials. Keep their values in protected local/CI configuration.

Bootstrap the Worker KV secret once from the existing Checkout service token through protected stdin. Run this only when that Worker secret is absent; regular deployments retain the remote secret:

```bash
test -n "$CHECKOUT_KV_SERVICE_TOKEN" && printf '%s' "$CHECKOUT_KV_SERVICE_TOKEN" | WRANGLER_LOG_PATH=.wrangler/logs/wrangler.log WRANGLER_SEND_METRICS=false bun x wrangler secret put CHECKOUT_KV_SERVICE_TOKEN
```

Deploy and run the public smoke verification:

```bash
bun run deploy
bun run deploy:verify
```

The `development` workflow installs frozen Bun dependencies, runs the complete gate and packaging dry-run, deploys the production Worker, and verifies the canonical URL. Deployments must run serially. The public verification command checks health, JWKS availability, assets, and rejection of a public local-admin session.

Release acceptance additionally compares the retained public JWKS key ID, verifies Auth Hub login/callback and protected merchant/admin behavior, and records the deployed Worker version, canonical route, signed chain delivery and event-migration result. Settle old unfenced/interval writers before cutover. Keep a Bun release with this storage codec and the event-driven queue available until acceptance passes; rollback retains the same D1 state and must not restore cron or a maintenance interval. After new enveloped values are written, the former adapter is not a compatible rollback target.
