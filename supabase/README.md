# Phase 7 — Supabase setup (do this once)

The backend now authenticates every paid request with the user's Supabase JWT
and meters a per-user credit balance. That requires three things on the
Supabase side.

## 1. Run the SQL

Supabase Dashboard → **SQL Editor** → New query → paste all of
[`phase7_tokens.sql`](./phase7_tokens.sql) → **Run**.

It is idempotent (safe to re-run). It creates:

- `public.user_tokens (user_id, balance, updated_at)` — one row per user,
  `balance` defaults to **30** (the one-time free trial) and can't go negative.
- **RLS**: a user may only `select` their own row; nobody can `insert/update/delete`
  via the public key. Only the backend (service_role) writes.
- RPCs `consume_credit`, `refund_credit`, `get_or_init_balance` (atomic).
- A trigger that auto-creates a balance row on signup, plus a backfill for
  existing accounts.

To change the trial size later: `alter table public.user_tokens alter column balance set default <N>;`
(existing users keep their current balance; only new signups get the new default).

## 2. Get the service_role key

Dashboard → **Settings → API**. Copy:

- **Project URL** → backend `SUPABASE_URL`
- **`service_role` secret** → backend `SUPABASE_SERVICE_ROLE_KEY`

> ⚠️ The `service_role` key bypasses RLS — it is a full-access admin key.
> It lives **only** in `snapit-backend/.env` (and Render env in prod). Never put
> it in the frontend, never commit it, never expose it to the browser. The
> frontend keeps using the *publishable* key as before.

Add to `snapit-backend/.env`:

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role secret>
```

On **Render**, add the same two as environment variables.

## 3. Re-enable email confirmation (production)

Dashboard → **Authentication → Providers → Email** → turn **"Confirm email" ON**.

This was disabled for dev. It must be on before launch: a one-time free trial is
worthless against abuse if one person can mint unlimited verified-looking
accounts. Email confirmation is the gate that makes "30 free credits per person"
actually mean per person.

## 4. (Recommended) Audit RLS on every other table

The public key can touch any table that doesn't have RLS enabled. `user_tokens`
is locked down above; make sure any future table is created with
`alter table ... enable row level security;` + explicit policies.
