-- Expand the snapshot-gex fanout universe with 20 high-conviction
-- options-trader ETFs (sector SPDRs, semis, themes, credit / EM).
--
-- Same names land in:
--   * src/lib/tickerUniverse.js HOT_TICKERS          (UI picker)
--   * dxlink-worker/src/tickers.ts TRACKED_TICKERS   (streamed Greeks)
--   * .github/workflows/snapshot-gex.yml TICKERS     (GH-Actions backup)
--
-- This migration replaces snapshot_gex_fanout() so the pg_cron jobs
-- (snapshot-gex-rth every 5 min RTH + snapshot-gex-eod at close) pull
-- the expanded set into gex_history. Same fanout pattern as the
-- original 20260514130000 migration — async net.http_post per ticker,
-- compute-gex archives each into gex_history. Function body is
-- otherwise unchanged.

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
    'GLD','SLV','TLT','USO','HYG','EEM',
    'XLK','XLF','XLE','XLV','XLY','XLP','XLU','XLI','XLB','XLC','XLRE',
    'SMH','SOXX','KRE','XBI','KWEB','ARKK','IBIT',
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
