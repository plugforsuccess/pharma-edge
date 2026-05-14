-- snapshot-gex cron — fires compute-gex(matrix:true, archive:true,
-- refresh:true) for every ticker in the curated universe every 5 min
-- during RTH plus an EOD snapshot at close. Replaces the GH Actions
-- workflow (.github/workflows/snapshot-gex.yml) which was dropping
-- ticks under hosted-runner load — by 4:05pm ET on 2026-05-14 the
-- last successful snapshot was 87 minutes stale despite 17 expected
-- ticks in that window.
--
-- compute-gex's auth was patched in this PR to recognize a vault
-- service-role JWT via JWT-payload role check, mirroring the model
-- monitor-positions uses. So we can call it directly from pg_cron
-- using cron_service_role_jwt — no fanout function needed.
--
-- net.http_post is async: returns a request_id immediately and the
-- response lands in net._http_response later. So this function fires
-- all ~60 requests in fast succession and returns. compute-gex's own
-- 5-min snapshot cache + Polygon-first pipeline handle the load.
--
-- PREREQUISITES (already in place from prior cron migrations):
--   * pg_cron + pg_net enabled.
--   * vault.decrypted_secrets contains cron_service_role_jwt.

CREATE OR REPLACE FUNCTION public.snapshot_gex_fanout()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t text;
  -- Keep this list in sync with src/lib/tickerUniverse.js HOT_TICKERS
  -- and .github/workflows/snapshot-gex.yml TICKERS. Source of truth
  -- moves to this function once the GH Actions schedule is disabled.
  tickers text[] := ARRAY[
    'SPY','QQQ','IWM','DIA',
    'GLD','SLV','TLT','USO',
    'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA',
    'AMD','AVGO','INTC','ORCL','CRM','ADBE','NFLX',
    'TSM','ASML','AMAT','LRCX','QCOM','MRVL',
    'MU','WDC','SNDK',
    'VRT','DLR','EQIX','CRWV','NBIS','IREN','SMCI','ANET',
    'JPM','GS','BAC','WFC',
    'LLY','NVO','PFE','MRK','JNJ','UNH','ABBV',
    'WMT','COST','HD','MCD','NKE','DIS',
    'XOM','CVX','COP',
    'VST','CEG','NEE','SMR','OKLO','CCJ','BE',
    'COIN','PLTR','UBER','ARM','BABA','GME',
    -- Leopold portfolio
    'PUMP','KEEL','RIOT','SEI','HUT','LBRT','EQT','KRC','CLSK','BW',
    'TSEM','PSIX','COHR','CIFR','CORZ','LITE','WYFI','APLD'
  ];
  jwt text;
BEGIN
  SELECT decrypted_secret INTO jwt
    FROM vault.decrypted_secrets
    WHERE name = 'cron_service_role_jwt'
    LIMIT 1;
  IF jwt IS NULL THEN
    RAISE EXCEPTION 'cron_service_role_jwt not in vault';
  END IF;
  FOREACH t IN ARRAY tickers LOOP
    PERFORM net.http_post(
      url := 'https://rghoynbaykeyjbhqmaff.supabase.co/functions/v1/compute-gex',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || jwt,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'ticker', t,
        'matrix', true,
        'archive', true,
        'refresh', true
      ),
      timeout_milliseconds := 60000
    );
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not enabled — skipping snapshot-gex-rth schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_net not enabled — skipping snapshot-gex-rth schedule.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'snapshot-gex-rth') THEN
    PERFORM cron.unschedule('snapshot-gex-rth');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'snapshot-gex-eod') THEN
    PERFORM cron.unschedule('snapshot-gex-eod');
  END IF;

  -- Intraday: every 5 min during the GH-Actions-equivalent window
  -- (13:00-20:55 UTC, M-F). Covers RTH under both EST and EDT.
  PERFORM cron.schedule(
    'snapshot-gex-rth',
    '*/5 13-20 * * 1-5',
    $cron$ SELECT public.snapshot_gex_fanout(); $cron$
  );

  -- EOD close snapshot — fires once at 20:30 UTC (EDT close) and
  -- again at 21:30 UTC (EST close). The function is idempotent
  -- (compute-gex upserts on the 5-min bucket), so the redundancy
  -- across the two seasonal entries is harmless.
  PERFORM cron.schedule(
    'snapshot-gex-eod',
    '30 20,21 * * 1-5',
    $cron$ SELECT public.snapshot_gex_fanout(); $cron$
  );

  RAISE NOTICE 'snapshot-gex pg_cron jobs scheduled';
END
$$;
