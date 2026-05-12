-- Whale-tail bot positions are single-leg long options (Buy to Open
-- call or put, no second leg). The existing open_positions schema
-- assumed all positions were verticals (long + short strike), so
-- short_strike was NOT NULL. Drop that constraint to support the
-- new strategy without forcing a synthetic sentinel value.

ALTER TABLE public.open_positions
  ALTER COLUMN short_strike DROP NOT NULL;

-- Track the highest mid price observed on a long option since entry.
-- Used by the whale-tail trailing-stop rule: once a position is up
-- ≥50%, close if mid drops 30% from peak. Updated by bot-evaluate-exits
-- on every poll. Null until first observation.

ALTER TABLE public.open_positions
  ADD COLUMN IF NOT EXISTS option_price_peak numeric;
