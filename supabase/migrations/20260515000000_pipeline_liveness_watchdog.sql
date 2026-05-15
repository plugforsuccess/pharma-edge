-- Pipeline liveness watchdog (hardening PR 3 of 3).
--
-- The AMD failure had a silent component: the snapshot-gex and
-- monitor-positions crons died quietly and the only reason anyone
-- noticed was the user happening to look. worker-health exists but
-- didn't catch it. This is the dead-man switch: every 15 min during
-- RTH, check that the pipelines feeding live positions are actually
-- writing, and push an in-app alert (NotificationCenter realtime
-- picks up alerts rows immediately) when one goes stale.
--
-- Audience: users with an open position. They're the ones exposed
-- if verdict / P&L / snapshot data freezes under them. (No is_admin
-- users configured; the active trader IS the person who needs this.)
--
-- Idempotency: re-alerts once per cron tick while an outage persists
-- (guard = no same-type alert for that user in the last 14 min,
-- slightly under the 15-min interval). A multi-tick outage produces
-- one reminder per tick — persistent, not spammy. Silence is never
-- treated as health.

CREATE OR REPLACE FUNCTION public.pipeline_liveness_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  snapshot_age interval;
  snapshot_stale boolean;
  pos record;
  recent_dupe boolean;
BEGIN
  -- ── Check 1: snapshot-gex pipeline ───────────────────────────
  SELECT now() - max(snapshot_at) INTO snapshot_age FROM gex_history;
  snapshot_stale := snapshot_age IS NULL OR snapshot_age > interval '15 minutes';

  IF snapshot_stale THEN
    FOR pos IN
      SELECT DISTINCT user_id FROM open_positions WHERE status = 'open'
    LOOP
      SELECT EXISTS (
        SELECT 1 FROM alerts
        WHERE user_id = pos.user_id
          AND alert_type = 'pipeline_stale_snapshot'
          AND sent_at > now() - interval '14 minutes'
      ) INTO recent_dupe;
      IF NOT recent_dupe THEN
        INSERT INTO alerts (user_id, alert_type, message, sent_via, sent_at)
        VALUES (
          pos.user_id,
          'pipeline_stale_snapshot',
          format(
            'HeatPulse data is stale (%s old). The GEX snapshot pipeline has stopped writing — matrix, verdicts and replay are frozen. Treat any "intact" verdict with suspicion until this clears.',
            COALESCE(snapshot_age::text, 'unknown age')
          ),
          'in_app',
          now()
        );
      END IF;
    END LOOP;
  END IF;

  -- ── Check 2: per-position verdict / poll freshness ───────────
  -- A live position whose verdict hasn't been recomputed in 20 min
  -- during RTH means monitor-positions isn't running — the exact
  -- silent failure that let AMD read "intact" into the ground.
  FOR pos IN
    SELECT id, user_id, ticker, last_verdict_at, last_polled_at
    FROM open_positions
    WHERE status = 'open'
      AND (
        last_verdict_at IS NULL
        OR last_verdict_at < now() - interval '20 minutes'
        OR last_polled_at IS NULL
        OR last_polled_at < now() - interval '20 minutes'
      )
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM alerts
      WHERE user_id = pos.user_id
        AND alert_type = 'pipeline_stale_verdict'
        AND signal_id IS NOT DISTINCT FROM pos.id
        AND sent_at > now() - interval '14 minutes'
    ) INTO recent_dupe;
    IF NOT recent_dupe THEN
      INSERT INTO alerts (user_id, signal_id, alert_type, message, sent_via, sent_at)
      VALUES (
        pos.user_id,
        pos.id,
        'pipeline_stale_verdict',
        format(
          '%s position: live P&L and thesis verdict have not refreshed in over 20 min during market hours. monitor-positions is likely down — do NOT trust the on-screen verdict or P&L; check your broker directly.',
          pos.ticker
        ),
        'in_app',
        now()
      );
    END IF;
  END LOOP;
END
$func$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled — skipping pipeline-liveness-watchdog.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pipeline-liveness-watchdog') THEN
    PERFORM cron.unschedule('pipeline-liveness-watchdog');
  END IF;
  -- Every 15 min, 13:00-20:59 UTC, M-F. RTH-bound so the function
  -- itself needs no session check — if it's running, it's RTH.
  PERFORM cron.schedule(
    'pipeline-liveness-watchdog',
    '*/15 13-20 * * 1-5',
    $cron$ SELECT public.pipeline_liveness_check(); $cron$
  );
  RAISE NOTICE 'pipeline-liveness-watchdog scheduled: */15 13-20 * * 1-5 UTC';
END
$$;
