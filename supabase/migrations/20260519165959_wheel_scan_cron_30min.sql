-- Tighten wheel scan cadence: twice/day → every 30 min during RTH
-- (matches the scan_cron_30min precedent). The function's own
-- isWithinRth guard is defense-in-depth against off-hours fires.
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'scan-wheel-cycles-rth';

SELECT cron.schedule(
  'scan-wheel-cycles-rth',
  '*/30 14-20 * * 1-5',
  $$
    SELECT net.http_post(
      url := 'https://rghoynbaykeyjbhqmaff.supabase.co/functions/v1/scan-wheel-cycles',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_scan_auth_token' LIMIT 1),
        'Content-Type', 'application/json'
      ),
      body := '{"scan_kind":"rth"}'::jsonb,
      timeout_milliseconds := 150000
    );
  $$
);
