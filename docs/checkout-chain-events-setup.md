# Owner setup: Alchemy chain events

This guide describes owner setup, not completed live acceptance. No webhook, secret, deployment or live provider test delivery was created for this change. Delivery URL: `https://checkout.ubq.fi/api/v1/chain-events/alchemy`. The implementation must pass its offline/runtime gates before owner cutover; production setup remains unperformed. Order: create owner subscriptions/get their keys, install the key map on the existing Worker, deploy the reviewed code, finish bounded GET health migration, then activate/cut over payment notifications.

1. Read the current treasury configuration in the signed-in Checkout dashboard at https://checkout.ubq.fi/ (existing sign-in route `/api/auth/login`). Its chain cards are populated from authenticated `GET /api/v1/admin/overview` → `chains[].chainId`, `enabled` and `treasuryAddress`; owner/admin/viewer may read that overview. Do not assume Base's address is also Ethereum's or Optimism's. Missing chain settings are disabled/null, with no hardcoded treasury default.
2. Reconcile every previous treasury still referenced by an active invoice or pending known-payment workflow. The overview includes only the latest 50 invoices, so it is not a complete historical-address inventory. For known invoice IDs, existing merchant-authorized `GET /api/v1/invoices/{id}` exposes that invoice's treasury; use complete operator invoice records or an authorized scoped read-only export to establish coverage. No bulk production export or configuration read was performed here. Record the verified per-chain wallet set before enabling the indexer.
3. In the intended Alchemy app's Webhooks dashboard, create one Address Activity (`ADDRESS_ACTIVITY`) subscription for each required mainnet below. Track those treasury WALLET addresses, including active historical addresses. The token contracts are receiver-side allowed-token filters, not substitutes for the watched wallets. Address Activity reports sends/receives and multiple asset types; Checkout accepts only matching incoming native-USDC logs.

| Checkout chain     | Alchemy network | Receiver-side native USDC contract           |
| ------------------ | --------------- | -------------------------------------------- |
| Ethereum, chain 1  | `ETH_MAINNET`   | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Optimism, chain 10 | `OPT_MAINNET`   | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |
| Base, chain 8453   | `BASE_MAINNET`  | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

4. Set each subscription's webhook URL to `https://checkout.ubq.fi/api/v1/chain-events/alchemy`. Record its assigned webhook ID, selected network and its OWN signing key from that webhook's detail page. Alchemy's current pricing documentation lists five Free webhook slots; three subscriptions fit only if account usage leaves capacity. Actual account entitlement/usage and registrations were not inspected. Do not choose a paid upgrade or provision anything on behalf of this task. Alchemy documents an active/inactive subscription state, but the opened references do not establish a dashboard pause button. If your dashboard exposes a documented inactive control, keep notifications inactive until the signed endpoint is deployed, migrated and tested; otherwise record that setup constraint rather than assuming pause controls, buffering or automatic replay. No agent performed activation, deactivation or an API call.
5. Prepare the single Worker secret `CHECKOUT_ALCHEMY_WEBHOOK_KEYS` as a JSON object with one entry per actual webhook ID. The following values are placeholders, not credentials. Use each provided key literally as UTF-8 text even if it resembles hex; do not hex/base64-decode it. The receiver does not need the Notify management Auth Token or a general Alchemy API key merely to verify signatures.

```json
{
  "wh_REPLACE_ETH": {
    "network": "ETH_MAINNET",
    "signingKey": "REPLACE_WITH_ETH_WEBHOOK_SIGNING_KEY"
  },
  "wh_REPLACE_OPT": {
    "network": "OPT_MAINNET",
    "signingKey": "REPLACE_WITH_OPT_WEBHOOK_SIGNING_KEY"
  },
  "wh_REPLACE_BASE": {
    "network": "BASE_MAINNET",
    "signingKey": "REPLACE_WITH_BASE_WEBHOOK_SIGNING_KEY"
  }
}
```

