-- Add SMH (VanEck Semiconductor ETF) to the snapshot-gex fanout.
--
-- Mirrors:
--   * src/lib/tickerUniverse.js HOT_TICKERS          (UI picker)
--   * dxlink-worker/src/tickers.ts TRACKED_TICKERS   (streamed Greeks)
--   * .github/workflows/snapshot-gex.yml TICKERS     (GH-Actions backup)
--
-- Replaces snapshot_gex_fanout() with the SPY/QQQ-tier list + SMH so
-- the 5-min and EOD pg_cron jobs (snapshot-gex-rth / snapshot-gex-eod)
-- archive SMH GEX into gex_history.

CREATE OR REPLACE FUNCTION public.snapshot_gex_fanout()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t text;
  tickers text[] := ARRAY[
    'SPY','QQQ','IWM','DIA',
    'GLD','SLV','TLT','USO','SMH',
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
