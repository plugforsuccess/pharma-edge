-- Pharma Edge — security + performance hardening pass on the Week 1 schema.
--
-- Addresses Supabase advisor findings on the initial schema:
--   * security_definer_view (ERROR) on public_record
--   * function_search_path_mutable (WARN) on 4 trigger/helper functions
--   * anon/authenticated_security_definer_function_executable (WARN) on
--     handle_new_user (auth trigger; should not be callable from REST)
--   * auth_rls_initplan (WARN) on 14 policies (auth.uid() per row)
--   * unindexed_foreign_keys (INFO) on alerts.signal_id

-- ---------------------------------------------------------------------------
-- Lock search_path on all custom functions to prevent search_path injection.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION compute_signal_hash()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  NEW.signal_hash := encode(
    digest(
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

CREATE OR REPLACE FUNCTION enforce_signal_immutability_fn()
RETURNS TRIGGER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thesis IS DISTINCT FROM OLD.thesis
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.catalyst_date IS DISTINCT FROM OLD.catalyst_date
     OR NEW.logged_at IS DISTINCT FROM OLD.logged_at
     OR NEW.signal_hash IS DISTINCT FROM OLD.signal_hash
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Core signal fields are immutable after logging';
  END IF;
  RETURN NEW;
END;
$$;

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
        'pnl_percent', NEW.pnl_percent,
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

-- ---------------------------------------------------------------------------
-- handle_new_user is wired to auth.users INSERT only; nobody should be able
-- to call it via PostgREST.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Missing FK index.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS alerts_signal_idx ON alerts (signal_id);

-- ---------------------------------------------------------------------------
-- Rebuild public_record as a SECURITY INVOKER view backed by explicit anon
-- RLS policies + column-level GRANTs. Avoids the security_definer_view lint
-- and gives a single, auditable surface for what anon can read.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public_record;
CREATE VIEW public_record
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
  s.github_commit_sha,
  o.catalyst_result,
  o.thesis_correct,
  o.pnl_percent,
  o.exit_reason,
  o.rules_followed,
  o.recorded_at AS outcome_date
FROM signals s
JOIN profiles p ON s.user_id = p.id
LEFT JOIN outcomes o ON o.signal_id = s.id
WHERE p.is_public = true
  AND s.status <> 'dismissed';

GRANT SELECT ON public_record TO anon, authenticated;

-- Anon read policies: only rows belonging to public profiles are visible.
CREATE POLICY profiles_select_public ON profiles
  FOR SELECT TO anon USING (is_public = true);

CREATE POLICY signals_select_public ON signals
  FOR SELECT TO anon USING (
    status <> 'dismissed'
    AND user_id IN (SELECT id FROM profiles WHERE is_public = true)
  );

CREATE POLICY outcomes_select_public ON outcomes
  FOR SELECT TO anon USING (
    user_id IN (SELECT id FROM profiles WHERE is_public = true)
  );

-- Column-level grants restrict anon to public-safe columns even if they
-- hit the base tables directly via PostgREST.
REVOKE SELECT ON profiles FROM anon;
GRANT SELECT (id, display_name, public_slug, is_public) ON profiles TO anon;

REVOKE SELECT ON signals FROM anon;
GRANT SELECT (
  id, user_id, ticker, company_name, drug_name, indication,
  catalyst_type, catalyst_date, direction, confidence_score, edge_score,
  logged_at, trade_type, signal_hash, github_commit_sha, status
) ON signals TO anon;

REVOKE SELECT ON outcomes FROM anon;
GRANT SELECT (
  id, signal_id, user_id, catalyst_result, thesis_correct,
  pnl_percent, exit_reason, rules_followed, recorded_at
) ON outcomes TO anon;

-- ---------------------------------------------------------------------------
-- Replace authenticated RLS policies with cached auth.uid() form so the
-- function is evaluated once per query, not once per row.
-- ---------------------------------------------------------------------------
DROP POLICY profiles_select_own ON profiles;
DROP POLICY profiles_update_own ON profiles;
CREATE POLICY profiles_select_own ON profiles
  FOR SELECT TO authenticated USING ((select auth.uid()) = id);
CREATE POLICY profiles_update_own ON profiles
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

DROP POLICY watchlist_select_own ON watchlist;
DROP POLICY watchlist_insert_own ON watchlist;
DROP POLICY watchlist_update_own ON watchlist;
DROP POLICY watchlist_delete_own ON watchlist;
CREATE POLICY watchlist_select_own ON watchlist
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY watchlist_insert_own ON watchlist
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY watchlist_update_own ON watchlist
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY watchlist_delete_own ON watchlist
  FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);

DROP POLICY signals_select_own ON signals;
DROP POLICY signals_insert_own ON signals;
DROP POLICY signals_update_own ON signals;
CREATE POLICY signals_select_own ON signals
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY signals_insert_own ON signals
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY signals_update_own ON signals
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY outcomes_select_own ON outcomes;
DROP POLICY outcomes_insert_own ON outcomes;
CREATE POLICY outcomes_select_own ON outcomes
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY outcomes_insert_own ON outcomes
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY alerts_select_own ON alerts;
DROP POLICY alerts_insert_own ON alerts;
DROP POLICY alerts_update_own ON alerts;
DROP POLICY alerts_delete_own ON alerts;
CREATE POLICY alerts_select_own ON alerts
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY alerts_insert_own ON alerts
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY alerts_update_own ON alerts
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY alerts_delete_own ON alerts
  FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);
