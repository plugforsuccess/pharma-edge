-- Universe GEX leaderboard: each scan also ranks the scanned tickers
-- by |net GEX| so /wheel always has useful content even when zero
-- CSPs pass. Additive + idempotent; RLS unchanged.
ALTER TABLE public.wheel_suggestions
  ADD COLUMN IF NOT EXISTS gex_ranking jsonb;

COMMENT ON COLUMN public.wheel_suggestions.gex_ranking IS
  'Scanned universe ranked by absolute net GEX desc: [{ticker, net_gex, spot, regime}]. Informational; independent of the 7-gate suggestion pipeline.';
