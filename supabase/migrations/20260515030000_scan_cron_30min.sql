-- Halve scan-universe-plays cadence: every 15 min → every 30 min.
--
-- Part of the scanner right-sizing. The volume blowout (Anthropic
-- 30K-tokens/min org cap → 429s → drained credit balance) came from
-- universe size × cadence × prompt size. The function change moves
-- the universe to the user's watchlist ∪ open positions (was a
-- hardcoded 19) and drops CONCURRENCY 8→2; this halves the firing
-- frequency on top. 30 min is still frequent enough to catch a GEX
-- setup mid-formation on the handful of names actually tracked,
-- while cutting daily call volume in half again.
--
-- Model stays Sonnet (the scanner picks which real-money trades
-- surface — not a place to downgrade reasoning; the volume cut, not
-- a cheaper model, is what makes it fit).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled — skipping scan cadence change.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scan-universe-plays-rth') THEN
    PERFORM cron.unschedule('scan-universe-plays-rth');
  END IF;
  PERFORM cron.schedule(
    'scan-universe-plays-rth',
    '*/30 13-21 * * 1-5',
    $cron$
      SELECT net.http_post(
        url := 'https://rghoynbaykeyjbhqmaff.supabase.co/functions/v1/scan-universe-plays',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_scan_auth_token' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := '{"scan_kind":"rth_15min"}'::jsonb,
        timeout_milliseconds := 90000
      );
    $cron$
  );
  RAISE NOTICE 'scan-universe-plays-rth rescheduled: */30 13-21 * * 1-5 UTC';
END
$$;
