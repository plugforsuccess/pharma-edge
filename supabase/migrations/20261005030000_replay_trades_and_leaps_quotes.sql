-- Pre-registered signal-engine test (docs/signal-engine/preregistration.md).
-- (Applied in two apply_migration calls without DROP statements — DROPs hang
-- on this project's drop-time event trigger.)
--
-- replay_trades: one row per strategy trade from the universe replay at the
-- calibrated IV premium, with the fields later tests need so they run off
-- this table without re-running the replay. Shared market data:
-- authenticated SELECT, service-role write.
CREATE TABLE IF NOT EXISTS public.replay_trades (
  id              bigserial PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES public.replay_runs(id) ON DELETE CASCADE,
  ticker          text NOT NULL,
  rule            text NOT NULL,
  exit_rule       text NOT NULL DEFAULT 'targets',
  signal_date     date NOT NULL,
  fill_date       date NOT NULL,
  fill_price      numeric,
  strike          numeric,
  cost            numeric,
  vol             numeric,
  vol_source      text,
  premium         numeric,
  slippage        numeric,
  div_yield       numeric,
  exit_reason     text,
  exit_date       date,
  days            int,
  open            boolean NOT NULL DEFAULT false,
  option_return   numeric,
  stock_return    numeric,
  best_stock      numeric,
  spy_control     numeric,
  spy_hold        numeric,
  dd_from_high    numeric,
  days_200_up     int,
  score           int,
  lit             text[],
  iv_rank_source  text,
  period          text
);
CREATE INDEX IF NOT EXISTS replay_trades_run_rule_idx ON public.replay_trades (run_id, rule);
CREATE INDEX IF NOT EXISTS replay_trades_ticker_idx ON public.replay_trades (ticker, signal_date);
ALTER TABLE public.replay_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY replay_trades_select_auth ON public.replay_trades FOR SELECT TO authenticated USING (true);

-- leaps_quotes: nightly, per ticker, the ~0.75-delta ~2-year call's bid /
-- ask / mid / IV from the app's own quote source (the 30-day ATM IV goes to
-- iv_history). Calibrates the IV proxy and the slippage tiers over time.
CREATE TABLE IF NOT EXISTS public.leaps_quotes (
  ticker       text NOT NULL,
  quote_date   date NOT NULL,
  spot         numeric,
  expiry       date,
  strike       numeric,
  bid          numeric,
  ask          numeric,
  mid          numeric,
  iv           numeric,
  delta        numeric,
  open_interest int,
  volume       int,
  dte          int,
  source       text NOT NULL DEFAULT 'yahoo',
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, quote_date)
);
ALTER TABLE public.leaps_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY leaps_quotes_select_auth ON public.leaps_quotes FOR SELECT TO authenticated USING (true);
