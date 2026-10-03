-- Retirement money is an account, not a holding type (owner, 2026-10-03:
-- "the 6 we have now are sufficient").
--
-- 1. leaps_positions.account_type: where the holding sits. The tax math
--    follows the account, not the asset:
--      taxable      — normal capital-gains / dividend / interest rules
--      traditional  — 401(k) / 403(b) / traditional or SEP IRA: no tax on
--                     sales, dividends or interest inside; withdrawals are
--                     ordinary income
--      roth, hsa    — tax-free (qualified / medical withdrawals)
-- 2. Cars and debts are two optional totals on the tax profile, counted
--    in net worth (not holdings): leaps_tax_profiles.other_assets and
--    other_debts.
-- 3. Undo 20261003130000's retirement / vehicle / debt instrument types
--    (no rows used them).
--
-- Additive otherwise; RLS unchanged.

ALTER TABLE public.leaps_positions ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'taxable'
  CHECK (account_type IN ('taxable', 'traditional', 'roth', 'hsa'));

ALTER TABLE public.leaps_tax_profiles ADD COLUMN IF NOT EXISTS other_assets numeric
  CHECK (other_assets IS NULL OR other_assets >= 0);
ALTER TABLE public.leaps_tax_profiles ADD COLUMN IF NOT EXISTS other_debts numeric
  CHECK (other_debts IS NULL OR other_debts >= 0);

ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_instrument_type_check;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_instrument_type_check CHECK (
  instrument_type IN ('equity_option', 'index_option_1256', 'stock', 'crypto', 'cash', 'real_estate')
);
ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_ticker_required_chk;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_ticker_required_chk CHECK (
  instrument_type IN ('cash', 'real_estate') OR ticker IS NOT NULL
);
ALTER TABLE public.leaps_positions DROP CONSTRAINT IF EXISTS leaps_positions_name_required_chk;
ALTER TABLE public.leaps_positions ADD CONSTRAINT leaps_positions_name_required_chk CHECK (
  instrument_type NOT IN ('cash', 'real_estate') OR name IS NOT NULL
);

COMMENT ON COLUMN public.leaps_positions.account_type IS
  'taxable | traditional (401k/403b/IRA, ordinary income on withdrawal) | roth | hsa (tax-free).';
COMMENT ON COLUMN public.leaps_positions.details IS
  'Per-type fields. cash: {apy, account_kind}. real_estate: {kind: primary|rental, mortgage, selling_cost_pct, depreciation, exclusion_eligible}.';
COMMENT ON COLUMN public.leaps_tax_profiles.other_assets IS 'Cars and other assets not tracked as holdings (net worth only).';
COMMENT ON COLUMN public.leaps_tax_profiles.other_debts IS 'Debts besides mortgages: cards, student / car / personal loans (net worth only).';
