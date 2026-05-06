-- play_suggestions: 5-minute response cache for the suggest-plays
-- edge function. Keyed on `cache_key = "<ticker>|<account_size_bucket>"`
-- so two users with similar account sizes share cached Claude output
-- (saves API tokens — Claude calls are ~$0.04 each).
--
-- Service-role write only; authenticated SELECT for clients to read
-- their own cached results without re-burning a Claude call.

CREATE TABLE IF NOT EXISTS public.play_suggestions (
    cache_key   TEXT PRIMARY KEY,
    payload     JSONB NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS play_suggestions_computed_at_idx
    ON public.play_suggestions (computed_at DESC);

ALTER TABLE public.play_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "play_suggestions_select_authenticated"
    ON public.play_suggestions
    FOR SELECT
    TO authenticated
    USING (true);

-- Bucket existing claude_calls.function_name nullability if it doesn't
-- already exist (the analyze-signal flow inserts without function_name
-- in some paths). Safe no-op if already nullable.
ALTER TABLE public.claude_calls
    ADD COLUMN IF NOT EXISTS function_name TEXT;
