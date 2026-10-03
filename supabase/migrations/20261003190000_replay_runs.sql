-- Universe replay results (scripts/replay-universe.mjs, owner 2026-10-03):
-- one row per run — the day-by-day LEAPS replay of every entry × exit rule
-- across the universe, big-move catch rate, missed moves, walk-forward test.
-- Shared market research, not user data: authenticated SELECT, service-role
-- write only.
create table if not exists public.replay_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  as_of date not null,
  tickers integer not null,
  summary jsonb not null
);
create index if not exists replay_runs_run_at on public.replay_runs (run_at desc);
alter table public.replay_runs enable row level security;
create policy replay_runs_select_authenticated on public.replay_runs
  for select to authenticated using (true);
