-- Phase 1 of automated trade management. Semi-auto: the trigger-eval
-- cron writes proposed actions here when a position trips a rule
-- (stop loss / profit take ladder); the user approves with a one-tap
-- close on the PositionDetail page. No autonomous execution yet —
-- that's Phase 2 after a calibration window.

CREATE TABLE IF NOT EXISTS public.auto_triggers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position_id     uuid NOT NULL REFERENCES public.open_positions(id) ON DELETE CASCADE,
  signal_id       uuid REFERENCES public.signals(id),
  -- Categorical trigger reason. Each kind has its own action template.
  -- 'stop_loss_50'      → close full position (P&L ≤ -50%)
  -- 'profit_take_100'   → close 50% of contracts (P&L ≥ +100%)
  -- 'profit_take_200'   → close 75% of remaining contracts (P&L ≥ +200%)
  -- 'thesis_invalidated'→ (Phase 1.5) close full position when verdict flips
  kind            text NOT NULL CHECK (kind IN (
    'stop_loss_50','profit_take_100','profit_take_200','thesis_invalidated'
  )),
  reason          text NOT NULL,
  -- Pre-built body for close-order so the user's tap is literally
  -- "POST close-order with this JSON" — no recomputation needed.
  proposed_action jsonb NOT NULL,
  observed        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','approved','executed','failed','dismissed','expired'
  )),
  execution_result jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  executed_at     timestamptz,
  resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS auto_triggers_user_status_idx
  ON public.auto_triggers (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS auto_triggers_position_idx
  ON public.auto_triggers (position_id, status);

-- Idempotency: at most one PENDING trigger per (position, kind).
CREATE UNIQUE INDEX IF NOT EXISTS auto_triggers_unique_pending
  ON public.auto_triggers (position_id, kind)
  WHERE status = 'pending';

ALTER TABLE public.auto_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY auto_triggers_select_own ON public.auto_triggers
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY auto_triggers_select_admin ON public.auto_triggers
  FOR SELECT TO authenticated USING (public.is_admin());

-- Users can mark their own pending triggers as dismissed. They cannot
-- flip status to approved/executed from the client — that transition
-- is owned by close-order using service-role.
CREATE POLICY auto_triggers_update_dismiss ON public.auto_triggers
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id AND status = 'pending')
  WITH CHECK (status = 'dismissed');

REVOKE ALL ON public.auto_triggers FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.auto_triggers TO authenticated;
