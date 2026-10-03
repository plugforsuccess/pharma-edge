-- Net worth: retirement accounts, vehicles and debts as holdings (owner,
-- 2026-10-03 — so net worth matches what public wealth surveys count).
--
-- New leaps_positions.instrument_type values (no ticker, a `name`):
--   retirement — cost_basis = current_value = balance.
--                details = { account_kind: traditional_401k | traditional_ira
--                | roth_401k | roth_ira | hsa }. Pre-tax accounts are taxed
--                as ordinary income on withdrawal; Roth / HSA tax-free.
--   vehicle    — current_value = market value, cost_basis = purchase price
--                (or the value when not entered). details = { loan }.
--   debt       — cost_basis = current_value = balance owed (subtracted from
--                net worth). details = { debt_kind, apr }.
--
-- Additive: widens three CHECKs; no data changes. RLS is unchanged.

ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_instrument_type_check;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_instrument_type_check CHECK (
  instrument_type IN ('equity_option', 'index_option_1256', 'stock', 'crypto', 'cash', 'real_estate',
                      'retirement', 'vehicle', 'debt')
);

ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_ticker_required_chk;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_ticker_required_chk CHECK (
  instrument_type IN ('cash', 'real_estate', 'retirement', 'vehicle', 'debt') OR ticker IS NOT NULL
);

ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_name_required_chk;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_name_required_chk CHECK (
  instrument_type NOT IN ('cash', 'real_estate', 'retirement', 'vehicle', 'debt') OR name IS NOT NULL
);

COMMENT ON COLUMN public.leaps_positions.details IS
  'Per-type fields. cash: {apy, account_kind}. real_estate: {kind: primary|rental, mortgage, selling_cost_pct, depreciation, exclusion_eligible}. retirement: {account_kind}. vehicle: {loan}. debt: {debt_kind, apr}.';
