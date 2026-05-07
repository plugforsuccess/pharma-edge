-- Extend signals.structure CHECK to allow credit spreads + iron condor.
--
-- Pre-existing values: naked_put, bear_put_spread, naked_call,
-- bull_call_spread, watch. The Suggested Plays edge function
-- (suggest-plays) returns 5 GEX-driven spread structures but only
-- 2 (bull_call_spread, bear_put_spread) could be logged because the
-- DB constraint rejected the others. This adds:
--   - iron_condor       (delta-neutral pin trade)
--   - bull_put_credit   (bullish, premium-collection)
--   - bear_call_credit  (bearish, premium-collection)
--
-- Direction column unchanged: credit spreads still use 'long_call' /
-- 'long_put' to encode the directional bias (a Bear Call Credit is
-- bearish even though it's built from calls). Iron condors use 'watch'
-- as the neutral marker so we don't have to extend the direction enum.

ALTER TABLE public.signals
  DROP CONSTRAINT IF EXISTS signals_structure_check;

ALTER TABLE public.signals
  ADD CONSTRAINT signals_structure_check
  CHECK (structure IS NULL OR structure IN (
    'naked_put',
    'bear_put_spread',
    'naked_call',
    'bull_call_spread',
    'iron_condor',
    'bull_put_credit',
    'bear_call_credit',
    'watch'
  ));

COMMENT ON CONSTRAINT signals_structure_check ON public.signals IS
  'Allowed spread structures. Extended 2026-05-07 to add credit spreads + iron condor so Suggested Plays can log all 5 GEX-driven structures, not just debit spreads.';
