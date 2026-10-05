-- Track record with context (owner, 2026-10-05: the universe average alone
-- has no baseline). Per combination and horizon: median ("typical"), the
-- bad quarter (25th percentile for buys, 75th for sells) and the share that
-- beat the S&P 500 over the same window. Plus one baseline row per side,
-- combo '__any_day__': every ticker, every day, same horizons.
ALTER TABLE public.confluence_pool
  ADD COLUMN IF NOT EXISTS med_3m numeric, ADD COLUMN IF NOT EXISTS med_6m numeric, ADD COLUMN IF NOT EXISTS med_12m numeric,
  ADD COLUMN IF NOT EXISTS badq_3m numeric, ADD COLUMN IF NOT EXISTS badq_6m numeric, ADD COLUMN IF NOT EXISTS badq_12m numeric,
  ADD COLUMN IF NOT EXISTS beat_3m numeric, ADD COLUMN IF NOT EXISTS beat_6m numeric, ADD COLUMN IF NOT EXISTS beat_12m numeric;
ALTER TABLE public.confluence_ranks
  ADD COLUMN IF NOT EXISTS est_med_3m numeric, ADD COLUMN IF NOT EXISTS est_med_6m numeric,
  ADD COLUMN IF NOT EXISTS est_badq_3m numeric, ADD COLUMN IF NOT EXISTS est_badq_6m numeric,
  ADD COLUMN IF NOT EXISTS est_beat_3m numeric, ADD COLUMN IF NOT EXISTS est_beat_6m numeric;
NOTIFY pgrst, 'reload schema';
