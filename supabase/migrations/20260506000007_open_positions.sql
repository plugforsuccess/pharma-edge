-- open_positions: live tracking of open spread trades.
--
-- Created when:
--   1. A signal is logged with spread strikes (LogSignal flow), OR
--   2. A place-order edge-function call fills (broker_order_id link), OR
--   3. The user manually adds a position via the "Add Position" UI
--      (used for trades placed outside the app, e.g. on Robinhood).
--
-- The monitor-positions edge function runs on a 5-min RTH cron,
-- polling the spread mid for each open position via Tastytrade
-- /market-data or Yahoo fallback, and firing alerts when the Wiley
-- Edge thresholds hit (-50% stop, +50/+100/+200 profit ladder,
-- DTE < 21, expiring tomorrow).
--
-- Lifecycle: status open → closed (manual close) | expired (DTE = 0).
-- DELETE is not permitted by RLS — the audit trail is sacred.

CREATE TABLE IF NOT EXISTS public.open_positions (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    signal_id                UUID REFERENCES public.signals(id),

    ticker                   TEXT NOT NULL,
    strategy_type            TEXT NOT NULL CHECK (strategy_type IN (
        'BULL_CALL', 'BEAR_PUT', 'BULL_PUT_CREDIT', 'BEAR_CALL_CREDIT', 'IRON_CONDOR'
    )),
    long_strike              NUMERIC NOT NULL,
    short_strike             NUMERIC NOT NULL,
    expiration               DATE NOT NULL,
    contracts                INTEGER NOT NULL CHECK (contracts > 0),

    -- OCC option symbols for direct chain lookup (computed when known;
    -- the monitor falls back to building them from ticker+strike+expiry
    -- if missing).
    long_occ_symbol          TEXT,
    short_occ_symbol         TEXT,

    entry_debit_per_spread   NUMERIC NOT NULL CHECK (entry_debit_per_spread >= 0),
    entry_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

    status                   TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'closed', 'expired')),
    closed_at                TIMESTAMPTZ,
    exit_credit_per_spread   NUMERIC,
    realized_pnl             NUMERIC,           -- net $ across all contracts

    -- Live tracking (updated by monitor-positions cron)
    last_mid_per_spread      NUMERIC,
    last_pnl_pct             NUMERIC,           -- (mid - entry) / entry × 100
    last_polled_at           TIMESTAMPTZ,
    last_poll_source         TEXT,              -- 'tastytrade' | 'yahoo' | 'manual'

    -- Triggers fired so far (idempotent — each fires once). Keys:
    --   stop_loss, profit_50, profit_100, profit_200, dte_21, expiring_tomorrow
    -- Values: ISO timestamp when the trigger fired.
    triggers_fired           JSONB NOT NULL DEFAULT '{}'::jsonb,

    source                   TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('catalyst', 'gex_play', 'manual')),
    broker_order_id          TEXT,
    thesis                   TEXT,

    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS open_positions_user_status_idx
    ON public.open_positions (user_id, status);

CREATE INDEX IF NOT EXISTS open_positions_open_polling_idx
    ON public.open_positions (last_polled_at NULLS FIRST)
    WHERE status = 'open';

ALTER TABLE public.open_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "open_positions_select_own"
    ON public.open_positions
    FOR SELECT
    TO authenticated
    USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "open_positions_insert_own"
    ON public.open_positions
    FOR INSERT
    TO authenticated
    WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "open_positions_update_own"
    ON public.open_positions
    FOR UPDATE
    TO authenticated
    USING ((SELECT auth.uid()) = user_id);

-- No DELETE policy — closed positions stay as audit trail. To "remove"
-- a position the user closes it (status='closed') instead.

-- Trigger: bump updated_at on every UPDATE so the dashboard widget
-- can sort by recency without us having to set it everywhere.
CREATE OR REPLACE FUNCTION public.open_positions_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS open_positions_touch_updated_at_trg ON public.open_positions;
CREATE TRIGGER open_positions_touch_updated_at_trg
    BEFORE UPDATE ON public.open_positions
    FOR EACH ROW
    EXECUTE FUNCTION public.open_positions_touch_updated_at();

-- Extend alerts.alert_type to cover the new position-monitoring events.
-- The send-alerts edge function reads alert_type to pick a template.
DO $$
BEGIN
    -- Drop and recreate the constraint with the new values added.
    -- Names without a "wiley_edge_" prefix because alerts already exists
    -- with the catalyst types — we're additive, not replacing.
    BEGIN
        ALTER TABLE public.alerts DROP CONSTRAINT IF EXISTS alerts_alert_type_check;
    EXCEPTION WHEN undefined_object THEN
        -- constraint name varies by environment; ignore
        NULL;
    END;

    ALTER TABLE public.alerts
        ADD CONSTRAINT alerts_alert_type_check
        CHECK (alert_type IN (
            'catalyst_approaching_14d',
            'catalyst_approaching_7d',
            'catalyst_tomorrow',
            'outcome_reminder',
            'stop_loss_triggered',
            'position_stop_loss',
            'position_profit_50',
            'position_profit_100',
            'position_profit_200',
            'position_dte_21',
            'position_expiring_tomorrow',
            'position_filled',
            'position_closed'
        ));
END $$;
