-- Pharma Edge — make hash triggers byte-compatible with JS JSON.stringify.
--
-- Background: `json_build_object(...)::text` outputs JSON with whitespace
-- around colons (Postgres legacy json type), and `jsonb_build_object` both
-- adds whitespace AND reorders keys. Neither matches JS JSON.stringify
-- output, so the canonical-hash story (compute on server, verify in
-- browser) was broken from day one. Smoke testing surfaced this.
--
-- Fix: build the canonical payload manually using `to_json` on each value
-- and concatenating without whitespace. `to_json` of individual values
-- matches `JSON.stringify` of the equivalent JS value byte-for-byte, with
-- one exception: SQL NULL stays NULL instead of becoming the JSON literal
-- 'null', so we COALESCE nullable columns explicitly.

CREATE OR REPLACE FUNCTION compute_signal_hash()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  payload TEXT;
BEGIN
  payload :=
    '{"ticker":'           || to_json(NEW.ticker)::text                                          ||
    ',"direction":'        || to_json(NEW.direction)::text                                       ||
    ',"thesis":'           || to_json(NEW.thesis)::text                                          ||
    ',"catalyst_date":'    || to_json(NEW.catalyst_date)::text                                   ||
    ',"logged_at":'        || to_json(NEW.logged_at)::text                                       ||
    ',"confidence_score":' || COALESCE(to_json(NEW.confidence_score)::text, 'null')              ||
    '}';
  NEW.signal_hash := encode(extensions.digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION compute_outcome_hash()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  payload TEXT;
BEGIN
  payload :=
    '{"signal_id":'      || to_json(NEW.signal_id)::text                                  ||
    ',"catalyst_result":' || to_json(NEW.catalyst_result)::text                            ||
    ',"thesis_correct":' || to_json(NEW.thesis_correct)::text                              ||
    ',"exit_reason":'    || COALESCE(to_json(NEW.exit_reason)::text, 'null')               ||
    ',"recorded_at":'    || to_json(NEW.recorded_at)::text                                 ||
    '}';
  NEW.outcome_hash := encode(extensions.digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;
