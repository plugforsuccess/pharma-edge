-- Adds entry-time Profit-of-Profit (POP) prediction to the signal record,
-- INSIDE the SHA-256 hash chain so it can't be retroactively shifted to
-- inflate calibration scores. Also bumps the hash to v2 so existing
-- signals' v1 hashes stay verifiable.
--
-- Storage choice: integer basis points (0–10000), not NUMERIC.
-- Reason: src/utils/hash.js explicitly avoids NUMERIC in the payload
-- because PG NUMERIC vs JS Number serialisation diverges on trailing
-- zeros (PG's to_json preserves NUMERIC scale, JSON.stringify strips
-- trailing zeros). Integers serialise byte-identically on both sides
-- so the hash matches without fragile format-string juggling.
--
-- Hash version is the lever. Existing signals are stamped hash_version=1
-- via column default at backfill time; the trigger and the JS verifier
-- both branch on hash_version so:
--   * v1 rows → original 6-field payload (no entry_pop_bp)
--   * v2 rows → 7-field payload including entry_pop_bp (or null)
-- This means existing public-record verification continues to work
-- without recomputing any historical hashes.

-- ─── Schema additions ──────────────────────────────────────────────

ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS entry_pop_bp INTEGER
    CHECK (entry_pop_bp IS NULL OR (entry_pop_bp >= 0 AND entry_pop_bp <= 10000));

COMMENT ON COLUMN public.signals.entry_pop_bp IS
  'Probability of profit at expiration in basis points (0–10000), computed at signal-lock time from spot, breakeven, IV, and DTE under the Black-Scholes lognormal assumption. Locked into the v2 signal_hash so the prediction cannot be retroactively shifted.';

-- Existing rows get hash_version=1 (matching their stored signal_hash,
-- which was computed without entry_pop_bp). The default flips to 2
-- after the backfill so all NEW inserts produce v2 hashes.
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS hash_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.signals
  ALTER COLUMN hash_version SET DEFAULT 2;

COMMENT ON COLUMN public.signals.hash_version IS
  'Which JSON payload definition the signal_hash was computed against. v1 = original 6 fields. v2 = adds entry_pop_bp. Bumping this on an existing row would break verification, so the immutability trigger blocks it.';

-- ─── Hash trigger v2 ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_signal_hash()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  payload TEXT;
BEGIN
  -- Branch on hash_version so v1 signals keep their existing 6-field
  -- payload exactly. New inserts default to hash_version=2 and get
  -- the 7-field payload that includes entry_pop_bp (or null).
  IF NEW.hash_version = 2 THEN
    payload :=
      '{"ticker":'                || to_json(NEW.ticker)::text                                          ||
      ',"direction":'             || to_json(NEW.direction)::text                                       ||
      ',"thesis":'                || to_json(NEW.thesis)::text                                          ||
      ',"catalyst_date":'         || to_json(NEW.catalyst_date)::text                                   ||
      ',"logged_at":'             || to_json(NEW.logged_at)::text                                       ||
      ',"confidence_score":'      || COALESCE(to_json(NEW.confidence_score)::text, 'null')              ||
      ',"entry_pop_bp":'          || COALESCE(to_json(NEW.entry_pop_bp)::text, 'null')                  ||
      '}';
  ELSE
    -- v1: identical to the pre-2026-05-07 trigger so historical
    -- signals continue to verify against their stored hash.
    payload :=
      '{"ticker":'                || to_json(NEW.ticker)::text                                          ||
      ',"direction":'             || to_json(NEW.direction)::text                                       ||
      ',"thesis":'                || to_json(NEW.thesis)::text                                          ||
      ',"catalyst_date":'         || to_json(NEW.catalyst_date)::text                                   ||
      ',"logged_at":'             || to_json(NEW.logged_at)::text                                       ||
      ',"confidence_score":'      || COALESCE(to_json(NEW.confidence_score)::text, 'null')              ||
      '}';
  END IF;
  NEW.signal_hash := encode(extensions.digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

-- ─── Immutability: lock hash_version + entry_pop_bp ─────────────

CREATE OR REPLACE FUNCTION public.enforce_signal_immutability_fn()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thesis IS DISTINCT FROM OLD.thesis
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.catalyst_date IS DISTINCT FROM OLD.catalyst_date
     OR NEW.logged_at IS DISTINCT FROM OLD.logged_at
     OR NEW.signal_hash IS DISTINCT FROM OLD.signal_hash
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.entry_pop_bp IS DISTINCT FROM OLD.entry_pop_bp
     OR NEW.hash_version IS DISTINCT FROM OLD.hash_version THEN
    RAISE EXCEPTION 'Core signal fields are immutable after logging';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── Public record exposure ───────────────────────────────────────

DROP VIEW IF EXISTS public.public_record;
CREATE VIEW public.public_record
WITH (security_invoker = true) AS
SELECT
  s.id,
  p.display_name,
  p.public_slug,
  s.ticker,
  s.company_name,
  s.drug_name,
  s.indication,
  s.catalyst_type,
  s.catalyst_date,
  s.direction,
  s.confidence_score,
  s.edge_score,
  s.logged_at,
  s.trade_type,
  s.signal_hash,
  s.hash_version,
  s.entry_pop_bp,
  s.github_commit_sha,
  o.catalyst_result,
  o.thesis_correct,
  o.pnl_percent,
  o.exit_reason,
  o.rules_followed,
  o.recorded_at AS outcome_date
FROM public.signals s
JOIN public.profiles p ON s.user_id = p.id
LEFT JOIN public.outcomes o ON o.signal_id = s.id
WHERE p.is_public = true
  AND s.status <> 'dismissed';

GRANT SELECT ON public.public_record TO anon, authenticated;

-- Column-level GRANTs for anon on the base table so direct PostgREST
-- access also exposes the new columns. Re-grant the existing list +
-- the two new columns; this is a full re-grant, not a delta, because
-- GRANT SELECT (col) doesn't have ADD/REMOVE semantics.
REVOKE SELECT ON public.signals FROM anon;
GRANT SELECT (
  id, user_id, ticker, company_name, drug_name, indication,
  catalyst_type, catalyst_date, direction, confidence_score, edge_score,
  logged_at, trade_type, signal_hash, hash_version, entry_pop_bp,
  github_commit_sha, status
) ON public.signals TO anon;
