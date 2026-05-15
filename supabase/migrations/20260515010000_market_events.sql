-- market_events — generic scheduled-event calendar (gap #2).
--
-- The prompt has always referenced "if a known catalyst (CPI, FOMC,
-- earnings) overlaps your hold…" but Claude was never TOLD whether
-- one actually does — so it either ignored event risk or hallucinated
-- it. This table is the calendar; the suggest-plays prompt reads it
-- and, critically, the prompt now states explicitly what is and is
-- NOT known so Claude stops guessing.
--
-- Honest scope on day one: OPEX is already trustworthy (opex_dates,
-- holiday-adjusted, surfaced via #221) and is read separately.
-- macro/earnings rows go here once a real feed is wired (Polygon
-- Stocks tier for earnings; a maintained FOMC/CPI source for macro).
-- Until a row exists for a ticker/date, the prompt says so plainly
-- rather than fabricating — no synthetic dates.
--
-- ticker NULL = market-wide (FOMC, CPI, jobs). ticker set =
-- name-specific (earnings). event_date is the calendar day; time of
-- day captured in `session` (BMO/AMC/INTRADAY/UNKNOWN).

CREATE TABLE IF NOT EXISTS public.market_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_date  date NOT NULL,
  ticker      text,                       -- NULL = market-wide
  event_type  text NOT NULL,              -- 'earnings' | 'fomc' | 'cpi' | 'jobs' | 'opex' | 'other'
  session     text DEFAULT 'UNKNOWN',     -- 'BMO' | 'AMC' | 'INTRADAY' | 'UNKNOWN'
  label       text NOT NULL,
  source      text DEFAULT 'manual',
  fetched_at  timestamptz DEFAULT now(),
  CONSTRAINT market_events_type_chk
    CHECK (event_type IN ('earnings','fomc','cpi','jobs','opex','other'))
);

CREATE INDEX IF NOT EXISTS market_events_date_idx
  ON public.market_events (event_date);
CREATE INDEX IF NOT EXISTS market_events_ticker_date_idx
  ON public.market_events (ticker, event_date) WHERE ticker IS NOT NULL;

-- Uniqueness: one row per (date, coalesced ticker, type) so a
-- re-run of any future seeder upserts rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS market_events_unique_idx
  ON public.market_events (event_date, COALESCE(ticker, '__MARKET__'), event_type);

ALTER TABLE public.market_events ENABLE ROW LEVEL SECURITY;

-- Read-only to any authenticated user (it's a public calendar, not
-- user data); writes are service-role only (future seeder).
DROP POLICY IF EXISTS market_events_select_auth ON public.market_events;
CREATE POLICY market_events_select_auth
  ON public.market_events FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE public.market_events IS
  'Scheduled-event calendar (earnings/FOMC/CPI/jobs). Empty until a '
  'feed is wired; suggest-plays states explicitly when no event data '
  'exists rather than fabricating. OPEX lives in opex_dates, not here.';