Owner release command, documented only and NOT executed: verify the existing checkout-ubq-fi Worker/account, then install this map BEFORE deploying the reviewed event code. Both production and candidate declare CHECKOUT_ALCHEMY_WEBHOOK_KEYS in secrets.required; a deployment missing it fails validation. Supply the complete JSON through Wrangler's interactive secret prompt from the reviewed Checkout checkout. Do not wait for the new receiver to be live before loading this required secret on the existing Worker. Keep values out of shell arguments, source, chat, browser code and logs. `wrangler secret put` creates and deploys a Worker version immediately, so coordinate this command with the reviewed release; it is not an authorized action during this draft-only task.

```bash
bun x wrangler secret put CHECKOUT_ALCHEMY_WEBHOOK_KEYS --name checkout-ubq-fi
```

6. After the secret exists, deploy the reviewed event code through the normal owner release process, then finish the bounded GET health migration below BEFORE activating/cutting over payment traffic. Validate a signed delivery from an already established webhook during owner-authorized live acceptance. The receiver's application policy rejects createdAt older than 15 minutes or more than 60 seconds in the future. Official docs describe createdAt ambiguously as webhook creation time, and official SDK/example source does not resolve notification-time semantics. Compare registration time, signed payload createdAt and arrival time before claiming old subscriptions work with that policy. Do not bypass signature/freshness/identity validation to make the dashboard test succeed. Signed fake deliveries prove the offline contract, not this provider compatibility.
7. Confirm the final implementation's response and persistence behavior using the planned contract below. All batch items use their own transaction/log/block coordinates, exact integer amount and canonical receipt verification; a removed hint invokes the existing canonical reorg path and cannot itself override a newer inclusion.

| Delivery outcome                                                                          | Implemented response                                                  |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Completed valid delivery                                                                  | HTTP 200 after terminal processing                                    |
| Authenticated, current duplicate with the same webhook/event ID and completed body digest | HTTP 200 with no repeated payment processing                          |
| Same authenticated identity with a different body digest                                  | HTTP 409; no conflicting receipt replacement                          |
| Incomplete batch or another active owner                                                  | HTTP 503; persisted prefix/progress resumes through a permitted event |
| Missing/invalid signature, unknown webhook ID or stale/future timestamp                   | HTTP 401; no receipt/domain writes                                    |
| Malformed JSON/date/payload, unsupported type or mismatched network                       | HTTP 400; no receipt/domain writes                                    |
| Body exceeds 256 KiB or activity array exceeds 256                                        | HTTP 413; no silent truncation                                        |
| Missing, malformed or invalid key registry                                                | HTTP 503; no receipt/domain writes                                    |

8. Account for the application admission cap of 256 KiB (262,144 bytes) and 256 activities per request; these are not documented Alchemy maxima. Alchemy documents exponential retries for non-200 responses for up to ten minutes on Free/PAYG. A bounded batch may outlast that horizon, and persisted unfinished work can await provider retry, startup or a directly related request/write. Related invoice requests recover only the indexed current item through at most eight references for its exact match tuple; an unindexed suffix can remain retained beyond the provider retry horizon. There is no chain-event drain alarm, polling fallback, repair sweep or unconditional completion deadline. Track these limits during owner acceptance rather than claiming durable storage removes them.

The scheduler handles only original invoice expiry, finite known-payment sealed/safe/finalized milestones and merchant retries. Expiry owns one full minimumBlock-to-captured-head pass, split into 1000-block durable chunks without overlap or extending the safe/finalized/latest head snapshot. It uses separate expiry progress rather than the manual/reconciliation cursor. It records first startedAt and stops on completion, three consecutive transient/no-progress attempts (reset by progress), or startedAt plus five minutes; a late/migrated invoice still gets this one pass. Expiry completes with explicit partial coverage if the pass cannot finish, and its completion marker prohibits a new pass. A final confirmation miss remains pending until a related request, write or chain event; it does not start a periodic recheck. Merchant delivery after ambiguous success remains at least once with stable JTI. Existing history/amount-reservation rules remain and no purge pass is added.

