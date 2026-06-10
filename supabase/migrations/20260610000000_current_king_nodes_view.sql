-- current_king_nodes — per-ticker, per-expiration king-node (largest
-- |GEX| strike) across the front 3 expiration columns of the most
-- recent matrix snapshot.
--
-- Powers:
--   * /markets/king-board     (UI grid, sortable by |GEX|)
--   * digest-king-nodes cron  (daily push of top 10)
--   * ad-hoc SQL              (`SELECT * FROM current_king_nodes WHERE ticker = 'SPY'`)
--
-- Methodology: explode payload->cells (2D array, [strike_idx][exp_idx])
-- via two LATERAL jsonb_array_elements WITH ORDINALITY, rank rows
-- within (ticker, exp_idx) by abs(gex), keep rn=1.
--
-- Security model: security_invoker=true so the view honors the caller's
-- RLS on gex_history (authenticated SELECT). Anon doesn't see it.

CREATE OR REPLACE VIEW public.current_king_nodes
WITH (security_invoker = true) AS
WITH latest AS (
  SELECT DISTINCT ON (ticker) ticker, snapshot_at, payload
  FROM public.gex_history
  ORDER BY ticker, snapshot_at DESC
),
exploded AS (
  SELECT
    l.ticker,
    l.snapshot_at,
    (strike_row.ordinality - 1)::int AS strike_idx,
    (l.payload->'strikes'->>((strike_row.ordinality - 1)::int))::numeric AS strike,
    (cell.ordinality - 1)::int AS exp_idx,
    (l.payload->'expirations'->((cell.ordinality - 1)::int)->>'date') AS exp_date,
    (l.payload->'expirations'->((cell.ordinality - 1)::int)->>'dte')::int AS dte,
    NULLIF(cell.value::text, 'null')::numeric AS gex
  FROM latest l
  CROSS JOIN LATERAL jsonb_array_elements(l.payload->'cells')
    WITH ORDINALITY AS strike_row(row_arr, ordinality)
  CROSS JOIN LATERAL jsonb_array_elements(strike_row.row_arr)
    WITH ORDINALITY AS cell(value, ordinality)
  WHERE NULLIF(cell.value::text, 'null') IS NOT NULL
),
ranked AS (
  SELECT
    ticker, snapshot_at, exp_idx, exp_date, dte, strike, gex,
    row_number() OVER (PARTITION BY ticker, exp_idx ORDER BY abs(gex) DESC) AS rn
  FROM exploded
  WHERE exp_idx < 3
)
SELECT
  ticker,
  snapshot_at,
  exp_idx,
  exp_date,
  dte,
  strike AS king_strike,
  gex AS king_gex,
  CASE WHEN gex > 0 THEN 'call' ELSE 'put' END AS side
FROM ranked
WHERE rn = 1;

GRANT SELECT ON public.current_king_nodes TO authenticated;
