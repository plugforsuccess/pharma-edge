-- Outcomes: expand catalyst_result + exit_reason CHECK constraints to
-- cover the GEX/options-flow vocabulary the app actually writes today.
--
-- The original constraints (init_schema.sql) only allowed biotech
-- catalyst outcomes — approved / rejected / positive_data / etc. The
-- biotech pipeline was retired on 2026-05-09 and LogOutcomeModal +
-- deriveOutcome.js now emit GEX-era values, so every new outcome
-- insert was failing with `outcomes_catalyst_result_check`.
--
-- Legacy biotech values stay in the allow-list so historical rows
-- remain readable and the hash trigger can recompute their canonical
-- hash without rejecting them.

ALTER TABLE outcomes
  DROP CONSTRAINT IF EXISTS outcomes_catalyst_result_check;

ALTER TABLE outcomes
  ADD CONSTRAINT outcomes_catalyst_result_check CHECK (catalyst_result IN (
    -- GEX / options-flow era (LogOutcomeModal SPREAD_OUTCOMES)
    'wall_held',
    'target_broken_in_favor',
    'profit_target_hit',
    'wall_broken_against',
    'stop_loss',
    'regime_flipped',
    'theta_decay',
    'vol_crush',
    -- Legacy biotech era (kept for historical rows)
    'approved',
    'rejected',
    'complete_response_letter',
    'positive_data',
    'negative_data',
    'mixed_data',
    'delayed',
    'withdrawn',
    -- Shared
    'other'
  ));

ALTER TABLE outcomes
  DROP CONSTRAINT IF EXISTS outcomes_exit_reason_check;

ALTER TABLE outcomes
  ADD CONSTRAINT outcomes_exit_reason_check CHECK (exit_reason IS NULL OR exit_reason IN (
    'catalyst_resolved',
    'stop_loss_50pct',
    'thesis_invalidated',
    'profit_100pct',
    'profit_200pct',
    'pre_catalyst_exit',
    'dte_expired',
    'manual',
    -- Emitted by deriveOutcome.js when an auto_triggers row drove the close
    'auto_trigger'
  ));
