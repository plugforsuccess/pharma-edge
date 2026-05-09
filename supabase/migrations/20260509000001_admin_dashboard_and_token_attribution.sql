-- Token attribution + cost ledger on claude_calls. Stores both raw
-- token counts and a precomputed dollar cost so dashboard queries
-- don't have to multiply at read time. Cost is computed at insert
-- time in the edge function and the per-row value preserves the
-- price the call was actually charged at (future price changes
-- don't retroactively rewrite history).

ALTER TABLE public.claude_calls
    ADD COLUMN IF NOT EXISTS model TEXT,
    ADD COLUMN IF NOT EXISTS input_tokens INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS output_tokens INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(14, 6) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_claude_calls_called_at ON public.claude_calls (called_at DESC);
CREATE INDEX IF NOT EXISTS idx_claude_calls_user_called ON public.claude_calls (user_id, called_at DESC);

-- Admin gating. is_admin is set manually in production for the
-- platform owner's row; default false for everyone else. Used by
-- the /admin route + RLS policies below.
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Admin RLS policies — admins can SELECT all rows on tables they
-- need to read for the dashboard. Writes still flow through their
-- normal user-scoped policies; admin reads are additive.
DROP POLICY IF EXISTS claude_calls_select_admin ON public.claude_calls;
CREATE POLICY claude_calls_select_admin ON public.claude_calls
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.profiles
        WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_admin = TRUE
    ));

DROP POLICY IF EXISTS profiles_select_admin ON public.profiles;
CREATE POLICY profiles_select_admin ON public.profiles
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.profiles p2
        WHERE p2.id = (SELECT auth.uid())
        AND p2.is_admin = TRUE
    ));

DROP POLICY IF EXISTS signals_select_admin ON public.signals;
CREATE POLICY signals_select_admin ON public.signals
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.profiles
        WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_admin = TRUE
    ));

DROP POLICY IF EXISTS outcomes_select_admin ON public.outcomes;
CREATE POLICY outcomes_select_admin ON public.outcomes
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.profiles
        WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_admin = TRUE
    ));

DROP POLICY IF EXISTS scanner_runs_select_admin ON public.scanner_runs;
CREATE POLICY scanner_runs_select_admin ON public.scanner_runs
    FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.profiles
        WHERE profiles.id = (SELECT auth.uid())
        AND profiles.is_admin = TRUE
    ));

-- Daily cost rollup view. Aggregates per-day spend across functions
-- so the dashboard doesn't need to repeat the GROUP BY per render.
-- security_invoker=true so the underlying RLS still gates who can
-- read it (only admins).
CREATE OR REPLACE VIEW public.admin_cost_daily
WITH (security_invoker = true)
AS
SELECT
    date_trunc('day', called_at AT TIME ZONE 'UTC')::date AS day,
    function_name,
    COUNT(*) AS call_count,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_creation_tokens) AS cache_creation_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(cost_usd) AS cost_usd
FROM public.claude_calls
GROUP BY 1, 2;

GRANT SELECT ON public.admin_cost_daily TO authenticated;
