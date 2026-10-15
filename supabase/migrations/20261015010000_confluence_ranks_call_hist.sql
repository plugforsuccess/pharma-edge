-- Pullbacks rows: the suggested call's history 1 / 3 / 6 / 12 months after
-- past signals (this ticker + the universe + any-day yardstick).
alter table public.confluence_ranks add column if not exists call_hist jsonb;
