-- Pharma Edge — move paper-trading start date from per-device localStorage
-- to the user's profile row so progress survives device switches /
-- reinstalls. Frontend will lazily backfill localStorage values into
-- this column on next sign-in.

ALTER TABLE profiles
  ADD COLUMN paper_trading_started_at DATE;
