-- Retention crons for the three remaining bloat tables.
--
-- Sized so that the project stays well under the 500 MB free-tier
-- cap with comfortable headroom (target: ~150 MB steady state for
-- these three combined):
--
--   gex_history       (~10.6 MB/day) → 7-day retention  → ~75 MB
--   option_flow_daily (~1.2 MB/day)  → 30-day retention → ~36 MB
--   dxlink_quotes     (per-symbol)   → 24h staleness    → ~10 MB
--
-- All three primary keys are upsert-friendly (verified 2026-06-04):
--   gex_history       PRIMARY KEY (ticker, snapshot_at)
--   option_flow_daily PRIMARY KEY (ticker, strike, expiration_date, option_type, trade_date)
--   dxlink_quotes     PRIMARY KEY (symbol)
-- so the workers' UPSERTs don't accumulate dupes — old rows just
-- linger after they leave the active window. These crons reap them.
--
-- After this migration is applied, run ONE TIME in the SQL editor to
-- reclaim the disk space the DELETE alone won't release (VACUUM FULL
-- can't run inside a migration transaction):
--
--   VACUUM (FULL, VERBOSE) public.gex_history;
--   VACUUM (FULL, VERBOSE) public.option_flow_daily;
--   VACUUM (FULL, VERBOSE) public.dxlink_quotes;
--
-- Each holds an ACCESS EXCLUSIVE lock for ~30-60s on that table.
-- Run outside RTH to avoid blocking compute-gex / the dxlink-worker.

CREATE OR REPLACE FUNCTION public.prune_gex_history()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.gex_history
  WHERE snapshot_at < now() - interval '7 days';
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_option_flow_daily()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.option_flow_daily
  WHERE trade_date < (current_date - interval '30 days');
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_dxlink_quotes()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 24h staleness: anything the dxlink-worker hasn't refreshed in
  -- a day is either an expired option, a rolled-out strike, or a
  -- ticker no longer in the subscription plan. Safe to drop — the
  -- worker re-upserts active symbols every ~750ms during RTH.
  DELETE FROM public.dxlink_quotes
  WHERE updated_at < now() - interval '24 hours';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled — skipping retention schedules.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-gex-history') THEN
    PERFORM cron.unschedule('prune-gex-history');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-option-flow-daily') THEN
    PERFORM cron.unschedule('prune-option-flow-daily');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-dxlink-quotes') THEN
    PERFORM cron.unschedule('prune-dxlink-quotes');
  END IF;

  -- Staggered, all in the 05:00 UTC dead-zone (00:00-01:30 ET, well
  -- before any market-data cron starts at 13:00 UTC).
  PERFORM cron.schedule(
    'prune-gex-history',
    '5 5 * * *',
    $cron$ SELECT public.prune_gex_history(); $cron$
  );
  PERFORM cron.schedule(
    'prune-option-flow-daily',
    '15 5 * * *',
    $cron$ SELECT public.prune_option_flow_daily(); $cron$
  );
  PERFORM cron.schedule(
    'prune-dxlink-quotes',
    '25 5 * * *',
    $cron$ SELECT public.prune_dxlink_quotes(); $cron$
  );

  RAISE NOTICE 'retention pg_cron jobs scheduled';
END
$$;
