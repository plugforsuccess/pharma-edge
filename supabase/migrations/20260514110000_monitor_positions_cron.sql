-- monitor-positions cron — fires the edge function every 5 min,
-- 13:00-20:55 UTC, Mon-Fri. Same coverage as the prior GitHub Actions
-- cron (.github/workflows/monitor-positions.yml) but in-database, so
-- ticks don't slip the way hosted-runner cron does under load.
--
-- The edge function (verify_jwt=true, service-role-only) is idempotent
-- on triggers_fired, so a duplicate tick during the GH Actions cutover
-- is harmless.
--
-- PREREQUISITES — already enabled in this project for the
-- scan-universe-plays-rth job; nothing extra needed:
--   1. pg_cron
--   2. pg_net
--   3. vault secret `cron_scan_auth_token` containing the service-role
--      JWT (reused from scan-universe-plays-rth — same authn
--      contract).
--
-- Extension-guarded: if pg_cron isn't installed the DO block no-ops
-- with a notice so applying the migration history against a fresh
-- project doesn't fail.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled — skipping monitor-positions-rth schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_net not enabled — skipping monitor-positions-rth schedule.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'monitor-positions-rth') THEN
    PERFORM cron.unschedule('monitor-positions-rth');
  END IF;

  PERFORM cron.schedule(
    'monitor-positions-rth',
    '*/5 13-20 * * 1-5',
    $cron$
      SELECT net.http_post(
        url := 'https://rghoynbaykeyjbhqmaff.supabase.co/functions/v1/monitor-positions',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_scan_auth_token' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $cron$
  );
  RAISE NOTICE 'monitor-positions-rth scheduled: */5 13-20 * * 1-5 UTC';
END
$$;
