-- Wheel Strategy Module — First Slice (build prompt §5, §14).
--
-- `wheel_setups` is the per-user record of a systematic short-strangle /
-- wheel setup computed off the live GEX matrix. Phase 1's 4:15pm-ET cron
-- writes one row per watchlist ticker per cycle (service role); the
-- First Slice only computes + returns the decision, so for now the
-- table exists with no client write path.
--
-- RLS mirrors the per-user pattern used elsewhere: users SELECT only
-- their own rows via the cached `(select auth.uid())` form required by
-- the Supabase auth_rls_initplan lint. Writes are service-role only
-- (the cron), so no INSERT/UPDATE/DELETE grant to authenticated.

CREATE TABLE IF NOT EXISTS public.wheel_setups (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  ticker                text NOT NULL,
  expiration_date       date,
  spot_price            numeric,
  net_gex               numeric,
  pin_probability       numeric,
  call_wall_strike      numeric,
  call_wall_oi          numeric,
  put_wall_strike       numeric,
  put_wall_oi           numeric,
  suggested_call_strike numeric,
  suggested_put_strike  numeric,
  suggested_contracts   integer,
  call_premium          numeric,
  put_premium           numeric,
  combined_yield_pct    numeric,
  iv_rank               numeric,
  catalyst_in_window    text[]      NOT NULL DEFAULT '{}',
  regime                text        NOT NULL CHECK (regime IN ('A', 'B')),
  disqualify_reasons    text[]      NOT NULL DEFAULT '{}',
  generated_at          timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,
  status                text        NOT NULL DEFAULT 'suggested'
                          CHECK (status IN ('suggested', 'placed', 'expired', 'skipped'))
);

CREATE INDEX IF NOT EXISTS wheel_setups_user_status_idx
  ON public.wheel_setups (user_id, status, generated_at DESC);

CREATE INDEX IF NOT EXISTS wheel_setups_ticker_idx
  ON public.wheel_setups (ticker, generated_at DESC);

ALTER TABLE public.wheel_setups ENABLE ROW LEVEL SECURITY;

CREATE POLICY wheel_setups_select_own ON public.wheel_setups
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

REVOKE ALL ON public.wheel_setups FROM anon, authenticated;
GRANT SELECT ON public.wheel_setups TO authenticated;
