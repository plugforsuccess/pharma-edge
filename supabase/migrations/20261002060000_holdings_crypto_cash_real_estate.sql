-- More holding types on the Positions page: crypto, cash and real estate.
--
-- leaps_positions keeps one row per holding. New instrument types:
--   crypto       — coin (ticker, e.g. BTC), quantity in `shares`; taxed
--                  like stock (short/long term by holding period).
--   cash         — a cash account; cost_basis = current_value = balance.
--                  details = { apy, account_kind: savings | money_market |
--                  t_bills | cd | checking }. Interest is ordinary income
--                  (T-bills skip state tax).
--   real_estate  — cost_basis = purchase price + improvements; current_value
--                  = market value. details = { kind: primary | rental,
--                  mortgage, selling_cost_pct, depreciation,
--                  exclusion_eligible }.
-- Cash and real estate have no ticker, so ticker becomes nullable (still
-- required for options, stock and crypto) and a free-text `name` labels
-- the holding ("Ally savings", "Home").
--
-- Additive: no data changes. RLS on leaps_positions is unchanged (users
-- write their own rows).

ALTER TABLE public.leaps_positions ADD COLUMN IF NOT EXISTS name text
  CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 60);
ALTER TABLE public.leaps_positions ADD COLUMN IF NOT EXISTS details jsonb
  CHECK (details IS NULL OR jsonb_typeof(details) = 'object');

ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_instrument_type_check;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_instrument_type_check CHECK (
  instrument_type IN ('equity_option', 'index_option_1256', 'stock', 'crypto', 'cash', 'real_estate')
);

-- Only options carry call/put.
ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_option_type_chk;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_option_type_chk CHECK (
  (instrument_type IN ('equity_option', 'index_option_1256')) = (option_type IS NOT NULL)
);

ALTER TABLE public.leaps_positions ALTER COLUMN ticker DROP NOT NULL;
ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_ticker_check;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_ticker_check CHECK (
  ticker IS NULL OR ticker ~ '^[A-Z0-9.]{1,12}$'
);
ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_ticker_required_chk;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_ticker_required_chk CHECK (
  instrument_type IN ('cash', 'real_estate') OR ticker IS NOT NULL
);
ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_name_required_chk;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_name_required_chk CHECK (
  instrument_type NOT IN ('cash', 'real_estate') OR name IS NOT NULL
);

COMMENT ON COLUMN public.leaps_positions.name IS
  'Label for holdings without a ticker (cash accounts, real estate).';
COMMENT ON COLUMN public.leaps_positions.details IS
  'Per-type fields. cash: {apy, account_kind}. real_estate: {kind: primary|rental, mortgage, selling_cost_pct, depreciation, exclusion_eligible}.';
