-- Tastytrade market data for LEAPS (owner, 2026-10-06: "use Tastytrade for
-- LEAPS data", items 1–2).
--
-- market_metrics: one row per underlying from Tastytrade /market-metrics —
-- IV index, IV rank / percentile, historical vols, beta, liquidity, next
-- earnings and dividend dates. Written nightly by the market-metrics edge
-- function (service role); read by leaps-entry (entry chart) and
-- suggest-leaps (vol rank). Shared market data: authenticated SELECT.
--
-- leaps_watch: the LEAPS contracts the dxlink-worker should stream —
-- suggest-leaps writes its picks here; the worker also reads every open
-- option holding from leaps_positions. Quotes land in dxlink_quotes keyed
-- by streamer symbol with underlying / expiration / strike / type, so the
-- app finds them without knowing the symbol.

CREATE TABLE IF NOT EXISTS public.market_metrics (
  symbol              text PRIMARY KEY,
  iv                  numeric,          -- implied-volatility-index, decimal (0.32 = 32%)
  iv_rank             numeric,          -- 0–100
  iv_percentile       numeric,          -- 0–100
  iv_5d_change        numeric,
  hv_30               numeric,          -- decimal
  hv_60               numeric,
  hv_90               numeric,
  iv_hv_30_diff       numeric,
  beta                numeric,
  liquidity_rating    integer,
  liquidity_value     numeric,
  earnings_date       date,
  earnings_time       text,
  earnings_actual_eps numeric,
  dividend_next_date  date,
  dividend_yield      numeric,
  market_cap          numeric,
  pe_ratio            numeric,
  iv_updated_at       timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.market_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_metrics_select_authenticated ON public.market_metrics;
CREATE POLICY market_metrics_select_authenticated ON public.market_metrics
  FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.leaps_watch (
  occ_symbol       text PRIMARY KEY,   -- OCC, root padded to 6 (Tastytrade form)
  ticker           text NOT NULL,
  expiration_date  date NOT NULL,
  strike           numeric NOT NULL,
  option_type      text NOT NULL CHECK (option_type IN ('C', 'P')),
  source           text NOT NULL,      -- 'suggest' | 'index' | 'position'
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leaps_watch_updated_idx ON public.leaps_watch (updated_at);
ALTER TABLE public.leaps_watch ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leaps_watch_select_authenticated ON public.leaps_watch;
CREATE POLICY leaps_watch_select_authenticated ON public.leaps_watch
  FOR SELECT TO authenticated USING (true);
