-- Confidence drift on open positions: detect regime flips since
-- entry and fire a per-position alert when the dealer-positioning
-- regime that justified the trade no longer holds.
--
-- Design:
--   - open_positions.last_regime stores the regime classification
--     observed on the previous monitor-positions tick (A | B | mixed
--     | NULL when never observed).
--   - On each tick, monitor-positions derives the current regime
--     from the live dxlink_quotes data per the position's ticker.
--   - When current != last_regime AND last_regime IS NOT NULL,
--     fires a position_regime_shift alert. The first observation
--     just records the baseline (no alert).
--   - One-shot per shift: triggers_fired['position_regime_shift']
--     stores the timestamp of the most recent shift alert. If the
--     regime keeps oscillating, we still alert each new transition,
--     but not every cron tick within the same regime.
--
-- Alert type:
--   position_regime_shift — added to the alert_type CHECK constraint.
--   Payload includes the entry regime (where you opened) and the
--   current regime (where you are now), so the UI can render
--   "Regime A → Regime B since 11:42am".

ALTER TABLE public.open_positions
    ADD COLUMN IF NOT EXISTS last_regime TEXT
    CHECK (last_regime IS NULL OR last_regime IN ('A', 'B', 'mixed'));

DO $$
BEGIN
    -- Drop and re-add the alert_type CHECK constraint to include the
    -- new shift alert. The IF EXISTS guard makes this re-runnable.
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
            'position_regime_shift'
        ));
END $$;
