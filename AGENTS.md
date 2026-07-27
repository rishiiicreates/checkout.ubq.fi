# Ubiquity Checkout Guidance

- Use Deno 2, TypeScript, Web APIs, and Deno-native tooling only. Do not add a Node or Bun layer.
- Treat Deno Deploy as stateless. Persist all authoritative cross-request state in Deno KV.
- Represent token amounts as integer base units with `bigint`; serialize them as decimal strings.
- Never expose merchant keys, signing keys, or treasury administration credentials to browser code.
- Browser RPC observations are hints. The server independently verifies every payment against the
  canonical token log and block state before emitting a signed event.
- Keep default tests offline with isolated KV databases and mocked RPC responses.
- Use `uos` for internal identifiers. Public domains and required deployment slugs may contain
  `ubq.fi`.
- Do not include `"ok": true` in API responses; successful HTTP status codes indicate success.
- Run `deno task check` before committing.
