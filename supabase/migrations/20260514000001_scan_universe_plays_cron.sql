-- scan-universe-plays cron — fires the edge function every 15 min,
-- 13:00-21:00 UTC, Mon-Fri. That window covers US RTH under both DST
-- and EST with margin; the function's own isWithinRth() check
-- enforces the exact ET window and short-circuits early outside it.
-- Holidays are not excluded at the cron level — a holiday run is
-- harmless (function returns early with skipped:true).
--
-- PREREQUISITES — enable in the Supabase dashboard under
-- Database → Extensions BEFORE this migration produces a useful run:
--   1. pg_cron
--   2. pg_net
--
-- Then set the two database settings (dashboard SQL editor, as
-- superuser) so the cron's net.http_post can reach the edge function:
--
--   ALTER DATABASE postgres SET "app.settings.supabase_url"
--     TO 'https://rghoynbaykeyjbhqmaff.supabase.co';
--   ALTER DATABASE postgres SET "app.settings.scan_auth_token"
--     TO '<generate a random 32-byte hex>';
--
-- And set the matching edge-function secret:
--   supabase secrets set SCAN_AUTH_TOKEN=<same value>
--
-- This migration is extension-guarded: if pg_cron isn't installed
-- it no-ops with a notice, so applying the repo's migration history
-- against a fresh project doesn't fail. Re-apply (or just rerun the
-- DO block via dashboard) after enabling the extensions.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled — skipping scan-universe-plays-rth schedule. Enable pg_cron in the dashboard and rerun.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_net not enabled — skipping scan-universe-plays-rth schedule. Enable pg_net in the dashboard and rerun.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scan-universe-plays-rth') THEN
    PERFORM cron.unschedule('scan-universe-plays-rth');
  END IF;

  PERFORM cron.schedule(
    'scan-universe-plays-rth',
    '*/15 13-21 * * 1-5',
    $cron$
      SELECT net.http_post(
        url := concat(
          current_setting('app.settings.supabase_url', true),
          '/functions/v1/scan-universe-plays'
        ),
        headers := jsonb_build_object(
          'Authorization', concat('Bearer ', current_setting('app.settings.scan_auth_token', true)),
          'Content-Type', 'application/json'
        ),
        body := '{"scan_kind":"rth_15min"}'::jsonb,
        timeout_milliseconds := 90000
      );
    $cron$
  );
  RAISE NOTICE 'scan-universe-plays-rth scheduled: */15 13-21 * * 1-5 UTC';
END
$$;
