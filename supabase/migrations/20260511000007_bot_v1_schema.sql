-- Bot v1 schema: autonomous whale-tail trading.
--
-- Three new tables + extensions on existing ones:
--   * bot_config column on profiles (per-user bot parameters)
--   * bot_paused_until / bot_paused_reason on profiles (kill switch)
--   * whale_tail_alerts table (UW prints we observed/considered/acted on)
--   * bot_runs table (per-day audit + telemetry)
--   * 7 new auto_triggers.kind values for whale-tail lifecycle events

-- ── profiles: bot config + kill-switch state ──────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bot_config jsonb NOT NULL DEFAULT '{
    "enabled": false,
    "mode": "paper",
    "max_concurrent_positions": 3,
    "max_concurrent_exposure_pct": 30,
    "per_trade_max_loss_pct": 10,
    "max_trades_per_day": 3,
    "daily_loss_kill_pct": 20,
    "weekly_loss_kill_pct": 35,
    "consecutive_loss_pause_count": 3,
    "consecutive_loss_pause_minutes": 30,
    "min_premium_dollars": 500000,
    "min_otm_pct": 5,
    "max_otm_pct": 30,
    "min_dte": 7,
    "max_dte": 45,
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
    "live_account_number": null
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS bot_paused_until timestamptz,
  ADD COLUMN IF NOT EXISTS bot_paused_reason text;

-- ── whale_tail_alerts: every print we saw, what we did with it ──

CREATE TABLE IF NOT EXISTS public.whale_tail_alerts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  received_at           timestamptz NOT NULL DEFAULT now(),
  uw_trade_id           text NOT NULL,
  ticker                text NOT NULL,
  option_type           text NOT NULL CHECK (option_type IN ('C','P')),
  strike                numeric NOT NULL,
  expiry_date           date NOT NULL,
  premium_dollars       numeric NOT NULL,
  contracts             integer NOT NULL,
  side                  text NOT NULL CHECK (side IN ('buy','sell','mid')),
  is_sweep              boolean NOT NULL DEFAULT false,
  is_single_leg         boolean NOT NULL DEFAULT true,
  spot_at_print         numeric,
  otm_pct               numeric,
  dte                   integer,
  vol_oi_ratio          numeric,
  iv_rank               numeric,
  bid                   numeric,
  ask                   numeric,
  mid                   numeric,
  passes_filter         boolean NOT NULL,
  filter_failures       text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL CHECK (status IN (
                          'observed','queued','tailed','skipped_filter',
                          'skipped_caps','rejected_broker','failed'
                        )),
  triggered_position_id uuid REFERENCES public.open_positions(id),
  triggered_trigger_id  uuid REFERENCES public.auto_triggers(id),
  proposed_action       jsonb,
  raw_uw_payload        jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, uw_trade_id)
);

CREATE INDEX IF NOT EXISTS whale_tail_alerts_user_received_idx
  ON public.whale_tail_alerts (user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS whale_tail_alerts_status_idx
  ON public.whale_tail_alerts (user_id, status, received_at DESC);

ALTER TABLE public.whale_tail_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY whale_tail_alerts_select_own ON public.whale_tail_alerts
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY whale_tail_alerts_select_admin ON public.whale_tail_alerts
  FOR SELECT TO authenticated USING (public.is_admin());

REVOKE ALL ON public.whale_tail_alerts FROM anon, authenticated;
GRANT SELECT ON public.whale_tail_alerts TO authenticated;

-- ── bot_runs: per-day audit + telemetry ───────────────────────────

CREATE TABLE IF NOT EXISTS public.bot_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_date             date NOT NULL,
  mode                 text NOT NULL CHECK (mode IN (
                         'paper','live','paused','killed','event_blocked'
                       )),
  reason               text,
  starting_nlv         numeric,
  ending_nlv           numeric,
  trades_attempted     integer NOT NULL DEFAULT 0,
  trades_filled        integer NOT NULL DEFAULT 0,
  wins_count           integer NOT NULL DEFAULT 0,
  losses_count         integer NOT NULL DEFAULT 0,
  daily_pnl            numeric NOT NULL DEFAULT 0,
  daily_loss_cap       numeric,
  kill_switch_state    text NOT NULL DEFAULT 'armed',
  kill_switch_fired_at timestamptz,
  kill_switch_reason   text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, run_date)
);

CREATE INDEX IF NOT EXISTS bot_runs_user_date_idx
  ON public.bot_runs (user_id, run_date DESC);

ALTER TABLE public.bot_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY bot_runs_select_own ON public.bot_runs
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY bot_runs_select_admin ON public.bot_runs
  FOR SELECT TO authenticated USING (public.is_admin());

REVOKE ALL ON public.bot_runs FROM anon, authenticated;
GRANT SELECT ON public.bot_runs TO authenticated;

-- ── auto_triggers: new whale-tail kind values ─────────────────────

ALTER TABLE public.auto_triggers
  DROP CONSTRAINT IF EXISTS auto_triggers_kind_check;

ALTER TABLE public.auto_triggers
  ADD CONSTRAINT auto_triggers_kind_check CHECK (kind IN (
    'stop_loss_50',
    'profit_take_100',
    'profit_take_200',
    'thesis_invalidated',
    'whale_entry',
    'whale_profit_take_100',
    'whale_profit_take_200',
    'whale_stop_50',
    'whale_time_stop',
    'whale_trailing_stop',
    'whale_kill_switch'
  ));
