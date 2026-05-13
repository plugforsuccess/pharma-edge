-- top_plays_feed — cross-ticker scanner output.
--
-- scan-universe-plays iterates the SCAN_UNIVERSE every 15 min during
-- RTH, runs the same prompt as suggest-plays per ticker, and writes
-- one row per scan run with the ranked play list. The frontend reads
-- the latest row by computed_at; older rows stay for cost analysis
-- and "what would we have surfaced" backtests.

CREATE TABLE IF NOT EXISTS public.top_plays_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scan_kind TEXT NOT NULL DEFAULT 'rth_15min'
    CHECK (scan_kind IN ('rth_15min', 'eod', 'manual')),
  universe TEXT[] NOT NULL,
  tickers_scanned INTEGER NOT NULL,
  tickers_succeeded INTEGER NOT NULL,
  tickers_failed INTEGER NOT NULL,
  total_plays_generated INTEGER NOT NULL,
  total_plays_after_filter INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  total_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  ranked_plays JSONB NOT NULL,
  errors JSONB,
  CONSTRAINT non_negative_counts CHECK (
    tickers_scanned >= 0 AND tickers_succeeded >= 0 AND tickers_failed >= 0
    AND total_plays_generated >= 0 AND total_plays_after_filter >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_top_plays_feed_computed_at
  ON public.top_plays_feed (computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_top_plays_feed_scan_kind
  ON public.top_plays_feed (scan_kind, computed_at DESC);

ALTER TABLE public.top_plays_feed ENABLE ROW LEVEL SECURITY;

-- Public read. The feed shows the same plays a per-ticker call would
-- surface; nothing here is sensitive. Allowing anon also lets
-- unauth visitors on /leaderboard see what the system is generating.
DROP POLICY IF EXISTS "feed readable by anyone" ON public.top_plays_feed;
CREATE POLICY "feed readable by anyone"
  ON public.top_plays_feed FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "service role writes" ON public.top_plays_feed;
CREATE POLICY "service role writes"
  ON public.top_plays_feed FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.top_plays_feed IS
  'Cross-ticker scanner output. One row per scan run; current feed = latest row by computed_at.';
COMMENT ON COLUMN public.top_plays_feed.ranked_plays IS
  'Array of plays with ticker attached, sorted by ev_edge_bp DESC. Capped at MAX_PLAYS_PER_FEED.';
COMMENT ON COLUMN public.top_plays_feed.errors IS
  'Per-ticker error keyed by ticker. NULL when the scan was clean.';

-- Relax claude_calls.user_id to nullable so the scanner can write
-- system rows with user_id=NULL. RLS already restricts user SELECT
-- to (user_id = auth.uid()), so NULL rows are invisible to regular
-- users — they only surface in admin queries. Distinguishing rows
-- by function_name keeps per-user rate limits unaffected.
ALTER TABLE public.claude_calls ALTER COLUMN user_id DROP NOT NULL;

COMMENT ON COLUMN public.claude_calls.user_id IS
  'User who triggered the call. NULL for system-driven calls (scan-universe-plays cron). RLS hides NULL rows from non-admin users.';
