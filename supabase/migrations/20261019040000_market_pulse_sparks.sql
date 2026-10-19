-- Market card trend lines (owner, 2026-10-19): the S&P's streak on its side
-- of the 200-day and the last 3 months of S&P / VIX closes, written nightly
-- by rank-confluence.mjs (marketPulse). Additive.
alter table public.market_pulse
  add column if not exists spy_streak int,
  add column if not exists spy_spark jsonb,
  add column if not exists vix_spark jsonb;
