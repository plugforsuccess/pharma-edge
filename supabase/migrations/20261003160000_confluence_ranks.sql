-- Confluence ranking (owner, 2026-10-03): every ticker in the app's
-- universe scored nightly for lows (buy) and extended highs (sell) by
-- scripts/rank-confluence.mjs (.github/workflows/confluence-rank.yml).
--
-- confluence_ranks  one row per (side, ticker): today's score, lit signals,
--                   the blended estimate for today's combination and its
--                   rank (NULL = not eligible). Replaced each run.
-- confluence_pool   one row per (side, combination): that combination's
--                   record across the whole universe (counts, share at a
--                   swing low / high, averages) — the entry chart blends it
--                   in when a ticker has few cases of its own.
-- Shared market data, not user data: authenticated SELECT, service-role
-- write only (no insert / update policies), like gex_snapshots.
--
-- (Applied with execute_sql in parts: DROP statements hung on this project's
-- drop-time event trigger, so the live DDL avoided them.)
--
-- Alerts: confluence_top_buy (a Tracking / holding ticker entered the buy
-- top 10) and confluence_top_sell (a holding entered the sell top 10).

CREATE TABLE IF NOT EXISTS public.confluence_ranks (
  side            text NOT NULL CHECK (side IN ('buy', 'sell')),
  ticker          text NOT NULL CHECK (char_length(ticker) BETWEEN 1 AND 12),
  as_of           date NOT NULL,
  close           numeric,
  score           int  NOT NULL CHECK (score BETWEEN 0 AND 5),
  lit             text[] NOT NULL DEFAULT '{}',
  combo           text,
  conditions_met  int  CHECK (conditions_met IS NULL OR conditions_met BETWEEN 0 AND 5),
  trend_up        boolean,
  own_n           int  NOT NULL DEFAULT 0,
  pool_n          int  NOT NULL DEFAULT 0,
  est_at_turn     numeric,
  est_3m          numeric,
  est_6m          numeric,
  est_12m         numeric,
  est_win_6m      numeric,
  last_signal     date,
  rank            int,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (side, ticker)
);
CREATE INDEX IF NOT EXISTS confluence_ranks_side_rank_idx ON public.confluence_ranks (side, rank) WHERE rank IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.confluence_pool (
  side        text NOT NULL CHECK (side IN ('buy', 'sell')),
  combo       text NOT NULL,
  lit         text[] NOT NULL,
  score       int NOT NULL,
  n           int NOT NULL,
  graded      int NOT NULL,
  at_turn     numeric,
  avg_3m      numeric,
  avg_6m      numeric,
  avg_12m     numeric,
  win_3m      numeric,
  win_6m      numeric,
  win_12m     numeric,
  tickers     int NOT NULL,
  as_of       date NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (side, combo)
);

ALTER TABLE public.confluence_ranks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.confluence_pool ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS confluence_ranks_select_auth ON public.confluence_ranks;
CREATE POLICY confluence_ranks_select_auth ON public.confluence_ranks FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS confluence_pool_select_auth ON public.confluence_pool;
CREATE POLICY confluence_pool_select_auth ON public.confluence_pool FOR SELECT TO authenticated USING (true);

ALTER TABLE public.alerts DROP CONSTRAINT IF EXISTS alerts_alert_type_check;
ALTER TABLE public.alerts ADD CONSTRAINT alerts_alert_type_check CHECK (alert_type = any (array[
  'catalyst_approaching_14d', 'catalyst_approaching_7d', 'catalyst_tomorrow', 'outcome_reminder',
  'stop_loss_triggered', 'position_stop_loss', 'position_profit_50', 'position_profit_100',
  'position_profit_200', 'position_dte_21', 'position_expiring_tomorrow', 'position_filled',
  'position_closed', 'position_regime_shift', 'position_thesis_drifting',
  'position_thesis_invalidated', 'position_thesis_recovered',
  'entry_buy_zone', 'entry_hardening_bull',
  'confluence_top_buy', 'confluence_top_sell'
]::text[]));
