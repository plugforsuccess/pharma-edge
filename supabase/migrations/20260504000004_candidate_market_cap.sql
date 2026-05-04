-- Pharma Edge — candidate market cap field.
-- Allows the queue UI to badge mega-caps so reviewers don't have to
-- eyeball "is this a strategy-fit?". The strategy targets micro-cap
-- biotech (<$2B); anything > $10B is generally not actionable on a
-- single Phase 2/3 readout because the catalyst isn't material to
-- the parent's price.
ALTER TABLE scanner_candidates
  ADD COLUMN market_cap NUMERIC;
