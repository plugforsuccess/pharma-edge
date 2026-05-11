-- Break the RLS recursion on `profiles_select_admin`. That policy
-- (and every `*_select_admin` policy mirroring it) did
-- `EXISTS (SELECT 1 FROM profiles WHERE is_admin AND id = auth.uid())`.
-- On `profiles` itself, that subquery re-entered RLS → re-evaluated
-- `profiles_select_admin` → recursed → Postgres bailed with
-- "infinite recursion detected in policy for relation 'profiles'".
--
-- Fix: route the admin check through a SECURITY DEFINER function so
-- the inner SELECT runs as the function owner (bypassing RLS), and
-- the policy itself contains no FROM-clause against `profiles`.
--
-- The *_select_public policies on signals/outcomes still subquery
-- profiles, but their inner SELECT now resolves via the other
-- (non-recursive) profile policies — no rewrite needed.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid()) AND is_admin = true
  )
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, anon;

DROP POLICY IF EXISTS profiles_select_admin ON public.profiles;
CREATE POLICY profiles_select_admin ON public.profiles
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS health_alerts_select_admin ON public.health_alerts;
CREATE POLICY health_alerts_select_admin ON public.health_alerts
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS claude_calls_select_admin ON public.claude_calls;
CREATE POLICY claude_calls_select_admin ON public.claude_calls
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS signals_select_admin ON public.signals;
CREATE POLICY signals_select_admin ON public.signals
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS outcomes_select_admin ON public.outcomes;
CREATE POLICY outcomes_select_admin ON public.outcomes
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS scanner_runs_select_admin ON public.scanner_runs;
CREATE POLICY scanner_runs_select_admin ON public.scanner_runs
  FOR SELECT TO authenticated USING (public.is_admin());
