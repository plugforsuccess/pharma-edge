-- After-tax LEAPS targets + live after-tax value.
--
-- Four tables:
--   * tax_year_config    — federal brackets, LTCG thresholds, NIIT per
--                          tax year. Reference data, updated yearly from
--                          IRS sources. Exactly one row is_current.
--   * state_tax_rates    — per (tax_year, state) ordinary + LTCG brackets.
--                          Separate LTCG schedule because some states tax
--                          capital gains differently (WA, MT, ...).
--   * leaps_tax_profiles — per-user inputs (portfolio, allocation, filing
--                          status, income, state, targets, CPA override).
--   * leaps_positions    — per-user LEAPS positions (basis, current value,
--                          purchase date). Manual entry today; the
--                          broker integration writes here later.
--
-- Bracket jsonb shape: {"single": [[lower_bound, rate], ...], "mfj": ...,
-- "mfs": ..., "hoh": ...}. Lower bounds ascending from 0, rates decimal.
-- A state row may omit statuses that equal "single" (flat-rate states).
-- src/utils/afterTax.js is the only consumer and documents the contract.
--
-- Reference tables: authenticated SELECT, service-role writes. User
-- tables: own-row CRUD, cached (select auth.uid()) form.

-- ── 1. tax_year_config ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tax_year_config (
  tax_year      integer PRIMARY KEY CHECK (tax_year BETWEEN 2020 AND 2100),
  is_current    boolean NOT NULL DEFAULT false,
  ordinary      jsonb   NOT NULL,   -- federal ordinary-income brackets
  ltcg          jsonb   NOT NULL,   -- federal 0/15/20% LTCG thresholds
  niit          jsonb   NOT NULL,   -- {"rate": 0.038, "thresholds": {...}}
  sources       text[]  NOT NULL DEFAULT '{}',
  notes         text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tax_year_config_one_current_idx
  ON public.tax_year_config (is_current) WHERE is_current;

DROP TRIGGER IF EXISTS tax_year_config_set_updated_at ON public.tax_year_config;
CREATE TRIGGER tax_year_config_set_updated_at
  BEFORE UPDATE ON public.tax_year_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.tax_year_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_year_config_select_auth ON public.tax_year_config;
CREATE POLICY tax_year_config_select_auth
  ON public.tax_year_config FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS tax_year_config_service_writes ON public.tax_year_config;
CREATE POLICY tax_year_config_service_writes
  ON public.tax_year_config FOR ALL
  TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.tax_year_config IS
  'Federal tax figures per tax year for the after-tax LEAPS feature. Update yearly from the IRS inflation-adjustment Rev. Proc.; flip is_current to the new year. NIIT thresholds are statutory (not inflation-adjusted).';

-- ── 2. state_tax_rates ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.state_tax_rates (
  tax_year            integer NOT NULL REFERENCES public.tax_year_config(tax_year) ON DELETE CASCADE,
  state_code          text    NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  state_name          text    NOT NULL,
  kind                text    NOT NULL CHECK (kind IN ('none', 'flat', 'progressive')),
  ordinary            jsonb   NOT NULL,
  -- NULL = LTCG taxed as ordinary income (after ltcg_exclusion_pct).
  ltcg                jsonb,
  -- 'gain' = state LTCG brackets apply to the gain alone (Washington);
  -- 'income' = to total income including the gain.
  ltcg_applies_to     text    NOT NULL DEFAULT 'income' CHECK (ltcg_applies_to IN ('income', 'gain')),
  ltcg_exclusion_pct  numeric NOT NULL DEFAULT 0 CHECK (ltcg_exclusion_pct >= 0 AND ltcg_exclusion_pct <= 1),
  -- NULL = short-term gains taxed as ordinary income. Set where a state
  -- taxes ST gains at a different rate (Massachusetts: 8.5%).
  stcg                jsonb,
  confidence          text    NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  source_url          text,
  notes               text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tax_year, state_code)
);

DROP TRIGGER IF EXISTS state_tax_rates_set_updated_at ON public.state_tax_rates;
CREATE TRIGGER state_tax_rates_set_updated_at
  BEFORE UPDATE ON public.state_tax_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.state_tax_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS state_tax_rates_select_auth ON public.state_tax_rates;
CREATE POLICY state_tax_rates_select_auth
  ON public.state_tax_rates FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS state_tax_rates_service_writes ON public.state_tax_rates;
CREATE POLICY state_tax_rates_service_writes
  ON public.state_tax_rates FOR ALL
  TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.state_tax_rates IS
  'State income-tax brackets per tax year for the after-tax LEAPS feature. Update yearly from state revenue departments. confidence flags rows that need owner verification.';
