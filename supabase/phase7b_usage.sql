-- ============================================================================
-- SnapIT Phase 7b — per-call API usage log
-- Run this once in Supabase Dashboard → SQL Editor (paste + Run).
-- Safe to re-run: every statement is idempotent.
--
-- Purpose: one row per paid UPSTREAM call (OpenRouter / Claid / Photoroom) so
-- real spend can be measured. Only OpenRouter reports cost in-band
-- (openrouter_cost_usd is genuinely measured); Claid & Photoroom do NOT report
-- per-call consumption, so for those this table is an accurate CALL COUNTER —
-- you read the provider dashboard's decrement over a window and divide by the
-- count here to get real cost-per-call. No dollar figures are fabricated.
-- ============================================================================

create table if not exists public.api_usage (
  id                  bigint generated always as identity primary key,
  created_at          timestamptz not null default now(),
  user_id             uuid references auth.users(id) on delete set null,
  provider            text not null,        -- 'openrouter' | 'claid' | 'photoroom'
  operation           text not null,        -- 'generate_copy' | 'enhance' | 'background'
                                             -- | 'regenerate_background' | 'refine_background_prompt'
                                             -- | 'regenerate_captions'
  model               text,                 -- OpenRouter tier model/label; null for image APIs
  success             boolean not null,      -- failed calls are FREE on all three providers
  snapit_credits      numeric not null default 0,  -- OUR internal credit charged (1 paid image action, 0 = free)
  openrouter_cost_usd numeric,              -- ONLY OpenRouter — real measured USD; null for image APIs
  prompt_tokens       integer,              -- OpenRouter only
  completion_tokens   integer,              -- OpenRouter only
  request_id          text,                 -- x-request-id / OpenRouter id (audit + dashboard cross-ref)
  job_id              text,                 -- /api/generate jobId
  meta                jsonb                 -- latencyMs, error reason, etc.
);

create index if not exists api_usage_user_created_idx
  on public.api_usage (user_id, created_at desc);
create index if not exists api_usage_provider_created_idx
  on public.api_usage (provider, created_at desc);

-- Row Level Security. The frontend uses the publishable (anon) key, which is
-- subject to RLS. We enable RLS and grant NO policies — so the anon/auth client
-- can read and write NOTHING here. Only the backend's service_role key (which
-- bypasses RLS) ever touches this table. Honours the standing RLS rule
-- (CLAUDE.md "Supabase RLS rule"): no table holds data without RLS enabled.
alter table public.api_usage enable row level security;
