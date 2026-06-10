-- Daily king-node digest push notification.
--
-- Calls the digest-king-nodes edge function at 13:00 UTC Mon-Fri
-- (= 9am ET EDT, 8am ET EST). The function reads
-- public.current_king_nodes, picks the top 10 by |GEX|, and fans out
-- a single web-push to every row in push_subscriptions.
--
-- Same fanout pattern as snapshot-gex-rth: net.http_post is async, so
-- the cron returns immediately. The function logs sent/pruned/errors
-- counts to its response (visible in supabase function logs).
--
-- PREREQUISITES (already in place from prior cron migrations):
--   * pg_cron + pg_net enabled
--   * vault.decrypted_secrets contains cron_service_role_jwt
--   * digest-king-nodes edge function deployed
--   * VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT secrets set

CREATE OR REPLACE FUNCTION public.fire_king_node_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jwt text;
BEGIN
  SELECT decrypted_secret INTO jwt
    FROM vault.decrypted_secrets
    WHERE name = 'cron_service_role_jwt'
    LIMIT 1;
  IF jwt IS NULL THEN
    RAISE EXCEPTION 'cron_service_role_jwt not in vault';
  END IF;
  PERFORM net.http_post(
    url := 'https://rghoynbaykeyjbhqmaff.supabase.co/functions/v1/digest-king-nodes',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || jwt,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled — skipping king-node-digest schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_net not enabled — skipping king-node-digest schedule.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'king-node-digest') THEN
    PERFORM cron.unschedule('king-node-digest');
  END IF;

  -- 13:00 UTC Mon-Fri = 9am ET EDT, 8am ET EST. Pre-market open at
  -- 9:30am ET EDT is the right moment to land in the user's inbox so
  -- the digest informs the cash-open positioning read.
  PERFORM cron.schedule(
    'king-node-digest',
    '0 13 * * 1-5',
    $cron$ SELECT public.fire_king_node_digest(); $cron$
  );

  RAISE NOTICE 'king-node-digest pg_cron job scheduled';
END
$$;
