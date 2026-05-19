-- wheel_scan_cron — schedule scan-wheel-cycles via pg_cron.
--
-- Mirrors the scan-universe-plays-rth job exactly: net.http_post to
-- the edge function with the shared cron_scan_auth_token vault secret
-- as the bearer (the function validates it via the existing
-- get_cron_scan_auth_token SECURITY DEFINER RPC). No new secret, no
-- new RPC.
--
-- Cadence: twice per RTH day (14:00 & 19:00 UTC ≈ 10:00 & 15:00 ET),
-- Mon–Fri. The wheel sells monthly-ish puts — it is not latency
-- sensitive like the 30-min spread scanner, so a midday and a
-- pre-close read is enough and keeps load trivial (the scanner makes
-- no Claude calls; compute-gex is already 5-min cached for these
-- tickers by the gex snapshot cron).

-- Idempotent: drop any prior copy of the job before (re)creating it.
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'scan-wheel-cycles-rth';

SELECT cron.schedule(
  'scan-wheel-cycles-rth',
  '0 14,19 * * 1-5',
  $$
    SELECT net.http_post(
      url := 'https://rghoynbaykeyjbhqmaff.supabase.co/functions/v1/scan-wheel-cycles',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_scan_auth_token' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := '{"scan_kind":"rth"}'::jsonb,
      timeout_milliseconds := 90000
    );
  $$
);
