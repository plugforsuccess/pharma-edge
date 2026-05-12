-- Multi-strategy bot schema.
--
-- Extends the v1 (whale-tail-only) infrastructure to support three
-- additional strategies running side-by-side under a shared risk gate:
--   * iv_meanrev    — short premium when IV percentile > 80 in chop
--   * earnings_crush — short straddles / iron condors BMO-only earnings
--   * opex_pin      — pin trades into monthly OPEX on Regime A tickers
--
-- Design decisions:
--   1. whale_tail_alerts stays as-is (uw_trade_id-keyed, single-leg
--      print-driven). We add a new generic bot_signals table for the
--      other strategies — they don't have a UW print to key on.
--   2. open_positions.strategy_type CHECK is widened to include the
--      new structures. Existing single-leg whale rows use whale_long_*.
--   3. bot_config gets per-strategy enable/disable + per-strategy
--      capital allocation (must sum to ≤ 100%). Risk allocator reads
--      these to gate which strategies fire.
--   4. earnings_calendar / opex_dates / iv_history are read-only
--      reference tables. Service-role writes (scheduled job inserts).
--      Authenticated SELECT — these aren't user-specific.

-- ── 1. Extend open_positions.strategy_type ────────────────────────

ALTER TABLE public.open_positions
  DROP CONSTRAINT IF EXISTS open_positions_strategy_type_check;

ALTER TABLE public.open_positions
  ADD CONSTRAINT open_positions_strategy_type_check CHECK (strategy_type IN (
    -- Manual / GEX log-signal verticals
    'BULL_CALL', 'BEAR_PUT', 'BULL_PUT_CREDIT', 'BEAR_CALL_CREDIT', 'IRON_CONDOR',
    -- Whale-tail single-leg longs
    'whale_long_call', 'whale_long_put',
    -- IV mean-reversion (short premium)
    'short_iron_condor', 'short_strangle', 'short_put_credit', 'short_call_credit',
    -- Earnings IV crush
    'earnings_iron_condor', 'earnings_iron_butterfly',
    -- OPEX pin
    'opex_iron_butterfly', 'opex_iron_condor'
  ));

-- Iron condors / butterflies have FOUR legs. Existing schema has
-- long_strike / short_strike (2 legs). Add the two extra leg fields
-- as nullable additive columns. Two-leg structures leave them null.
--
-- Naming convention for 4-leg structures:
--   long_put_strike  < short_put_strike  < short_call_strike < long_call_strike
--   (in open_positions: long_strike = long_put, short_strike = short_put,
--                       short_call_strike, long_call_strike)
ALTER TABLE public.open_positions
  ADD COLUMN IF NOT EXISTS short_call_strike numeric,
  ADD COLUMN IF NOT EXISTS long_call_strike  numeric,
  ADD COLUMN IF NOT EXISTS short_call_occ_symbol text,
  ADD COLUMN IF NOT EXISTS long_call_occ_symbol  text,
  ADD COLUMN IF NOT EXISTS strategy text;  -- bot strategy slug; null for manual

-- Backfill strategy column for existing whale-tail rows so admin
-- telemetry can group by strategy.
UPDATE public.open_positions
SET strategy = CASE
  WHEN strategy_type IN ('whale_long_call','whale_long_put') THEN 'whale_tail'
  ELSE NULL
END
WHERE strategy IS NULL;

-- Source enum: widen to cover all bot strategies.
ALTER TABLE public.open_positions
  DROP CONSTRAINT IF EXISTS open_positions_source_check;

ALTER TABLE public.open_positions
  ADD CONSTRAINT open_positions_source_check CHECK (source IN (
    'catalyst','gex_play','manual',
    'whale_tail_bot','iv_meanrev_bot','earnings_crush_bot','opex_pin_bot'
  ));

-- ── 2. bot_config: per-strategy controls ──────────────────────────

-- Add per-strategy section to the default config. Existing rows get
-- the section merged in (anyone who's customized gets the new fields
-- without losing what they set).
ALTER TABLE public.profiles
  ALTER COLUMN bot_config SET DEFAULT '{
    "enabled": false,
    "mode": "paper",
    "max_concurrent_positions": 3,
    "max_concurrent_exposure_pct": 30,
    "per_trade_max_loss_pct": 4,
    "max_trades_per_day": 5,
    "daily_loss_kill_pct": 20,
    "weekly_loss_kill_pct": 35,
    "consecutive_loss_pause_count": 3,
    "consecutive_loss_pause_minutes": 30,
    "min_premium_dollars": 500000,
    "min_otm_pct": 5,
    "max_otm_pct": 30,
    "min_dte": 7,
    "max_dte": 60,
    "min_vol_oi_ratio": 2,
    "max_bid_ask_pct": 10,
    "entry_window_start": "10:30",
    "entry_window_end": "15:30",
    "max_iv_rank": 60,
    "max_weekly_stock_move_pct": 30,
    "min_stock_daily_volume_dollars": 50000000,
    "event_block_days": ["FOMC", "CPI", "NFP", "OPEX"],
    "earnings_skip_window_days": 7,
    "sandbox_account_number": null,
    "live_account_number": null,
    "dry_run": false,
    "strategies": {
      "whale_tail": {
        "enabled": true,
        "capital_allocation_pct": 50,
        "kill_switch": false
      },
      "iv_meanrev": {
        "enabled": false,
        "capital_allocation_pct": 20,
        "kill_switch": false,
        "min_iv_percentile": 80,
        "target_dte": 30,
        "wing_width_pct": 5,
        "body_width_pct": 2
      },
      "earnings_crush": {
        "enabled": false,
        "capital_allocation_pct": 15,
        "kill_switch": false,
        "min_iv_percentile": 70,
        "bmo_only": true,
        "skip_if_consensus_eps_estimates_lt": 3
      },
      "opex_pin": {
        "enabled": false,
        "capital_allocation_pct": 15,
        "kill_switch": false,
        "regime_a_only": true,
        "min_gex_wall_distance_pct": 2,
        "max_dte": 5
      }
    }
  }'::jsonb;

