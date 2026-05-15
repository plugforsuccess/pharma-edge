-- Observability: make a "0 plays" scan self-explaining.
--
-- Before this, a scan where Claude proposed strong plays but every one
-- died at Polygon price-verification (the 5s-timeout silent-null wipe)
-- was indistinguishable in top_plays_feed from a genuine no-setup day.
-- That ambiguity is exactly what made "0 plays all day" un-diagnosable
-- — it looked like the R/R filter or a dead market when it was the
-- pricing provider timing out.
--
-- Additive, nullable. Null = nothing was rejected (true no-setup or a
-- clean scan). Populated = { pricing, rr, ev, pop, structure, proposed,
-- verified, by_ticker } so the cause is never silent again.

ALTER TABLE public.top_plays_feed
  ADD COLUMN IF NOT EXISTS pricing_rejections jsonb;

COMMENT ON COLUMN public.top_plays_feed.pricing_rejections IS
  'Why proposed plays were dropped in verifyAndFilter: counts by bucket '
  '(pricing/rr/ev/pop/structure) + proposed/verified totals + per-ticker '
  'breakdown. Null when no plays were rejected. Distinguishes a genuine '
  'no-setup scan from pricing-provider degradation / rate-limit wipes.';
