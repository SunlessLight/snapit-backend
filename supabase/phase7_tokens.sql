-- ============================================================================
-- SnapIT Phase 7 — token / trial-credit schema
-- Run this once in Supabase Dashboard → SQL Editor (paste + Run).
-- Safe to re-run: every statement is idempotent.
-- ============================================================================

-- 1. The balance table. One row per user. balance can never go negative.
--    Default 30 = the one-time free trial (1 credit per paid image action:
--    /api/generate, /api/enhance, /api/regenerate/background).
create table if not exists public.user_tokens (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  balance    integer not null default 30 check (balance >= 0),
  updated_at timestamptz not null default now()
);

-- 2. Row Level Security. The frontend uses the *publishable* (anon) key, which
--    is subject to RLS. We allow a user to READ only their own balance and
--    grant NO insert/update/delete — so a malicious client can never mint
--    credits. The backend uses the *service_role* key, which bypasses RLS
--    entirely, and is the only thing that ever writes.
alter table public.user_tokens enable row level security;

drop policy if exists "read own balance" on public.user_tokens;
create policy "read own balance" on public.user_tokens
  for select using (auth.uid() = user_id);

-- 3. Auto-provision a trial balance whenever a new auth user is created.
--    (consume_credit / get_or_init_balance below also self-heal a missing
--     row, so this trigger is belt-and-suspenders, not the sole path.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.user_tokens (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. Atomic consume. Decrements by 1 *only if* balance > 0, in a single
--    statement, so two concurrent requests can never push the balance
--    negative. Returns the new balance, or NULL when there was nothing to
--    consume (balance already 0). The pre-insert guarantees a row exists with
--    the trial default before we try to decrement.
create or replace function public.consume_credit(p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  new_balance integer;
begin
  insert into public.user_tokens (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  update public.user_tokens
     set balance = balance - 1, updated_at = now()
   where user_id = p_user_id and balance > 0
   returning balance into new_balance;

  return new_balance; -- NULL = out of credits
end;
$$;

-- 5. Refund. Used when a paid upstream call (Claid / Photoroom) fails after we
--    already consumed — we don't charge users for our own failures.
create or replace function public.refund_credit(p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  new_balance integer;
begin
  update public.user_tokens
     set balance = balance + 1, updated_at = now()
   where user_id = p_user_id
   returning balance into new_balance;

  return new_balance;
end;
$$;

-- 6. Read (with lazy provision) for the balance pill / gating.
create or replace function public.get_or_init_balance(p_user_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  bal integer;
begin
  insert into public.user_tokens (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  select balance into bal from public.user_tokens where user_id = p_user_id;
  return bal;
end;
$$;

-- 7. Backfill any users who signed up before this migration (e.g. your dev
--    test account) so they get the trial balance too.
insert into public.user_tokens (user_id)
  select id from auth.users
  on conflict (user_id) do nothing;