COMMENT ON COLUMN public.state_tax_rates.ltcg IS
  'Optional LTCG schedule. The app computes the state long-term rate as the EFFECTIVE rate on the gain slice from this schedule (or ordinary × (1 − ltcg_exclusion_pct)), never a single flat number: exclusions and WA''s deduction-then-7%/9.9% make the rate depend on the gain size.';

-- ── 3. leaps_tax_profiles ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.leaps_tax_profiles (
  user_id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_size        numeric NOT NULL DEFAULT 100000 CHECK (portfolio_size > 0),
  leaps_allocation_pct  numeric NOT NULL DEFAULT 0.30 CHECK (leaps_allocation_pct > 0 AND leaps_allocation_pct <= 1),
  filing_status         text    NOT NULL DEFAULT 'single' CHECK (filing_status IN ('single', 'mfj', 'mfs', 'hoh')),
  annual_income         numeric NOT NULL DEFAULT 0 CHECK (annual_income >= 0),
  state_code            text    CHECK (state_code IS NULL OR state_code ~ '^[A-Z]{2}$'),
  target_pcts           numeric[] NOT NULL DEFAULT '{0.50,0.45,0.40,0.35,0.30,0.25,0.20}',
  selected_target_pct   numeric CHECK (selected_target_pct IS NULL OR (selected_target_pct > 0 AND selected_target_pct <= 10)),
  -- CPA-provided rates. NULL = derive from filing status/income/state.
  lt_rate_override      numeric CHECK (lt_rate_override IS NULL OR (lt_rate_override >= 0 AND lt_rate_override <= 0.99)),
  st_rate_override      numeric CHECK (st_rate_override IS NULL OR (st_rate_override >= 0 AND st_rate_override <= 0.99)),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS leaps_tax_profiles_set_updated_at ON public.leaps_tax_profiles;
CREATE TRIGGER leaps_tax_profiles_set_updated_at
  BEFORE UPDATE ON public.leaps_tax_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.leaps_tax_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leaps_tax_profiles_select_own ON public.leaps_tax_profiles;
CREATE POLICY leaps_tax_profiles_select_own ON public.leaps_tax_profiles
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS leaps_tax_profiles_insert_own ON public.leaps_tax_profiles;
CREATE POLICY leaps_tax_profiles_insert_own ON public.leaps_tax_profiles
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS leaps_tax_profiles_update_own ON public.leaps_tax_profiles;
CREATE POLICY leaps_tax_profiles_update_own ON public.leaps_tax_profiles
  FOR UPDATE TO authenticated USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS leaps_tax_profiles_delete_own ON public.leaps_tax_profiles;
CREATE POLICY leaps_tax_profiles_delete_own ON public.leaps_tax_profiles
  FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);

-- ── 4. leaps_positions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.leaps_positions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker         text NOT NULL CHECK (ticker ~ '^[A-Z.]{1,10}$'),
  -- equity_option     = stock/ETF options, normal > 1 year long-term rule
  -- index_option_1256 = SPX/XSP/NDX/RUT/VIX…: IRC §1256 60% LT / 40% ST
  --                     regardless of holding period (no countdown)
  -- stock             = shares, incl. stock acquired by exercising a call
  instrument_type text NOT NULL DEFAULT 'equity_option'
                 CHECK (instrument_type IN ('equity_option', 'index_option_1256', 'stock')),
  option_type    text CHECK (option_type IN ('C', 'P')),
  strike         numeric CHECK (strike IS NULL OR strike > 0),
  expiration     date,
  contracts      integer CHECK (contracts IS NULL OR contracts > 0),
  shares         numeric CHECK (shares IS NULL OR shares > 0),
  cost_basis     numeric NOT NULL CHECK (cost_basis > 0),
  current_value  numeric NOT NULL CHECK (current_value >= 0),
  value_as_of    timestamptz NOT NULL DEFAULT now(),
  purchase_date  date NOT NULL,
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'broker')),
  closed_at      timestamptz,
  close_reason   text CHECK (close_reason IN ('sold', 'exercised', 'expired')),
  -- Exercise lineage: the stock row points at the call it came from.
  -- The stock carries its OWN purchase_date (= exercise date); the
  -- option's holding period does not carry forward.
  exercised_from_id uuid REFERENCES public.leaps_positions(id) ON DELETE SET NULL,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leaps_positions_option_type_chk CHECK (
    (instrument_type = 'stock') = (option_type IS NULL)
  ),
  CONSTRAINT leaps_positions_close_reason_chk CHECK (
    close_reason IS NULL OR closed_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS leaps_positions_user_open_idx
  ON public.leaps_positions (user_id, purchase_date) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS leaps_positions_exercised_from_idx
  ON public.leaps_positions (exercised_from_id) WHERE exercised_from_id IS NOT NULL;

DROP TRIGGER IF EXISTS leaps_positions_set_updated_at ON public.leaps_positions;
CREATE TRIGGER leaps_positions_set_updated_at
  BEFORE UPDATE ON public.leaps_positions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.leaps_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leaps_positions_select_own ON public.leaps_positions;
CREATE POLICY leaps_positions_select_own ON public.leaps_positions
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS leaps_positions_insert_own ON public.leaps_positions;
CREATE POLICY leaps_positions_insert_own ON public.leaps_positions
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS leaps_positions_update_own ON public.leaps_positions;
CREATE POLICY leaps_positions_update_own ON public.leaps_positions
  FOR UPDATE TO authenticated USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
DROP POLICY IF EXISTS leaps_positions_delete_own ON public.leaps_positions;
CREATE POLICY leaps_positions_delete_own ON public.leaps_positions
  FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);

