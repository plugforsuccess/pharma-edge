-- Auto-executed close orders + fill alert support.
--
-- monitor-positions now submits real broker close orders when a stop-
-- loss or profit-take trigger fires. We need columns on order_history
-- to distinguish auto-closes from user-initiated closes (so the audit
-- log + UI can flag them) and to record which trigger drove the
-- close.

ALTER TABLE public.order_history
    ADD COLUMN IF NOT EXISTS auto_executed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.order_history
    ADD COLUMN IF NOT EXISTS auto_close_strategy TEXT
    CHECK (auto_close_strategy IS NULL OR auto_close_strategy IN (
        'position_stop_loss',
        'position_profit_100',
        'position_profit_200'
    ));

-- The most common auto-execution audit query is "what auto-closed
-- in the last hour" for a fill-alert dashboard. Partial index keeps
-- it tight since 99% of order_history rows aren't auto.
CREATE INDEX IF NOT EXISTS order_history_auto_recent_idx
    ON public.order_history (submitted_at DESC)
    WHERE auto_executed = true;
