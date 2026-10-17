# Checkout decisions

## 2026-10-17: invoice discovery claims

The claim route accepts an empty object for server-side discovery or exactly the existing four
locator fields. Discovery scans one invoice from its minimum block to the safe, finalized, or latest
head, in that order, and does not use the legacy chain cursor. Both reconciliation paths share the
amount/token/treasury/minimum-block predicate and independently verify canonical receipts before
claiming. An absent transfer is a successful response with `discovery.found: false`; an already
claimed invoice returns its current state and a signed event when available.

Transfer-log queries use at most 1,000 blocks per request and bisect provider range-limit errors.
This bounds long-invoice scans while retaining the same matching and canonical verification rules.
