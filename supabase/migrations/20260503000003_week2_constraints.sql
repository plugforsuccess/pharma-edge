-- Pharma Edge — Week 2 hardening pass.
--
-- 1. Make outcomes truly 1:1 with signals so the frontend can safely take
--    `signal.outcomes[0]`.
-- 2. Drop pnl_percent from compute_outcome_hash. Postgres NUMERIC and JS
--    Number disagree on serialisation (12.50 vs 12.5), making the JS hash
--    verifier unreconcilable. PnL is a derived consequence of the trade;
--    the integrity hash should cover the thesis-aspect fields only.

ALTER TABLE outcomes
  ADD CONSTRAINT outcomes_signal_unique UNIQUE (signal_id);

CREATE OR REPLACE FUNCTION compute_outcome_hash()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  NEW.outcome_hash := encode(
    digest(
      json_build_object(
        'signal_id', NEW.signal_id,
        'catalyst_result', NEW.catalyst_result,
        'thesis_correct', NEW.thesis_correct,
        'exit_reason', NEW.exit_reason,
        'recorded_at', NEW.recorded_at
      )::text,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;
