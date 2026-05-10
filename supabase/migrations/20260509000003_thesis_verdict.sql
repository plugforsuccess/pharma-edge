-- Phase 1+2 of dynamic thesis. Captures the current verdict on each
-- open position so the server-side cron knows when state has changed
-- and the client can render the verdict immediately on page load.
--
-- Verdict states:
--   intact         — entry-time positioning still holds; trade is good
--   drifting       — wall shifted, flip neared, or net GEX in transition
--                    zone. Half-size or watch.
--   invalidated    — regime flipped or target wall pierced. Exit
--                    consideration.
--   not_evaluable  — no entry_gex_snapshot, or live GEX unavailable
--
-- last_verdict_reasons is the human-readable reason list that the
-- verdict logic emits, persisted so push notifications include
-- specific copy ("regime flipped from A to B; spot pierced 720 wall").
--
-- Computed by monitor-positions on each poll AND by the frontend on
-- page load. Both use the same rules; persisted server-side for the
-- transition-detection flow that drives push notifications.

ALTER TABLE public.open_positions
    ADD COLUMN IF NOT EXISTS last_verdict TEXT
    CHECK (
        last_verdict IS NULL
        OR last_verdict IN ('intact', 'drifting', 'invalidated', 'not_evaluable')
    ),
    ADD COLUMN IF NOT EXISTS last_verdict_reasons JSONB,
    ADD COLUMN IF NOT EXISTS last_verdict_at TIMESTAMPTZ;

COMMENT ON COLUMN public.open_positions.last_verdict IS
'Dynamic thesis verdict: intact / drifting / invalidated / not_evaluable. Computed by monitor-positions on each poll. Compared against previous value to detect transitions and dispatch push notifications.';

-- Extend the alerts allowlist with the three new thesis-verdict
-- transition types. Drop + re-add pattern matches the existing
-- pattern in 20260508000003_position_regime_shift.sql.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'alerts_alert_type_check'
        AND conrelid = 'public.alerts'::regclass
    ) THEN
        ALTER TABLE public.alerts DROP CONSTRAINT alerts_alert_type_check;
    END IF;

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
            'position_closed',
            'position_regime_shift',
            'position_thesis_drifting',
            'position_thesis_invalidated',
            'position_thesis_recovered'
        ));
END $$;
