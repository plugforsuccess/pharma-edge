-- Rule optimizer results (scripts/optimize-entries.mjs, owner 2026-10-04):
-- one row per run — the entry × exit rule search over the universe with
-- walk-forward folds, the validated best, the baseline and the frontier.
-- Shared research, not user data: authenticated SELECT, service-role write.
create table if not exists public.optimizer_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  as_of date not null,
  tickers integer not null,
  summary jsonb not null
);
create index if not exists optimizer_runs_run_at on public.optimizer_runs (run_at desc);
alter table public.optimizer_runs enable row level security;
create policy optimizer_runs_select_authenticated on public.optimizer_runs
  for select to authenticated using (true);
