-- Audit trail for the worker-health edge function. Every cron tick
-- that finds a stale worker writes a row here. The function reads
-- this table for cooldown (no more than 1 alert email per 60 min),
-- and the /admin page can read it to show a worker-health timeline.

CREATE TABLE IF NOT EXISTS public.health_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS health_alerts_sent_at_idx
  ON public.health_alerts (sent_at DESC);

ALTER TABLE public.health_alerts ENABLE ROW LEVEL SECURITY;

-- Admin-only SELECT — same is_admin gate the cost views use.
CREATE POLICY health_alerts_select_admin ON public.health_alerts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p2
      WHERE p2.id = (SELECT auth.uid()) AND p2.is_admin = true
    )
  );

-- No INSERT/UPDATE policies → writes are service-role-only (which
-- bypasses RLS). Explicit grants below remove the implicit blanket
-- and add back the SELECT path through the admin policy above.
REVOKE ALL ON public.health_alerts FROM anon, authenticated;
GRANT SELECT ON public.health_alerts TO authenticated;