-- Exercise a long call atomically: close the option row and open a
-- stock row whose basis = premium + strike × shares and whose holding
-- clock starts at the exercise date. SECURITY INVOKER so RLS applies —
-- a user can only exercise their own option. Mirrors exerciseCall() in
-- src/utils/afterTax.js; keep the basis formula in sync.
CREATE OR REPLACE FUNCTION public.exercise_leaps_position(
  p_option_id      uuid,
  p_exercise_date  date,
  p_current_value  numeric,
  p_shares         numeric DEFAULT NULL
) RETURNS public.leaps_positions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  opt    public.leaps_positions;
  n      numeric;
  stock  public.leaps_positions;
BEGIN
  SELECT * INTO opt FROM public.leaps_positions
   WHERE id = p_option_id AND user_id = (select auth.uid())
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'position not found' USING ERRCODE = 'P0002';
  END IF;
  IF opt.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'position already closed';
  END IF;
  IF opt.instrument_type <> 'equity_option' OR opt.option_type <> 'C' THEN
    RAISE EXCEPTION 'only long stock/ETF calls can be exercised into stock';
  END IF;
  IF opt.strike IS NULL THEN
    RAISE EXCEPTION 'strike is required to exercise';
  END IF;
  IF p_exercise_date < opt.purchase_date OR p_exercise_date > current_date + 1 THEN
    RAISE EXCEPTION 'exercise date must be between purchase date and today';
  END IF;
  IF p_current_value IS NULL OR p_current_value < 0 THEN
    RAISE EXCEPTION 'current value is required';
  END IF;
  n := COALESCE(p_shares, opt.contracts * 100);
  IF n IS NULL OR n <= 0 THEN
    RAISE EXCEPTION 'shares (or contracts) are required to exercise';
  END IF;

  INSERT INTO public.leaps_positions
    (user_id, ticker, instrument_type, option_type, shares, cost_basis,
     current_value, purchase_date, source, exercised_from_id, notes)
  VALUES
    (opt.user_id, opt.ticker, 'stock', NULL, n, opt.cost_basis + opt.strike * n,
     p_current_value, p_exercise_date, opt.source, opt.id,
     format('Exercised %s $%s call (premium $%s) on %s',
            opt.ticker, opt.strike, round(opt.cost_basis), p_exercise_date))
  RETURNING * INTO stock;

  UPDATE public.leaps_positions
     SET closed_at = p_exercise_date::timestamptz, close_reason = 'exercised'
   WHERE id = opt.id;

  RETURN stock;
END;
$$;

