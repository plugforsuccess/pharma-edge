-- gex_history: time-series archive of compute-gex matrix payloads.
--
-- Populated by a 5-minute GitHub Action cron during US market hours
-- which calls compute-gex with `archive: true` for every hot ticker;
-- the function inserts a row here after computing the result.
--
-- The /markets page reads this table when the user toggles "Replay
-- mode" — a time slider below the heatmap scrubs through the day's
-- snapshots, re-rendering the matrix from each historical payload.
--
-- We don't hash-anchor or immutability-trigger this table — it's
-- market data, not user signals. Stale rows (>30 days) are pruned
-- by an out-of-band housekeeping job (TODO; not blocking ship).

CREATE TABLE IF NOT EXISTS public.gex_history (
    ticker      TEXT NOT NULL,
    snapshot_at TIMESTAMPTZ NOT NULL,
    payload     JSONB NOT NULL,
    PRIMARY KEY (ticker, snapshot_at)
);

-- Most queries are "give me the last N hours for ticker X" — descending
-- index on snapshot_at within each ticker partition makes that a
-- bounded backward scan.
CREATE INDEX IF NOT EXISTS gex_history_ticker_snapshot_idx
    ON public.gex_history (ticker, snapshot_at DESC);

ALTER TABLE public.gex_history ENABLE ROW LEVEL SECURITY;

-- Authenticated read; no client write policy → INSERT/UPDATE/DELETE
-- gated to service role only (which the compute-gex archive path uses
-- via SUPABASE_SERVICE_ROLE_KEY).
CREATE POLICY "gex_history_select_authenticated"
    ON public.gex_history
    FOR SELECT
    TO authenticated
    USING (true);
