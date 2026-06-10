-- Add spot price to current_king_nodes so the King Board can render
-- distance from king strike to underlying. Spot is captured in the
-- matrix payload at compute time — it's the underlying_asset.price
-- the option chain was snapshotted against, which is the right anchor
-- for the king-node analysis (matches the Greeks the GEX was computed
-- from). Falls back to NULL when the payload predates this field
-- (none in production today, defensive only).

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
    NULLIF(l.payload->>'spot', 'null')::numeric AS spot,
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
    ticker, snapshot_at, spot, exp_idx, exp_date, dte, strike, gex,
    row_number() OVER (PARTITION BY ticker, exp_idx ORDER BY abs(gex) DESC) AS rn
  FROM exploded
  WHERE exp_idx < 3
)
SELECT
  ticker,
  snapshot_at,
  spot,
  exp_idx,
  exp_date,
  dte,
  strike AS king_strike,
  gex AS king_gex,
  CASE WHEN gex > 0 THEN 'call' ELSE 'put' END AS side
FROM ranked
WHERE rn = 1;

GRANT SELECT ON public.current_king_nodes TO authenticated;
