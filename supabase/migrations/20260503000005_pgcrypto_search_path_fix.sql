-- Pharma Edge — fix pgcrypto schema-qualification in hash triggers.
--
-- Background: Supabase installs `pgcrypto` into the `extensions` schema.
-- Migration 0002 set `search_path = public` on the trigger functions to
-- close the function_search_path_mutable security lint, which then made
-- the bare `digest(...)` call fail with `function digest(text, unknown)
-- does not exist`. Smoke testing surfaced this on the first INSERT.
--
-- Fix: fully qualify `extensions.digest(...)`. Keep search_path locked.

CREATE OR REPLACE FUNCTION compute_signal_hash()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  NEW.signal_hash := encode(
    extensions.digest(
      json_build_object(
        'ticker', NEW.ticker,
        'direction', NEW.direction,
        'thesis', NEW.thesis,
        'catalyst_date', NEW.catalyst_date,
        'logged_at', NEW.logged_at,
        'confidence_score', NEW.confidence_score
      )::text,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION compute_outcome_hash()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  NEW.outcome_hash := encode(
    extensions.digest(
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