## Finite cutover and local startup

The first ordinary Worker request starts bounded migration slices; migration has no alarm of its own. While pending, ordinary application requests return HTTP 503 with error migration_pending before their handler; GET /api/health remains HTTP 200 and advances a bounded slice. Use GET, not HEAD. Inspect x-checkout-events-migration and issue only a finite owner-controlled batch of these health requests until it reports complete BEFORE activation/cutover. The slice that writes the complete marker still reports pending; issue the next GET, which observes entry-time complete with zero shared-KV migration work. HTTP 200 alone, a missing header, or the final pending slice is not completion. If the finite batch ends pending, stop and report retained progress instead of installing a timer.

```bash
curl --request GET --silent --show-error --dump-header - --output /dev/null https://checkout.ubq.fi/api/health
```

Migration persists phase/raw-page/item progress and adopts only original expiry, finite known-payment and merchant-delivery work, including future retries. It never creates discovery jobs. Invalid chain deliveries are rejected before KV-backed migration/recovery. If a chosen finite request batch still reports pending, report retained progress and continue through an authorized ordinary-request event; do not install a sweeper. Settle old unfenced writers before claiming complete coverage. Each Bun process startup hydrates its durable queue and runs one finite idempotent existing-domain adoption pass, preserving valid generations, leases, deadlines and expiry progress rather than trusting a permanent local completion marker; thereafter one-shot callbacks deliver recorded due jobs, with head refresh only on enqueue/dequeue/delivery/startup or related requests/writes.

Known-payment local milestone estimates, measured from the canonical payment timestamp, are Ethereum sealed +36s/safe +768s/finalized +1152s; Optimism +6s/+300s/+1800s; Base +6s/+120s/+1200s. They are scheduling estimates, not proof or exact chain deadlines. Actual receipt/block and canonical latest/safe/finalized heads govern phases. Late/null heads at the final planned milestone leave an explicit pending state until a related event, without recurring head polling. [Ethereum timing](https://ethereum.org/developers/docs/consensus-mechanisms/pos/), [Optimism finality](https://docs.optimism.io/op-stack/transactions/transaction-finality.md), and [Base finality](https://docs.base.org/specifications/transactions/transaction-finality.md) explain why these times are approximate.

The adapter accepts token or erc20 activity labels with the same strict ERC20 log checks, and UTC createdAt strings with one through nine fractional digits. Nanosecond-formatted provider timestamps are accepted syntactically; timestamp freshness semantics still require the owner live check above.

Sources checked 2026-10-18: [Address Activity and dashboard steps](https://www.alchemy.com/docs/reference/address-activity-webhook.md), [signature and delivery behavior](https://www.alchemy.com/docs/reference/notify-api-quickstart.md), [network schema](https://www.alchemy.com/docs/data/webhooks/webhooks-api-endpoints/notify-api-endpoints/create-webhook.md), [Free webhook count](https://www.alchemy.com/docs/reference/pricing-plans.md), and [documented active/inactive state](https://www.alchemy.com/docs/data/webhooks/webhooks-api-endpoints/notify-api-endpoints/update-webhook.md). Source-only treasury route evidence: `main.ts` admin overview/known-invoice routes and `public/app.js` chain-card rendering. Live endpoint, keys, actual wallet coverage, provider-createdAt compatibility, request-size acceptance and real merchant delivery remain unverified.

The [verbatim source handoff](2026-10-18-checkout-discovery-and-events-on-workers.handoff.txt) has SHA-256 `1fa3e387d6a390d478ff4be5028f32962f0ddb2d9128085ef4b30cfc159b2fa4`. Its final owner decisions supersede earlier discovery-alarm/backoff proposals; current finite expiry, confirmation and request-driven migration policy is recorded in [DECISIONS.md](../DECISIONS.md).
