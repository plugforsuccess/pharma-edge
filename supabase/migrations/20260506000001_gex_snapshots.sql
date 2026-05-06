-- gex_snapshots: shared 5-minute cache for compute-gex output.
--
-- GEX is market data, not user data, so the cache is shared across
-- all users — one ticker → one row. Service role writes via the
-- compute-gex edge function; authenticated clients can SELECT freely
-- (handy for client-side prefetch / showing "from cache N min ago"
-- without re-invoking the function).
--
-- TTL is enforced in the edge function (rows older than 5 minutes
-- trigger a recompute). We don't auto-purge stale rows — the cache
-- only ever covers tickers people actually viewed, so the table stays
-- bounded.

CREATE TABLE IF NOT EXISTS public.gex_snapshots (
    ticker TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gex_snapshots_computed_at_idx
    ON public.gex_snapshots (computed_at DESC);

ALTER TABLE public.gex_snapshots ENABLE ROW LEVEL SECURITY;

-- Authenticated read; no client write policy → INSERT/UPDATE/DELETE
-- are blocked for everyone except the service role.
CREATE POLICY "gex_snapshots_select_authenticated"
    ON public.gex_snapshots
    FOR SELECT
    TO authenticated
    USING (true);
