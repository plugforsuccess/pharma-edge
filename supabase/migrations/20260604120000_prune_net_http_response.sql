-- Prune pg_net response history.
--
-- net._http_response is written to on every net.http_post / net.http_get
-- call (every cron tick, every fanout). pg_net never auto-prunes it.
-- On 2026-06-04 the table was 360 MB with n_live_tup = 0 — pure dead
-- weight — which had pushed the project over the free-plan 500 MB cap
-- and flipped the DB into read-only mode, breaking login.
--
-- After this migration is applied (which requires the DB to be writable
-- again — i.e. cap raised or plan upgraded), ALSO run the following
-- ONE-SHOT in the SQL editor to reclaim the 360 MB already on disk.
-- VACUUM FULL cannot run inside a migration transaction:
--
--   VACUUM (FULL, VERBOSE) net._http_response;
--
-- After that, the daily cron below keeps the table bounded.

CREATE OR REPLACE FUNCTION public.prune_net_http_response()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
BEGIN
  DELETE FROM net._http_response
  WHERE created < now() - interval '1 hour';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled — skipping prune-net-http-response schedule.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-net-http-response') THEN
    PERFORM cron.unschedule('prune-net-http-response');
  END IF;

  -- Hourly. The retention window is 1 hour, so daily would let the
  -- table grow to ~24x steady state before each sweep. Hourly keeps it
  -- pinned near zero with negligible overhead (one DELETE on a small
  -- result set).
  PERFORM cron.schedule(
    'prune-net-http-response',
    '0 * * * *',
    $cron$ SELECT public.prune_net_http_response(); $cron$
  );

  RAISE NOTICE 'prune-net-http-response pg_cron job scheduled';
END
$$;
