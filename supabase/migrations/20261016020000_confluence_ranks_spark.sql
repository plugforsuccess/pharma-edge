-- The Leaders list's sparkline (owner, 2026-10-16: "state of the art like
-- Robinhood"): the last 63 daily closes per buy row, written nightly by
-- scripts/rank-confluence.mjs. Additive.
alter table public.confluence_ranks add column if not exists spark jsonb;
