# Ubiquity Checkout

Deno app generated from `deno-auth-template`.

## Local Development

```bash
deno task dev
```

Run checks:

```bash
deno task check
```

## Auth Contract

- First registration becomes `super_admin`.
- Later registrations become `user`.
- `super_admin` can promote accounts to `admin` or `super_admin`.
- Admins can mint one-time-visible agent tokens for any user.
- Agent tokens exchange into normal app sessions through `/api/auth/agent-token/login`.
- Referral codes are stored with users and accepted during registration.
