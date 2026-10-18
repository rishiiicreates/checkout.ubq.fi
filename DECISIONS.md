# Checkout decisions

## 2026-10-17: invoice discovery claims

The claim route accepts an empty object for server-side discovery or exactly the existing four
locator fields. Discovery scans one invoice toward the safe, finalized, or latest head, in that
order, and does not use the legacy chain cursor. Both reconciliation paths share the
amount/token/treasury/minimum-block predicate and independently verify canonical receipts before
claiming. An absent transfer is a successful response with `discovery.found: false`; an already
claimed invoice returns its current state and a signed event when available.

Canonical re-inclusion keeps the original payment identity when the same transaction returns at a
changed log index. The payment update, removal of its old locator, and creation of the empty new
locator share one atomic commit with checks on both locators. Discovery reports `found: false` while
the invoice remains reverted, including when another transaction is retained as a duplicate.

Each discovery call covers at most 50,000 blocks, starting at the invoice minimum or 128 blocks
before its saved next block, whichever is later. The per-invoice `discovery_state` key persists
completed no-match coverage separately from the hourly cursor. A backlog needs repeated capped calls
before catching up; once caught up, only the overlap and new blocks are queried. There is no
invoice-age or expiry clamp, so the complete history and late-payment/re-inclusion paths remain
reachable.

A compare-and-swap lease in the same key admits one normal discovery owner for 60 seconds. Busy
calls do no RPC work and return only the last committed watermark, if any. Progress checks both the
invoice version and owned lease. Primary claims, re-inclusion, and both reorg transitions atomically
delete discovery state; stale owners can neither restore progress nor release a successor's lease.
Expired leases allow crash recovery and can overlap an already in-flight stalled scan; this is not
an exactly-once RPC guarantee.

A matching log with unavailable or noncanonical verification evidence holds the watermark in place
so its receipt can be retried even if further progress would move it outside the overlap. Verified
unrelated duplicates do not prevent checking later logs for the original payment's re-inclusion.
Transfer-log queries use 1,000-block chunks, so an ordinary 50,000-block call uses at most 50 log
queries. Explicit block-range, result-count, and response-size errors can bisect those chunks and
increase that count; rate, quota, and throttling errors propagate without bisection.

## 2026-10-17: durable event-driven maintenance

Invoice creation atomically records discovery and expiry work in the authoritative store. Payment
transitions atomically retain confirmation work until finalization, and event writes atomically
record webhook work. Work uses stable per-target keys, compare-and-swap leases, persisted retry
times, and recovery of abandoned leases. Startup recovers existing active invoice indexes and
undelivered outbox indexes once, preserving retries; terminal transitions and recovery prune only
work/index entries, never invoices, payment locators, amount reservations, events, or idempotency
history. Amount quarantine remains lazy allocation behavior and needs no periodic sweep.

Discovery starts after one minute, then backs off by 2, 5, 10, 20, and 30 minutes while the invoice
is eligible. Confirming, accepted, and safe payments continue refreshing after their original
deadline until finalized. The 60-minute expiry event attempts discovery and expires an unpaid
invoice even if RPC is unavailable. Unpaid expired invoices retain a bounded 24-hour watch from
`expiredAt` (or `updatedAt` for older records): first after 15 minutes, then one hour, then every
four hours. Reverted payments retain a 30-minute watch for 24 hours from `revertedAt` (or
`updatedAt`), including after invoice expiry. Both watches cap their final job at the window end,
then remove their work and active index. Startup recovers missing jobs while their window remains
open.

These bounded per-invoice watches are the maintenance backstop for delayed safe-head visibility,
expiry RPC failures, late payments, and canonical re-inclusion. On-time inclusion can still be
accepted after expiry; later inclusion is retained as `late_payment` without an accepted event. An
explicit later claim remains available after the watch ends. This replaces indefinite reverted
polling and the former hourly sweep; no periodic maintenance runs when no eligible invoice or
undelivered event remains. Finalized invoices had no indefinite reorg monitor in the previous job.

The hosted D1 adapter has CRUD/list/atomic operations but no native queue methods and no range
selectors. Its runtime uses a single one-shot timer for the earliest persisted work record, and it
has no timer or store scan while idle. Genuine Deno KV additionally receives wake messages in the
same atomic operation as domain/job writes so suspended instances can wake. Local native queue tests
prove the API behavior; deployed isolate scheduling remains untested. No extra infrastructure or
environment setting is required, and the former cron and interval entrypoints are removed.

Webhook work rereads the event after acquiring its lease, signs a fresh JWS with stable event
identity, and retires delivery only after a saved success. Failures use the existing exponential
retry from one minute to a 24-hour cap. Ordinary repeated or concurrent jobs do not resend delivered
events. A crash after a recipient accepts but before the saved acknowledgement can repeat delivery,
so the merchant must deduplicate by event ID/JWS `jti`.

## 2026-10-17: JSON KV value encoding and conflict handling

The canonical KV service stores generic JSON without interpreting value tags. Checkout now wraps new
values in a version-one envelope containing a fully tagged tree, including escaped objects/arrays
and decimal bigint nodes; undefined values are explicit nodes too. Adapter get, getMany, and list
decode only that outer envelope. Existing plain JSON is returned unchanged, and new tag-shaped
application objects round-trip as data. Existing Checkout-owned record roots do not use the reserved
envelope shape; an arbitrary historical JSON value that exactly matched the entire reserved envelope
would be ambiguous. No guessed legacy bigint format or production conversion is introduced.

An HTTP 200 response with `ok: false` from the atomic endpoint is a normal failed version check,
matching the service source. The adapter returns that conflict to the caller instead of throwing a
transport error. This allows durable-job lease contention and existing domain compare-and-swap loops
to retry correctly. The service protocol and store are unchanged, and acceptance uses an isolated
fake HTTP implementation of that generic-JSON boundary.