-- Merge the new "strategies" + "dry_run" keys into existing profile rows
-- without clobbering customizations. Anyone who already has a strategies
-- block keeps it; everyone else gets the defaults.
UPDATE public.profiles
SET bot_config = bot_config
  || (CASE WHEN bot_config ? 'strategies' THEN '{}'::jsonb ELSE '{
      "strategies": {
        "whale_tail":     {"enabled": true,  "capital_allocation_pct": 50, "kill_switch": false},
        "iv_meanrev":     {"enabled": false, "capital_allocation_pct": 20, "kill_switch": false, "min_iv_percentile": 80, "target_dte": 30, "wing_width_pct": 5, "body_width_pct": 2},
        "earnings_crush": {"enabled": false, "capital_allocation_pct": 15, "kill_switch": false, "min_iv_percentile": 70, "bmo_only": true, "skip_if_consensus_eps_estimates_lt": 3},
        "opex_pin":       {"enabled": false, "capital_allocation_pct": 15, "kill_switch": false, "regime_a_only": true, "min_gex_wall_distance_pct": 2, "max_dte": 5}
      }
     }'::jsonb END)
  || (CASE WHEN bot_config ? 'dry_run' THEN '{}'::jsonb ELSE '{"dry_run": false}'::jsonb END);

-- ── 3. bot_signals: generic non-whale strategy signal queue ───────

CREATE TABLE IF NOT EXISTS public.bot_signals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy              text NOT NULL CHECK (strategy IN (
                          'iv_meanrev','earnings_crush','opex_pin'
                        )),
  ticker                text NOT NULL,
  detected_at           timestamptz NOT NULL DEFAULT now(),

  -- Proposed structure (4-leg ready)
  structure             text NOT NULL,    -- short_iron_condor, earnings_iron_condor, opex_iron_butterfly, etc.
  expiry_date           date NOT NULL,
  long_put_strike       numeric,
  short_put_strike      numeric,
  short_call_strike     numeric,
  long_call_strike      numeric,
  contracts             integer,

  -- Pricing inputs at detection
  spot_at_signal        numeric,
  iv_percentile         numeric,
  iv_rank               numeric,
  net_credit_per_lot    numeric,
  max_loss_per_lot      numeric,
  estimated_pop         numeric,
  reward_risk_ratio     numeric,
  ev_edge               numeric,    -- estimated_pop - breakeven_pop

  -- Strategy-specific context
  regime                text,       -- A | B | mixed
  context               jsonb,      -- e.g. {earnings_date, bmo_amc, consensus_eps_estimates}

  -- Risk gate outcome
  passes_filter         boolean NOT NULL,
  filter_failures       text[] NOT NULL DEFAULT '{}',

  status                text NOT NULL CHECK (status IN (
                          'observed','queued','tailed','skipped_filter',
                          'skipped_caps','rejected_broker','failed'
                        )),
  triggered_position_id uuid REFERENCES public.open_positions(id),
  triggered_trigger_id  uuid REFERENCES public.auto_triggers(id),

  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bot_signals_user_detected_idx
  ON public.bot_signals (user_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS bot_signals_user_strategy_status_idx
  ON public.bot_signals (user_id, strategy, status, detected_at DESC);

ALTER TABLE public.bot_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY bot_signals_select_own ON public.bot_signals
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY bot_signals_select_admin ON public.bot_signals
  FOR SELECT TO authenticated USING (public.is_admin());

REVOKE ALL ON public.bot_signals FROM anon, authenticated;
GRANT SELECT ON public.bot_signals TO authenticated;

-- ── 4. earnings_calendar: BMO/AMC announcements ───────────────────

CREATE TABLE IF NOT EXISTS public.earnings_calendar (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker             text NOT NULL,
  earnings_date      date NOT NULL,
  announcement_time  text NOT NULL CHECK (announcement_time IN ('BMO','AMC','UNKNOWN')),
  consensus_eps      numeric,
  consensus_revenue  numeric,
  estimate_count     integer,
  source             text NOT NULL DEFAULT 'polygon',
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, earnings_date)
);

CREATE INDEX IF NOT EXISTS earnings_calendar_date_idx
  ON public.earnings_calendar (earnings_date, announcement_time);