REVOKE ALL ON FUNCTION public.exercise_leaps_position(uuid, date, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exercise_leaps_position(uuid, date, numeric, numeric) TO authenticated;

COMMENT ON TABLE public.leaps_positions IS
  'User LEAPS positions for after-tax tracking. Per-position, never netted. source=manual today; source=broker once automated LEAPS execution lands.';

-- ── 5. Seed: tax year 2026 ────────────────────────────────────────
--
-- Federal: IRS Rev. Proc. 2025-32 (high confidence). State: compiled
-- from state revenue departments + Tax Foundation's 2026 table as of
-- 2026-10. Rows marked confidence='medium'/'low' use 2025 thresholds
-- or approximations noted per row — verify before relying on them.
-- Local/county/city income taxes are not modeled.

INSERT INTO public.tax_year_config (tax_year, is_current, ordinary, ltcg, niit, sources, notes) VALUES (
  2026, true,
  '{"single":[[0,0.1],[12400,0.12],[50400,0.22],[105700,0.24],[201775,0.32],[256225,0.35],[640600,0.37]],"mfj":[[0,0.1],[24800,0.12],[100800,0.22],[211400,0.24],[403550,0.32],[512450,0.35],[768700,0.37]],"mfs":[[0,0.1],[12400,0.12],[50400,0.22],[105700,0.24],[201775,0.32],[256225,0.35],[384350,0.37]],"hoh":[[0,0.1],[17700,0.12],[67450,0.22],[105700,0.24],[201750,0.32],[256200,0.35],[640600,0.37]]}'::jsonb,
  '{"single":[[0,0],[49450,0.15],[545500,0.2]],"mfj":[[0,0],[98900,0.15],[613700,0.2]],"mfs":[[0,0],[49450,0.15],[306850,0.2]],"hoh":[[0,0],[66200,0.15],[579600,0.2]]}'::jsonb,
  '{"rate":0.038,"thresholds":{"single":200000,"hoh":200000,"mfj":250000,"mfs":125000}}'::jsonb,
  ARRAY['https://www.irs.gov/pub/irs-drop/rp-25-32.pdf', 'https://www.irs.gov/newsroom/irs-releases-tax-inflation-adjustments-for-tax-year-2026-including-amendments-from-the-one-big-beautiful-bill'],
  'Rev. Proc. 2025-32. Brackets are on taxable income. NIIT thresholds are statutory (IRC §1411) and not inflation-adjusted.'
) ON CONFLICT (tax_year) DO NOTHING;

INSERT INTO public.state_tax_rates
  (tax_year, state_code, state_name, kind, ordinary, ltcg, ltcg_applies_to, ltcg_exclusion_pct, stcg, confidence, source_url, notes)
VALUES
  (2026, 'AL', 'Alabama', 'progressive', '{"single":[[0,0.02],[500,0.04],[3000,0.05]],"mfj":[[0,0.02],[1000,0.04],[6000,0.05]],"hoh":[[0,0.02],[500,0.04],[3000,0.05]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.revenue.alabama.gov/individual-corporate/taxes-administered-by-individual-corporate-income-tax/', 'Statutory, not indexed. Federal income tax deduction not modeled.'),
  (2026, 'AK', 'Alaska', 'none', '{"single":[[0,0]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/', NULL),
  (2026, 'AZ', 'Arizona', 'flat', '{"single":[[0,0.025]]}'::jsonb, NULL, 'income', 0.25, NULL, 'medium', 'https://azdor.gov/', '25% subtraction of net LTCG on assets acquired after 2011.'),
  (2026, 'AR', 'Arkansas', 'progressive', '{"single":[[0,0],[5600,0.02],[11200,0.03],[16000,0.034],[26400,0.037]]}'::jsonb, NULL, 'income', 0.5, NULL, 'medium', 'https://www.dfa.arkansas.gov/wp-content/uploads/whformula_2026.pdf', 'One schedule for all statuses. Top rate 3.7% (Act 1 of 2026 special session, retroactive). High-income table above ~$94.7k has the same 3.7% marginal rate. 50% LTCG exclusion; gains above $10M fully exempt (not modeled).'),
  (2026, 'CA', 'California', 'progressive', '{"single":[[0,0.01],[11079,0.02],[26264,0.04],[41452,0.06],[57542,0.08],[72724,0.093],[371479,0.103],[445771,0.113],[742953,0.123],[1000000,0.133]],"mfj":[[0,0.01],[22158,0.02],[52528,0.04],[82904,0.06],[115084,0.08],[145448,0.093],[742958,0.103],[891542,0.113],[1000000,0.123],[1485906,0.133]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://www.ftb.ca.gov/forms/2025/2025-540-tax-rate-schedules.pdf', '2025 FTB thresholds — 2026 schedule not yet published. Includes the 1% Mental Health Services Tax above $1M (all statuses). HoH has its own schedule (not loaded; falls back to single).'),
  (2026, 'CO', 'Colorado', 'flat', '{"single":[[0,0.044]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://tax.colorado.gov/', '4.4% baseline; a TABOR temporary cut for 2026 is not yet known.'),
  (2026, 'CT', 'Connecticut', 'progressive', '{"single":[[0,0.02],[10000,0.045],[50000,0.055],[100000,0.06],[200000,0.065],[250000,0.069],[500000,0.0699]],"mfj":[[0,0.02],[20000,0.045],[100000,0.055],[200000,0.06],[400000,0.065],[500000,0.069],[1000000,0.0699]],"hoh":[[0,0.02],[16000,0.045],[80000,0.055],[160000,0.06],[320000,0.065],[400000,0.069],[800000,0.0699]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://portal.ct.gov/drs', '2% bracket phase-out and benefit recapture not modeled. HoH schedule lower confidence.'),
  (2026, 'DE', 'Delaware', 'progressive', '{"single":[[0,0],[2000,0.022],[5000,0.039],[10000,0.048],[20000,0.052],[25000,0.0555],[60000,0.066]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://revenue.delaware.gov/', 'Same schedule for all statuses.'),
  (2026, 'DC', 'District of Columbia', 'progressive', '{"single":[[0,0.04],[10000,0.06],[40000,0.065],[60000,0.085],[250000,0.0925],[500000,0.0975],[1000000,0.1075]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://otr.cfo.dc.gov/', 'Same schedule for all statuses.'),
  (2026, 'FL', 'Florida', 'none', '{"single":[[0,0]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/', NULL),
  (2026, 'GA', 'Georgia', 'flat', '{"single":[[0,0.0499]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.bdo.com/insights/tax/georgia-enacts-income-tax-reduction-bill', 'HB 463 (signed 5/11/2026, retroactive to 1/1/2026): 4.99%, stepping down 0.125 pt/yr to 3.99%.'),
  (2026, 'HI', 'Hawaii', 'progressive', '{"single":[[0,0.014],[9600,0.032],[14400,0.055],[19200,0.064],[24000,0.068],[36000,0.072],[48000,0.076],[125000,0.079],[175000,0.0825],[225000,0.09],[275000,0.1],[325000,0.11]],"mfj":[[0,0.014],[19200,0.032],[28800,0.055],[38400,0.064],[48000,0.068],[72000,0.072],[96000,0.076],[250000,0.079],[350000,0.0825],[450000,0.09],[550000,0.1],[650000,0.11]]}'::jsonb, '{"single":[[0,0.014],[9600,0.032],[14400,0.055],[19200,0.064],[24000,0.068],[36000,0.072],[48000,0.0725],[125000,0.0725],[175000,0.0725],[225000,0.0725],[275000,0.0725],[325000,0.0725]],"mfj":[[0,0.014],[19200,0.032],[28800,0.055],[38400,0.064],[48000,0.068],[72000,0.072],[96000,0.0725],[250000,0.0725],[350000,0.0725],[450000,0.0725],[550000,0.0725],[650000,0.0725]]}'::jsonb, 'income', 0, NULL, 'medium', 'https://files.hawaii.gov/tax/news/announce/ann25-07.pdf', 'Act 46 (2024) brackets for 2025–2026. LTCG alternative tax caps the rate at 7.25%. HoH separate schedule not loaded (falls back to single).'),
  (2026, 'ID', 'Idaho', 'flat', '{"single":[[0,0.053]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://gov.idaho.gov/', 'HB 40 (2025) 5.3%; no further 2026 cut found.'),
  (2026, 'IL', 'Illinois', 'flat', '{"single":[[0,0.0495]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://tax.illinois.gov/', NULL),
  (2026, 'IN', 'Indiana', 'flat', '{"single":[[0,0.0295]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxfoundation.org/research/all/state/2026-state-tax-changes/', '2.95% for 2026. County income taxes are extra (not modeled).'),
  (2026, 'IA', 'Iowa', 'flat', '{"single":[[0,0.038]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://revenue.iowa.gov/', NULL),
  (2026, 'KS', 'Kansas', 'progressive', '{"single":[[0,0.052],[23000,0.0558]],"mfj":[[0,0.052],[46000,0.0558]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://www.ksrevenue.gov/', NULL),
  (2026, 'KY', 'Kentucky', 'flat', '{"single":[[0,0.035]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://revenue.ky.gov/', NULL),
  (2026, 'LA', 'Louisiana', 'flat', '{"single":[[0,0.03]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://revenue.louisiana.gov/', 'Flat 3% since 2025.'),
  (2026, 'ME', 'Maine', 'progressive', '{"single":[[0,0.058],[27400,0.0675],[64850,0.0715],[1000000,0.0915]],"mfj":[[0,0.058],[54850,0.0675],[129750,0.0715],[1500000,0.0915]],"mfs":[[0,0.058],[27400,0.0675],[64850,0.0715],[750000,0.0915]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.maine.gov/revenue/sites/maine.gov.revenue/files/2026-05/ind_tax_rate_sched_2026_rev.pdf', 'Includes the new 2% surcharge above $1M single/HoH, $1.5M MFJ, $750k MFS (retroactive to 1/1/2026); surcharge base approximated as taxable income. HoH regular brackets fall back to single.'),
  (2026, 'MD', 'Maryland', 'progressive', '{"single":[[0,0.02],[1000,0.03],[2000,0.04],[3000,0.0475],[100000,0.05],[125000,0.0525],[150000,0.055],[250000,0.0575],[500000,0.0625],[1000000,0.065]],"mfj":[[0,0.02],[1000,0.03],[2000,0.04],[3000,0.0475],[150000,0.05],[175000,0.0525],[225000,0.055],[300000,0.0575],[600000,0.0625],[1200000,0.065]],"hoh":[[0,0.02],[1000,0.03],[2000,0.04],[3000,0.0475],[150000,0.05],[175000,0.0525],[225000,0.055],[300000,0.0575],[600000,0.0625],[1200000,0.065]]}'::jsonb, '{"single":[[0,0.02],[1000,0.03],[2000,0.04],[3000,0.0475],[100000,0.05],[125000,0.0525],[150000,0.055],[250000,0.0575],[350000,0.0775],[500000,0.0825],[1000000,0.085]],"mfj":[[0,0.02],[1000,0.03],[2000,0.04],[3000,0.0475],[150000,0.05],[175000,0.0525],[225000,0.055],[300000,0.0575],[350000,0.0775],[600000,0.0825],[1200000,0.085]],"hoh":[[0,0.02],[1000,0.03],[2000,0.04],[3000,0.0475],[150000,0.05],[175000,0.0525],[225000,0.055],[300000,0.0575],[350000,0.0775],[600000,0.0825],[1200000,0.085]]}'::jsonb, 'income', 0, '{"single":[[0,0.02],[1000,0.03],[2000,0.04],[3000,0.0475],[100000,0.05],[125000,0.0525],[150000,0.055],[250000,0.0575],[350000,0.0775],[500000,0.0825],[1000000,0.085]],"mfj":[[0,0.02],[1000,0.03],[2000,0.04],[3000,0.0475],[150000,0.05],[175000,0.0525],[225000,0.055],[300000,0.0575],[350000,0.0775],[600000,0.0825],[1200000,0.085]],"hoh":[[0,0.02],[1000,0.03],[2000,0.04],[3000,0.0475],[150000,0.05],[175000,0.0525],[225000,0.055],[300000,0.0575],[350000,0.0775],[600000,0.0825],[1200000,0.085]]}'::jsonb, 'high', 'https://www.marylandcomptroller.gov/', 'County/local tax of 2.25–3.3% is extra (not modeled). Extra 2% on net capital gains when federal AGI exceeds $350,000 (from 2025).'),
  (2026, 'MA', 'Massachusetts', 'flat', '{"single":[[0,0.05],[1107750,0.09]]}'::jsonb, NULL, 'income', 0, '{"single":[[0,0.085],[1107750,0.125]]}'::jsonb, 'medium', 'https://www.mass.gov/info-details/learn-about-the-4-surtax-on-taxable-income-over-1-million', '5% plus 4% surtax above $1,107,750 (per return; not doubled for MFJ). Short-term gains taxed at 8.5% (+ surtax).'),
  (2026, 'MI', 'Michigan', 'flat', '{"single":[[0,0.0425]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.michigan.gov/treasury/news/2026/04/15/state-individual-income-tax-rate-for-2026-tax-year-determined', 'City income taxes extra (not modeled).'),
  (2026, 'MN', 'Minnesota', 'progressive', '{"single":[[0,0.0535],[33310,0.068],[109430,0.0785],[203150,0.0985]],"mfj":[[0,0.0535],[48700,0.068],[193480,0.0785],[337930,0.0985]],"mfs":[[0,0.0535],[24350,0.068],[96740,0.0785],[168965,0.0985]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.revenue.state.mn.us/press-release/2025-12-16/minnesota-income-tax-brackets-standard-deduction-and-dependent-exemption', 'Additional 1% net investment income tax on NII above $1M not modeled. HoH separate schedule not loaded (falls back to single).'),
  (2026, 'MS', 'Mississippi', 'flat', '{"single":[[0,0],[10000,0.04]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://www.dor.ms.gov/', '4.0% for 2026 with first $10,000 exempt (treated as per return).'),
  (2026, 'MO', 'Missouri', 'progressive', '{"single":[[0,0],[1207,0.02],[2414,0.025],[3621,0.03],[4828,0.035],[6035,0.04],[7242,0.045],[8449,0.047]]}'::jsonb, NULL, 'income', 1, '{"single":[[0,0]]}'::jsonb, 'medium', 'https://dor.mo.gov/', 'Same schedule for all statuses. From TY2025, 100% of federal capital gains (short- and long-term) are deductible (HB 594).'),
  (2026, 'MT', 'Montana', 'progressive', '{"single":[[0,0.047],[47500,0.0565]],"mfj":[[0,0.047],[95000,0.0565]],"hoh":[[0,0.047],[71250,0.0565]]}'::jsonb, '{"single":[[0,0.03],[47500,0.041]],"mfj":[[0,0.03],[95000,0.041]],"hoh":[[0,0.03],[71250,0.041]]}'::jsonb, 'income', 0, NULL, 'high', 'https://revenue.mt.gov/news/recent-news/HB-337', 'HB 337 2026 brackets. Separate LTCG rates 3.0% / 4.1%.'),
  (2026, 'NE', 'Nebraska', 'progressive', '{"single":[[0,0.0246],[4130,0.0351],[24760,0.0455]],"mfj":[[0,0.0246],[8250,0.0351],[49530,0.0455]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://revenue.nebraska.gov/sites/default/files/doc/tax-forms/drafts/2026_tax_calculation_schedule.pdf', 'Top rate 4.55% for 2026 (draft DOR schedule). HoH separate schedule not loaded.'),
  (2026, 'NV', 'Nevada', 'none', '{"single":[[0,0]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/', NULL),
  (2026, 'NH', 'New Hampshire', 'none', '{"single":[[0,0]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/', 'Interest & dividends tax repealed for tax periods after 12/31/2024.'),
  (2026, 'NJ', 'New Jersey', 'progressive', '{"single":[[0,0.014],[20000,0.0175],[35000,0.035],[40000,0.05525],[75000,0.0637],[500000,0.0897],[1000000,0.1075]],"mfj":[[0,0.014],[20000,0.0175],[50000,0.0245],[70000,0.035],[80000,0.05525],[150000,0.0637],[500000,0.0897],[1000000,0.1075]],"mfs":[[0,0.014],[20000,0.0175],[35000,0.035],[40000,0.05525],[75000,0.0637],[500000,0.0897],[1000000,0.1075]],"hoh":[[0,0.014],[20000,0.0175],[50000,0.0245],[70000,0.035],[80000,0.05525],[150000,0.0637],[500000,0.0897],[1000000,0.1075]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.nj.gov/treasury/taxation/', NULL),
  (2026, 'NM', 'New Mexico', 'progressive', '{"single":[[0,0.015],[5500,0.032],[16500,0.043],[33500,0.047],[66500,0.049],[210000,0.059]],"mfj":[[0,0.015],[8000,0.032],[25000,0.043],[50000,0.047],[100000,0.049],[315000,0.059]],"mfs":[[0,0.015],[4000.0,0.032],[12500.0,0.043],[25000.0,0.047],[50000.0,0.049],[157500.0,0.059]],"hoh":[[0,0.015],[8000,0.032],[25000,0.043],[50000,0.047],[100000,0.049],[315000,0.059]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://www.tax.newmexico.gov/', 'Capital gains deduction capped at $2,500 from TY2025 (not modeled — negligible at LEAPS scale).'),
  (2026, 'NY', 'New York', 'progressive', '{"single":[[0,0.039],[8500,0.044],[11700,0.0515],[13900,0.054],[80650,0.059],[215400,0.0685],[1077550,0.0965],[5000000,0.103],[25000000,0.109]],"mfj":[[0,0.039],[17150,0.044],[23600,0.0515],[27900,0.054],[161550,0.059],[323200,0.0685],[2155350,0.0965],[5000000,0.103],[25000000,0.109]],"hoh":[[0,0.039],[12800,0.044],[17650,0.0515],[20900,0.054],[107650,0.059],[269300,0.0685],[1616450,0.0965],[5000000,0.103],[25000000,0.109]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.tax.ny.gov/', '2026 rate cuts on the five lowest brackets. Supplemental tax recapture and NYC tax (3.078–3.876%) not modeled.'),
  (2026, 'NC', 'North Carolina', 'flat', '{"single":[[0,0.0399]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.ncdor.gov/', NULL),
  (2026, 'ND', 'North Dakota', 'progressive', '{"single":[[0,0],[48475,0.0195],[244825,0.025]],"mfj":[[0,0],[80975,0.0195],[298075,0.025]]}'::jsonb, NULL, 'income', 0.4, NULL, 'medium', 'https://www.tax.nd.gov/', 'Likely 2025 indexed thresholds; 2026 not confirmed. 40% LTCG exclusion. HoH separate schedule not loaded.'),
  (2026, 'OH', 'Ohio', 'flat', '{"single":[[0,0],[26050,0.0275]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxnews.ey.com/news/2025-1441', 'Flat 2.75% above $26,050 from 2026 (HB 96); threshold not doubled for MFJ. Municipal taxes extra.'),
  (2026, 'OK', 'Oklahoma', 'progressive', '{"single":[[0,0],[3750,0.025],[4900,0.035],[7200,0.045]],"mfj":[[0,0],[7500,0.025],[9800,0.035],[14400,0.045]],"hoh":[[0,0],[7500,0.025],[9800,0.035],[14400,0.045]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://oklahoma.gov/tax.html', 'HB 2764: top rate 4.5% from 2026.'),
  (2026, 'OR', 'Oregon', 'progressive', '{"single":[[0,0.0475],[4550,0.0675],[11400,0.0875],[125000,0.099]],"mfj":[[0,0.0475],[9100,0.0675],[22800,0.0875],[250000,0.099]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://www.oregon.gov/dor/', '2026 values from the withholding formula; HoH believed to use the joint chart (not loaded — falls back to single).'),
  (2026, 'PA', 'Pennsylvania', 'flat', '{"single":[[0,0.0307]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.revenue.pa.gov/', 'Local earned-income taxes extra.'),
  (2026, 'RI', 'Rhode Island', 'progressive', '{"single":[[0,0.0375],[82050,0.0475],[186450,0.0599]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://tax.ri.gov/', 'One schedule for all statuses (ADV 2026-02).'),
  (2026, 'SC', 'South Carolina', 'progressive', '{"single":[[0,0.0199],[30000,0.0521]]}'::jsonb, NULL, 'income', 0.44, NULL, 'medium', 'https://www.dor.sc.gov/news/information-about-h-4216', 'Act 110 / H.4216 (retroactive to 1/1/2026): 1.99% under $30k, 5.21% above. 44% LTCG deduction.'),
  (2026, 'SD', 'South Dakota', 'none', '{"single":[[0,0]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/', NULL),
  (2026, 'TN', 'Tennessee', 'none', '{"single":[[0,0]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/', NULL),
  (2026, 'TX', 'Texas', 'none', '{"single":[[0,0]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/', NULL),
  (2026, 'UT', 'Utah', 'flat', '{"single":[[0,0.0445]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxnews.ey.com/news/2026-0913-utah-law-lowers-state-income-tax-rate-retroactive-to-january-1-2026', 'SB 60 (2026) 4.45%, retroactive.'),
  (2026, 'VT', 'Vermont', 'progressive', '{"single":[[0,0.0335],[49400,0.066],[119700,0.076],[249700,0.0875]],"mfj":[[0,0.0335],[82500,0.066],[199450,0.076],[304000,0.0875]]}'::jsonb, NULL, 'income', 0, NULL, 'low', 'https://tax.vermont.gov/', '2025 indexed thresholds; 2026 not confirmed. Capital gains exclusion (greater of $5,000 or 40% for 3+ yr holdings) not modeled. HoH separate schedule not loaded.'),
  (2026, 'VA', 'Virginia', 'progressive', '{"single":[[0,0.02],[3000,0.03],[5000,0.05],[17000,0.0575]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://www.tax.virginia.gov/', 'Same schedule for all statuses.'),
  (2026, 'WA', 'Washington', 'none', '{"single":[[0,0]]}'::jsonb, '{"single":[[0,0],[278000,0.07],[1278000,0.099]]}'::jsonb, 'gain', 0, NULL, 'medium', 'https://dor.wa.gov/taxes-rates/other-taxes/capital-gains-tax', 'No wage income tax. Separate LTCG excise tax: 7% on gains above the standard deduction, 9.9% on taxable gains above $1M (SB 5813). 2026 deduction not yet published — 2025 figure $278,000 used. Deduction is per individual or married couple combined. SB 6346 income tax starts 2028 (no 2026 impact).'),
  (2026, 'WV', 'West Virginia', 'progressive', '{"single":[[0,0.0211],[10000,0.0281],[25000,0.0316],[40000,0.0422],[60000,0.0458]],"mfs":[[0,0.0211],[5000.0,0.0281],[12500.0,0.0316],[20000.0,0.0422],[30000.0,0.0458]]}'::jsonb, NULL, 'income', 0, NULL, 'medium', 'https://tax.wv.gov/', 'SB 392 (2026) cuts each rate 5%, retroactive. Middle three rates are rounded from the 5% cut — verify against the WV schedule.'),
  (2026, 'WI', 'Wisconsin', 'progressive', '{"single":[[0,0.035],[14680,0.044],[50480,0.053],[323290,0.0765]],"mfj":[[0,0.035],[19580,0.044],[67300,0.053],[431060,0.0765]],"mfs":[[0,0.035],[9790.0,0.044],[33650.0,0.053],[215530.0,0.0765]]}'::jsonb, NULL, 'income', 0.3, NULL, 'medium', 'https://www.revenue.wi.gov/', '2025 Act 15 thresholds; 2026 indexed values not found. 30% LTCG exclusion.'),
  (2026, 'WY', 'Wyoming', 'none', '{"single":[[0,0]]}'::jsonb, NULL, 'income', 0, NULL, 'high', 'https://taxfoundation.org/data/all/state/state-income-tax-rates-2026/', NULL)
ON CONFLICT (tax_year, state_code) DO NOTHING;
