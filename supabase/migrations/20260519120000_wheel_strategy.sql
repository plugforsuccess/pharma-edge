-- wheel_strategy — cash-secured-put → assignment → covered-call cycle.
--
-- Scope decisions (locked with the owner before writing):
--   * ADDITIVE ONLY. The signal_hash payload (compute_signal_hash v2 =
--     ticker, direction, thesis, catalyst_date, logged_at,
--     confidence_score, entry_pop_bp) and enforce_signal_immutability_fn
--     are NOT touched. None of the columns below appear in either, so
--     the wheel state machine (assignment_status transitions etc.) can
--     advance on a live signal row without tripping immutability and
--     without changing the hash. This is what makes the feature
--     possible without editing protected code.
--   * Wheel legs reuse the existing GEX columns rather than duplicating
--     them: target_strike = the CSP/CC strike, target_king_node =
--     'put_wall' | 'call_wall', target_expiration = the leg expiry,
--     regime_at_entry + entry_gex_snapshot = the matrix at entry.
--     signal_source discriminates the leg: 'wheel_csp' | 'wheel_cc'.
--   * Catalyst-Window gate ships in "explicit UNVERIFIED" mode:
--     earnings_calendar + market_events are empty in this project (no
--     feed wired), opex_dates is trustworthy. catalyst_check records,
--     per suggestion, exactly what was verified vs. unverified so the
--     UI can warn instead of silently passing or silently zeroing.
--     When earnings data is later seeded the scanner tightens to a
--     hard gate with no schema change.

-- ---------------------------------------------------------------------
-- Part A — additive wheel-economics columns on signals.
-- All nullable: non-wheel rows are entirely unaffected and existing
-- RLS / triggers / hashes are unchanged.
-- ---------------------------------------------------------------------
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS wheel_cycle_id        uuid,
  ADD COLUMN IF NOT EXISTS collateral_cash       numeric,
  ADD COLUMN IF NOT EXISTS assignment_status     text,
  ADD COLUMN IF NOT EXISTS shares_held           integer,
  ADD COLUMN IF NOT EXISTS cost_basis            numeric,
  ADD COLUMN IF NOT EXISTS premium_collected     numeric,
  ADD COLUMN IF NOT EXISTS wheel_annualized_pct  numeric,
  ADD COLUMN IF NOT EXISTS catalyst_check        jsonb;

-- assignment_status is the wheel state machine. NULL = not a wheel
-- signal (the overwhelming majority of rows), so the constraint must
-- permit NULL. Allowed states:
--   open          — leg live, not yet resolved
--   expired_otm   — option expired worthless, premium kept
--   assigned      — CSP assigned: now holding shares, roll to CC leg
--   called_away   — CC assigned: shares sold at strike, cycle complete
--   rolled        — leg closed and re-opened (new signal row, same
--                    wheel_cycle_id)
--   closed        — leg bought back / cycle ended manually
ALTER TABLE public.signals
  DROP CONSTRAINT IF EXISTS signals_assignment_status_chk;
ALTER TABLE public.signals
  ADD CONSTRAINT signals_assignment_status_chk
  CHECK (
    assignment_status IS NULL
    OR assignment_status IN (
      'open','expired_otm','assigned','called_away','rolled','closed'
    )
  );

-- Cycle lookup: all legs of one wheel share wheel_cycle_id. Partial
-- index keeps it off the ~all-NULL non-wheel rows.
CREATE INDEX IF NOT EXISTS signals_wheel_cycle_idx
  ON public.signals (wheel_cycle_id)
  WHERE wheel_cycle_id IS NOT NULL;

COMMENT ON COLUMN public.signals.wheel_cycle_id IS
  'Groups CSP -> assignment -> CC legs of one wheel. NULL for non-wheel signals. Mutable (not in hash/immutability set).';
COMMENT ON COLUMN public.signals.assignment_status IS
  'Wheel leg state machine. NULL for non-wheel signals. Mutable by design so assignment lifecycle advances without tripping enforce_signal_immutability_fn.';
COMMENT ON COLUMN public.signals.catalyst_check IS
  'Per-leg event verification at entry, e.g. {"opex":"clear","earnings":"UNVERIFIED","macro":"UNVERIFIED"}. UNVERIFIED = no feed exists for that source in this project; UI must surface a manual-verify warning.';

-- ---------------------------------------------------------------------
-- Part B — wheel_suggestions feed (mirrors top_plays_feed).
-- One row per scan run. The current feed is the latest row by
-- computed_at; older rows stay for cost analysis + backtests.
--
-- gate_rejections is deliberate: it records, per ticker, WHICH of the
-- 7 entry conditions failed. An empty suggestion list is then always
-- explainable ("8 tickers, all rejected: 5 negative net GEX, 3 IV
-- rank < 30") instead of a silent zero — the exact failure mode this
-- codebase has been bitten by on scan-universe-plays.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wheel_suggestions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at             timestamptz NOT NULL DEFAULT now(),
  scan_kind               text NOT NULL DEFAULT 'rth'
    CHECK (scan_kind IN ('rth','eod','manual')),
  universe                text[] NOT NULL,
  tickers_scanned         integer NOT NULL,
  tickers_succeeded       integer NOT NULL,
  tickers_failed          integer NOT NULL,
  candidates_generated    integer NOT NULL,
  candidates_after_gate   integer NOT NULL,
  duration_ms             integer NOT NULL,
  ranked_suggestions      jsonb   NOT NULL,
  gate_rejections         jsonb,
  errors                  jsonb,
  CONSTRAINT wheel_suggestions_non_negative_chk CHECK (
    tickers_scanned >= 0 AND tickers_succeeded >= 0 AND tickers_failed >= 0
    AND candidates_generated >= 0 AND candidates_after_gate >= 0
  )
);

CREATE INDEX IF NOT EXISTS wheel_suggestions_computed_at_idx
  ON public.wheel_suggestions (computed_at DESC);
CREATE INDEX IF NOT EXISTS wheel_suggestions_scan_kind_idx
  ON public.wheel_suggestions (scan_kind, computed_at DESC);

ALTER TABLE public.wheel_suggestions ENABLE ROW LEVEL SECURITY;

-- Public read: same posture as top_plays_feed. The feed is generated
-- market analysis, not user data; anon read lets it render on public
-- surfaces. Writes are service-role only (the scanner cron).
DROP POLICY IF EXISTS wheel_suggestions_select_anyone ON public.wheel_suggestions;
CREATE POLICY wheel_suggestions_select_anyone
  ON public.wheel_suggestions FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS wheel_suggestions_service_writes ON public.wheel_suggestions;
CREATE POLICY wheel_suggestions_service_writes
  ON public.wheel_suggestions FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.wheel_suggestions IS
  'Wheel scanner output. One row per scan run; current feed = latest by computed_at. gate_rejections makes an empty feed explainable (no silent zeros).';
COMMENT ON COLUMN public.wheel_suggestions.ranked_suggestions IS
  'Array of CSP/CC candidates that passed all 7 entry conditions, sorted by wheel_annualized_pct DESC. Each carries catalyst_check so the UI can flag UNVERIFIED earnings/macro.';
COMMENT ON COLUMN public.wheel_suggestions.gate_rejections IS
  'Per-ticker map of which entry condition(s) failed. NULL only when every scanned ticker produced a passing candidate.';
