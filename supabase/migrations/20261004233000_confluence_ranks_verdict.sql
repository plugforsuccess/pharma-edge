-- Confluence leaders verdicts (owner, 2026-10-04): each ranked row says
-- whether the app's entry rule is met (enter / wait / watch on the buy side,
-- extended / turning on the sell side), what blocks it, the trade the replay
-- would price, and the structure stop. Written by scripts/rank-confluence.mjs.
ALTER TABLE public.confluence_ranks
  ADD COLUMN IF NOT EXISTS verdict    text CHECK (verdict IS NULL OR verdict IN ('enter', 'wait', 'watch', 'extended', 'turning')),
  ADD COLUMN IF NOT EXISTS blockers   jsonb,
  ADD COLUMN IF NOT EXISTS trade      jsonb,
  ADD COLUMN IF NOT EXISTS stop_price numeric,
  ADD COLUMN IF NOT EXISTS stop_date  date;
NOTIFY pgrst, 'reload schema';
