-- reasoning_history: per-user, per-ticker log of every successful
-- suggest-plays evaluation.
--
-- Powers the /reasoning route's history panel: "Regime A · conf 0.81
-- · 2 plays" rows with timestamps, so users can see how the engine's
-- read of the tape evolved over the day.
--
-- Write path: suggest-plays inserts a row using the SERVICE_ROLE_KEY
-- after every successful Claude call. Failed calls (parse errors,
-- rate limits, Claude 5xx) don't log — keeps the table a clean
-- "what we actually told you" record, not a debug stream.
--
-- Read path: /reasoning queries (user_id = auth.uid()) for the most
-- recent 20 rows for the active ticker. RLS pins it to the calling
-- user — your evaluations aren't visible to anyone else.
--
-- Relationship to existing tables:
--   - claude_calls is the rate-limit ledger (1 row per Claude call,
--     used to enforce the per-user/hour cap). We could in theory
--     join through it — but claude_calls doesn't carry the play
--     payload or regime, just the timestamp. reasoning_history is
--     the rich version.
--   - play_suggestions stores the most recent suggest-plays output
--     keyed by (user_id, ticker) for the SuggestedPlays component.
--     reasoning_history is the time-series complement — many rows,
--     keyed by computed_at.

CREATE TABLE IF NOT EXISTS public.reasoning_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ticker          TEXT NOT NULL,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Regime classification from the LLM. 'mixed' = transition signal.
    regime          TEXT NOT NULL CHECK (regime IN ('A', 'B', 'mixed')),
    regime_explanation TEXT,

    -- Snapshot of the deterministic context at time of evaluation.
    -- These are pulled straight from the compute-gex response so the
    -- history panel can show regime drift without a second fetch.
    spot            NUMERIC,
    net_gex         NUMERIC,
    expected_move   NUMERIC,
    expected_move_pct NUMERIC,
    pinning_probability NUMERIC,

    -- The walls (call wall = largest +GEX strike, put wall = largest
    -- -GEX strike, flip = zero-gamma cross).
    call_wall       NUMERIC,
    put_wall        NUMERIC,
    flip_strike     NUMERIC,

    -- Number of plays returned this round, plus the full play payload
    -- as JSONB so we can re-render historical recommendations without
    -- a re-fetch. Strict typing of plays would be premature — the
    -- suggest-plays response shape evolves and JSONB lets it.
    play_count      INTEGER NOT NULL DEFAULT 0,
    plays           JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Aggregate confidence in [0,1]. Computed as a function of the
    -- per-play confidence values + regime certainty. The /reasoning
    -- history panel renders this as a sparkline so the user can see
    -- conviction drift.
    confidence      NUMERIC CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS reasoning_history_user_ticker_idx
    ON public.reasoning_history (user_id, ticker, computed_at DESC);

-- Most queries are "the last N evaluations for this user across all
-- tickers" for the global history panel. This index covers that
-- without requiring the per-ticker index above.
CREATE INDEX IF NOT EXISTS reasoning_history_user_recent_idx
    ON public.reasoning_history (user_id, computed_at DESC);

ALTER TABLE public.reasoning_history ENABLE ROW LEVEL SECURITY;

-- Authenticated users can SELECT only their own history.
CREATE POLICY "reasoning_history_select_own"
    ON public.reasoning_history
    FOR SELECT
    TO authenticated
    USING ((SELECT auth.uid()) = user_id);

-- INSERT/UPDATE/DELETE are service-role only — written by suggest-plays
-- after a successful Claude call, never by a client. No client write
-- policy → all client writes refused at the RLS layer.
