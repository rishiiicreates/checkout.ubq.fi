# Ubiquity Checkout

Ubiquity Checkout is a small, non-custodial USDC payment service for Ubiquity products. A customer
stays signed in to the product they are buying, sends an exact USDC amount directly to the
configured treasury, and the product receives a signed payment event from Checkout.

Version 1 supports Circle-native USDC on Base (`8453`), Optimism (`10`), and Ethereum (`1`). Base is
the product default. ETH, WBTC, swaps, token approvals, Permit2, subscriptions, and automatic
monthly withdrawals are intentionally outside the one-shot v1 contract.

## Trust boundary

- The merchant API key exists only in the product backend. It is never returned to customer code.
- Browser WebSocket observations are untrusted hints. Checkout independently verifies the receipt,
  exact ERC-20 Transfer log, canonical block, amount, recipient, and chain heads through
  `https://rpc.ubq.fi/{chainId}`.
- Checkout signs accepted, settled, and reverted events with a persistent KV-backed RS256 key.
- The product verifies the compact JWS and applies fulfillment exactly once.
- All durable application state lives in Deno KV; the server does not rely on process memory.

An invoice uses a permanently reserved six-decimal discount as its payment fingerprint. That gives
each list-price/chain/treasury tuple 999,999 possible exact amounts. Reservations are not recycled,
because recycling creates ambiguity when a customer pays an old invoice late.

## Payment states

1. `awaiting_payment` — the invoice has an exact amount and a minimum block.
2. `confirming` — the canonical transfer exists but has fewer than three later heads.
3. `provisionally_paid` — three blocks have been sealed after inclusion; the signed accepted event
   can grant fast product access.
4. `settled` — the payment block is at or behind the chain's `safe` head.
5. `finalized` — the payment block is at or behind the chain's `finalized` head.

A reorg after provisional acceptance produces a signed `payment.reverted.v1` event. Duplicate and
late payments are retained for manual review instead of being silently assigned.

The customer watcher subscribes to `newHeads` and matching Transfer logs over
`wss://rpc.ubq.fi/{chainId}`. It queries `safe` once per new head. A 15-second timer is only a dead
connection watchdog; it is not a polling interval. One hourly Deno Cron pass backs up normal
browser-driven claims and webhook delivery without consuming a per-minute free-tier schedule.

## Local development

```bash
deno task dev
```

Open [http://localhost:8000](http://localhost:8000). Requests accepted by the local listener receive
an internal loopback marker and use a development owner/merchant identity. Supplying that HTTP
header from a remote client does not create trust because the listener removes and rebuilds it from
the actual peer address.

Run the complete offline suite:

```bash
deno task check
```

## Operator setup

Production operators sign in through Auth Hub. The first Auth Hub administrator to complete Checkout
SSO atomically claims the Checkout `owner` role; later operators must be granted an app-local role.
Auth Hub agent tokens are rejected.

In the operator console:

1. Set and enable a treasury for each desired chain.
2. Set the LinkedIn Sales Agent settlement webhook.
3. Generate a merchant key and copy the one-time value into the LinkedIn deployment secret named
   `CHECKOUT_API_KEY`.

Only the token hash is retained by Checkout. Revocation takes effect on the next API request.

## Merchant API

All merchant routes use `Authorization: Bearer uos_checkout_…` outside loopback development.

- `PUT /api/v1/catalog/versions/:pricingVersionId`
- `POST /api/v1/invoices` with `Idempotency-Key`
- `GET /api/v1/invoices/:invoiceId`
- `POST /api/v1/invoices/:invoiceId/claims`
- `GET /.well-known/jwks.json`

Pricing is not pinned to a single launch catalog. The merchant publishes every immutable product
pricing version it already uses, and each invoice records that version plus its canonical digest.
Checkout stores price identity; the merchant remains authoritative for credits and access
fulfillment.

## Deployment

The `development` branch deploys the `checkout-ubq-fi` Deno application in the `ubiquity-dao`
organization. The workflow creates or reuses only the dedicated `checkout-ubq-fi-kv` database and
never falls back to an unrelated shared KV database.

Canonical production origin: `https://checkout.ubq.fi`

Direct Deno origin: `https://checkout-ubq-fi.ubiquity-dao.deno.net`
