-- Puerto Rico residency for the after-tax LEAPS math.
--
-- * state_tax_rates.federal_exempt — residency where gains are excluded
--   from US federal income tax (IRC §933: PR-source income of a bona
--   fide Puerto Rico resident is not in federal gross income; gains on
--   appreciation accrued while resident are PR-source). When true, the
--   federal and NIIT components are 0 and only the territory's own tax
--   applies.
-- * leaps_tax_profiles.pr_act60_rate — Act 60 resident individual
--   investor decree rate on PR-source capital gains: 0 for decrees
--   obtained by 2026-12-31, 0.04 for applications from 2027 (Act
--   38-2026). NULL = no decree (regular PR tax applies).
--
-- Caveats (shown to users, modeled as estimates): appreciation accrued
-- BEFORE becoming a PR resident stays US-source / federally taxable
-- (and is US-source if sold within 10 years of moving); bona fide
-- residency requires the presence, tax-home and closer-connection
-- tests. Additive only.

ALTER TABLE public.state_tax_rates
  ADD COLUMN IF NOT EXISTS federal_exempt boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.state_tax_rates.federal_exempt IS
  'Gains excluded from US federal tax + NIIT for bona fide residents (Puerto Rico, IRC §933). Only post-move appreciation qualifies.';

ALTER TABLE public.leaps_tax_profiles
  ADD COLUMN IF NOT EXISTS pr_act60_rate numeric
    CHECK (pr_act60_rate IS NULL OR (pr_act60_rate >= 0 AND pr_act60_rate <= 0.99));

COMMENT ON COLUMN public.leaps_tax_profiles.pr_act60_rate IS
  'Puerto Rico Act 60 decree rate on PR-source capital gains: 0 (decree by 2026-12-31) or 0.04 (2027+). NULL = no decree.';

INSERT INTO public.state_tax_rates
  (tax_year, state_code, state_name, kind, ordinary, ltcg, ltcg_applies_to, ltcg_exclusion_pct, stcg, confidence, source_url, notes, federal_exempt)
VALUES
  (2026, 'PR', 'Puerto Rico', 'progressive', '{"single":[[0,0],[9000,0.07],[25000,0.14],[41500,0.25],[61500,0.33]],"mfj":[[0,0],[18000,0.07],[50000,0.14],[83000,0.25],[123000,0.33]]}'::jsonb, '{"single":[[0,0.15]]}'::jsonb, 'income', 0, NULL, 'low', 'https://www.dlapiper.com/insights/publications/2026/03/puerto-rico-individual-resident-investor-tax-benefits-extended-through-2055', 'Bona fide PR residents exclude PR-source income (incl. gains on post-move appreciation) from federal tax under IRC 933, so federal + NIIT are 0. PR ordinary brackets 0/7/14/25/33% (MFJ thresholds wider; upper MFJ thresholds assumed doubled). Long-term gains at the 15% PR preferential rate (not re-verified for 2026). Act 60 decree holders: 0% (decree by 2026-12-31) or 4% (2027+, Act 38-2026) — set per user. Pre-move appreciation remains federally taxable. Gradual-adjustment surtax on high incomes not modeled.', true)
ON CONFLICT (tax_year, state_code) DO NOTHING;
