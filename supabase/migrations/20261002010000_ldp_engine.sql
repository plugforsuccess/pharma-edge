-- LDP (LEAPS Diversified Portfolio) engine: risk profiles + audit log.
--
--   * ldp_risk_profiles — one row per user: onboarding answers, the
--     computed risk tier, which rule capped it, every rule's result,
--     and the account tier (managed vs self-directed). Written ONLY by
--     the engine (service role) so a user can't promote themselves to
--     "aggressive" or "managed" from the client — the tier gates what
--     the bot buys and whether it auto-trades. Users read their own row
--     (suitability record + the UI label).
--   * ldp_audit_log — append-only record of every trade, suggestion,
--     skip and hold-for-long-term: risk tier + capping rule, account
--     tier, contract + all filter values, score, thesis, tax rates,
--     exit ladder, sell rule. Write-once via service role (no UPDATE /
--     DELETE policies), same posture as claude_calls.

CREATE TABLE IF NOT EXISTS public.ldp_risk_profiles (
  user_id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stated_tolerance      text    NOT NULL CHECK (stated_tolerance IN ('conservative', 'moderate', 'aggressive')),
  account_size          numeric NOT NULL CHECK (account_size >= 0),
  options_experience    text    NOT NULL CHECK (options_experience IN ('none', 'some', 'experienced')),
  horizon_years         numeric NOT NULL CHECK (horizon_years >= 0),
  tier                  text    NOT NULL CHECK (tier IN ('conservative', 'moderate', 'aggressive')),
  capped_by             text    CHECK (capped_by IS NULL OR capped_by IN ('account_size', 'options_experience', 'time_horizon')),
  rule_results          jsonb   NOT NULL,
  -- Engine-rendered UI copy (ldp.risk.describe): label, capped_by_text,
  -- allows. Rendered server-side so thresholds stay in engine config.
  display               jsonb   NOT NULL DEFAULT '{}',
  account_tier          text    NOT NULL DEFAULT 'self_directed' CHECK (account_tier IN ('managed', 'self_directed')),
  allow_catalyst_plays  boolean NOT NULL DEFAULT false,
  buy_window_start      text    CHECK (buy_window_start IS NULL OR buy_window_start ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  exit_ladder           numeric[] NOT NULL DEFAULT '{1.0,2.0,3.0}',
  rung_fractions        numeric[],
  last_annual_buy       date,
  computed_at           timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ldp_risk_profiles_ladder_chk CHECK (
    rung_fractions IS NULL OR cardinality(rung_fractions) = cardinality(exit_ladder)
  )
);

DROP TRIGGER IF EXISTS ldp_risk_profiles_set_updated_at ON public.ldp_risk_profiles;
CREATE TRIGGER ldp_risk_profiles_set_updated_at
  BEFORE UPDATE ON public.ldp_risk_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.ldp_risk_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ldp_risk_profiles_select_own ON public.ldp_risk_profiles;
CREATE POLICY ldp_risk_profiles_select_own ON public.ldp_risk_profiles
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS ldp_risk_profiles_service_writes ON public.ldp_risk_profiles;
CREATE POLICY ldp_risk_profiles_service_writes ON public.ldp_risk_profiles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ldp_risk_profiles IS
  'LDP engine risk tier per user (suitability record). Service-role writes only: the tier and account_tier gate auto-trading.';

CREATE TABLE IF NOT EXISTS public.ldp_audit_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  kind             text NOT NULL CHECK (kind IN ('trade', 'suggestion', 'skip', 'hold')),
  action           text NOT NULL,
  ticker           text NOT NULL,
  sleeve           text CHECK (sleeve IS NULL OR sleeve IN ('core', 'satellite')),
  risk_tier        text NOT NULL CHECK (risk_tier IN ('conservative', 'moderate', 'aggressive')),
  account_tier     text NOT NULL CHECK (account_tier IN ('managed', 'self_directed')),
  permission_mode  text NOT NULL CHECK (permission_mode IN ('auto', 'suggest', 'blocked')),
  sell_rule        text,
  payload          jsonb NOT NULL,
  -- Auto-trades are only legal on managed accounts; enforce it here too.
  CONSTRAINT ldp_audit_log_auto_requires_managed CHECK (
    kind <> 'trade' OR (permission_mode = 'auto' AND account_tier = 'managed')
  )
);

CREATE INDEX IF NOT EXISTS ldp_audit_log_user_time_idx ON public.ldp_audit_log (user_id, recorded_at DESC);

ALTER TABLE public.ldp_audit_log ENABLE ROW LEVEL SECURITY;

-- One SELECT policy (own rows OR admin) rather than two permissive
-- policies, per the multiple_permissive_policies advisor.
DROP POLICY IF EXISTS ldp_audit_log_select_own ON public.ldp_audit_log;
CREATE POLICY ldp_audit_log_select_own ON public.ldp_audit_log
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id OR public.is_admin());

DROP POLICY IF EXISTS ldp_audit_log_service_insert ON public.ldp_audit_log;
CREATE POLICY ldp_audit_log_service_insert ON public.ldp_audit_log
  FOR INSERT TO service_role WITH CHECK (true);

COMMENT ON TABLE public.ldp_audit_log IS
  'Append-only LDP engine audit: every trade, suggestion, skip and hold-for-long-term with risk tier, filters, thesis, tax rates, exit ladder and sell rule.';