ALTER TABLE public.earnings_calendar ENABLE ROW LEVEL SECURITY;

CREATE POLICY earnings_calendar_select_all ON public.earnings_calendar
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.earnings_calendar FROM anon, authenticated;
GRANT SELECT ON public.earnings_calendar TO authenticated;

-- ── 5. opex_dates: monthly + quarterly OPEX ───────────────────────

CREATE TABLE IF NOT EXISTS public.opex_dates (
  opex_date          date PRIMARY KEY,
  opex_type          text NOT NULL CHECK (opex_type IN ('monthly','quarterly','annual')),
  is_quarterly       boolean NOT NULL DEFAULT false,
  notes              text
);

ALTER TABLE public.opex_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY opex_dates_select_all ON public.opex_dates
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.opex_dates FROM anon, authenticated;
GRANT SELECT ON public.opex_dates TO authenticated;

-- Seed the next 12 monthly OPEX dates (third Friday of each month).
-- Job: scraper/seed_opex_dates.py refreshes this annually.
INSERT INTO public.opex_dates (opex_date, opex_type, is_quarterly) VALUES
  ('2026-05-15', 'monthly',   false),
  ('2026-06-19', 'quarterly', true),
  ('2026-07-17', 'monthly',   false),
  ('2026-08-21', 'monthly',   false),
  ('2026-09-18', 'quarterly', true),
  ('2026-10-16', 'monthly',   false),
  ('2026-11-20', 'monthly',   false),
  ('2026-12-18', 'quarterly', true),
  ('2027-01-15', 'monthly',   false),
  ('2027-02-19', 'monthly',   false),
  ('2027-03-19', 'quarterly', true),
  ('2027-04-16', 'monthly',   false)
ON CONFLICT (opex_date) DO NOTHING;

-- ── 6. iv_history: rolling IV samples for percentile lookup ──────

CREATE TABLE IF NOT EXISTS public.iv_history (
  ticker        text NOT NULL,
  sample_date   date NOT NULL,
  iv_30d        numeric,
  iv_60d        numeric,
  hv_20d        numeric,
  source        text NOT NULL DEFAULT 'polygon',
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, sample_date)
);

CREATE INDEX IF NOT EXISTS iv_history_ticker_date_idx
  ON public.iv_history (ticker, sample_date DESC);

ALTER TABLE public.iv_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY iv_history_select_all ON public.iv_history
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.iv_history FROM anon, authenticated;
GRANT SELECT ON public.iv_history TO authenticated;

-- ── 7. regime_snapshots: bot's regime decision per ticker ─────────

CREATE TABLE IF NOT EXISTS public.regime_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker             text NOT NULL,
  snapshot_at        timestamptz NOT NULL DEFAULT now(),
  regime             text NOT NULL CHECK (regime IN ('A','B','mixed','unknown')),
  confidence         numeric,   -- 0..1
  spot               numeric,
  zero_gamma         numeric,
  net_gex            numeric,
  call_wall          numeric,
  put_wall           numeric,
  flow_direction     text,      -- 'calls_dominant'|'puts_dominant'|'balanced'
  context            jsonb,
  ttl_minutes        integer NOT NULL DEFAULT 30
);

CREATE INDEX IF NOT EXISTS regime_snapshots_ticker_at_idx
  ON public.regime_snapshots (ticker, snapshot_at DESC);

ALTER TABLE public.regime_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY regime_snapshots_select_all ON public.regime_snapshots
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.regime_snapshots FROM anon, authenticated;
GRANT SELECT ON public.regime_snapshots TO authenticated;

-- ── 8. auto_triggers: new kinds for non-whale strategies ──────────

ALTER TABLE public.auto_triggers
  DROP CONSTRAINT IF EXISTS auto_triggers_kind_check;

ALTER TABLE public.auto_triggers
  ADD CONSTRAINT auto_triggers_kind_check CHECK (kind IN (
    -- Manual / GEX verticals
    'stop_loss_50','profit_take_100','profit_take_200','thesis_invalidated',
    -- Whale-tail
    'whale_entry','whale_profit_take_100','whale_profit_take_200',
    'whale_stop_50','whale_time_stop','whale_trailing_stop','whale_kill_switch',
    -- IV mean-reversion
    'meanrev_entry','meanrev_profit_take_50','meanrev_stop_2x','meanrev_time_stop',
    -- Earnings IV crush
    'earnings_entry','earnings_profit_take_50','earnings_stop_2x','earnings_close_open',
    -- OPEX pin
    'opex_entry','opex_profit_take_75','opex_stop_2x','opex_close_eod'
  ));

-- ── 9. bot_runs: track per-strategy outcomes too ─────────────────

ALTER TABLE public.bot_runs
  ADD COLUMN IF NOT EXISTS strategy_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Schema:
--   {
--     "whale_tail":     {"attempted": 2, "filled": 1, "wins": 0, "losses": 1, "pnl": -120},
--     "iv_meanrev":     {"attempted": 1, "filled": 1, "wins": 1, "losses": 0, "pnl":  85},
--     ...
--   }
