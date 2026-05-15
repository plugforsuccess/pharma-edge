-- Prior-calibration instrument (gap #7).
--
-- Every prior in the system — EV-edge LOUD/CLEAR/FAINT tiers, pin
-- thresholds, touch-count decay, node-ROC direction, the 66/33
-- retest numbers — is a hand-set heuristic, none measured against
-- this account's realised outcomes. You cannot calibrate what you
-- cannot measure, and fabricating "calibrated" numbers now would be
-- the synthetic-OI mistake. So this PR ships the MEASUREMENT, not
-- invented constants: a view that joins closed signals to the prior
-- that was active at entry, plus a rollup so the honest answer
-- ("n=2, insufficient") is visible until trade count grows — at
-- which point the priors get tuned from evidence, not vibes.
--
-- security_invoker = true: respects existing RLS, so each user sees
-- their OWN signal calibration (which is the right scope — priors
-- should ultimately be tuned per-account, not globally).

CREATE OR REPLACE VIEW public.prior_calibration
WITH (security_invoker = true)
AS
SELECT
  s.id                                AS signal_id,
  s.ticker,
  s.logged_at,
  s.target_thesis_kind,
  s.confidence_score,
  s.entry_pop_bp,
  -- EV edge captured on the chosen play (bp over breakeven PoP).
  NULLIF(s.claude_chosen_play->>'ev_edge_bp','')::numeric AS ev_edge_bp,
  -- EV-edge tier — MUST stay in lockstep with ConvictionDots.jsx
  -- tierFor(): LOUD >= 1500, CLEAR >= 500, else FAINT.
  CASE
    WHEN NULLIF(s.claude_chosen_play->>'ev_edge_bp','')::numeric >= 1500 THEN 'LOUD'
    WHEN NULLIF(s.claude_chosen_play->>'ev_edge_bp','')::numeric >=  500 THEN 'CLEAR'
    WHEN s.claude_chosen_play->>'ev_edge_bp' IS NOT NULL              THEN 'FAINT'
    ELSE NULL
  END AS ev_edge_tier,
  -- Confidence bucket for a coarser cross-tab.
  CASE
    WHEN s.confidence_score >= 8 THEN 'high (8-10)'
    WHEN s.confidence_score >= 5 THEN 'med (5-7)'
    WHEN s.confidence_score IS NOT NULL THEN 'low (<5)'
    ELSE NULL
  END AS confidence_bucket,
  o.pnl_percent,
  o.thesis_correct,
  o.catalyst_result,
  o.recorded_at,
  (o.pnl_percent > 0)                  AS was_winner
FROM public.signals s
JOIN public.outcomes o ON o.signal_id = s.id;

COMMENT ON VIEW public.prior_calibration IS
  'One row per closed signal: the prior active at entry (EV-edge '
  'tier, thesis kind, confidence bucket) vs the realised outcome. '
  'The instrument for calibrating heuristics from evidence — not a '
  'source of calibrated constants until trade count is sufficient.';

-- Rollup: realised hit-rate + avg P&L per (thesis kind, EV tier).
-- Run this to see whether LOUD actually wins more than CLEAR in
-- THIS account, and crucially whether n is large enough to trust
-- the answer yet. Until n is meaningful, the honest read is "not
-- enough data" — which the sample_size column makes unmissable.
CREATE OR REPLACE VIEW public.prior_calibration_rollup
WITH (security_invoker = true)
AS
SELECT
  target_thesis_kind,
  ev_edge_tier,
  count(*)                                          AS sample_size,
  round(avg((was_winner)::int) * 100, 1)            AS win_rate_pct,
  round(avg(pnl_percent), 1)                        AS avg_pnl_pct,
  round(avg((thesis_correct)::int) * 100, 1)        AS thesis_correct_pct
FROM public.prior_calibration
WHERE ev_edge_tier IS NOT NULL
GROUP BY target_thesis_kind, ev_edge_tier
ORDER BY target_thesis_kind, ev_edge_tier;

COMMENT ON VIEW public.prior_calibration_rollup IS
  'Realised win-rate / avg-P&L per (thesis_kind, ev_edge_tier). '
  'sample_size is the honesty column — do not retune any prior off '
  'a tier with a small n.';
