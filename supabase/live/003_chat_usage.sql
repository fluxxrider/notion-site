-- =============================================================================
-- LIVE-DB migration (community-platform schema, after 000_community_platform_init,
-- 001_course_comments_bridge.sql and 002_community_search.sql).
-- Run this in the Supabase SQL editor — it is NOT applied automatically.
--
-- Course-chat hardening: per-request usage log for /api/course-chat. One row
-- per chat request; the same table drives the per-user hourly rate limit
-- (windowed count) and the global daily spend ceiling (windowed sum), so no
-- separate rate_limits table or Redis is needed.
--
-- NOTE: this folder targets the LIVE database schema. The files in
-- supabase/migrations/ are the older course-page app schema and must NOT be
-- run against this project (table names collide).
-- =============================================================================

create table public.chat_usage (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  created_at         timestamptz not null default now(),
  model              text not null,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  estimated_cost_usd numeric(10, 6) not null default 0
);

-- Rate-limit window: count of a user's rows in the last hour.
create index idx_chat_usage_user_created
  on public.chat_usage (user_id, created_at desc);

-- Daily budget window: sum of tokens/cost since UTC midnight.
create index idx_chat_usage_created
  on public.chat_usage (created_at desc);

-- Service-role access only: the API route reads/writes with the service key
-- (which bypasses RLS). No policies on purpose — browsers have no business
-- reading other users' usage or writing rows that grant themselves quota.
alter table public.chat_usage enable row level security;

-- Optional, additive: let signed-in users see their own usage history.
-- Uncomment if/when a "my usage" UI exists.
--   create policy "users can read own chat usage"
--     on public.chat_usage for select using (auth.uid() = user_id);
