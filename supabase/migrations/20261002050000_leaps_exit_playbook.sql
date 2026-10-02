-- LEAPS exit playbook (owner, 2026-10-02).
--
-- ldp_risk_profiles.exit_ladder now holds PRE-TAX gain targets on the
-- option (1.0 = +100%) — taxes come after the plan — and rung_fractions
-- the share of the ORIGINAL position sold at each target. The shares may
-- total less than 1: the rest is the runner, which exits on a
-- runner_trail_pct give-back from its peak. Defaults: +100% → sell 70%,
-- +200% → sell 15%, runner 15% trailing 30%.
--
-- Rows still on the old after-tax default ({1,2,3}, equal thirds) move
-- to the playbook. Rows a user customised are left as they are (their
-- targets are now read as pre-tax).
--
-- leaps_positions.peak_unit_value: highest value per contract (or per
-- share) recorded for the position — the runner's trail is measured
-- from it. Maintained by the app on every value update.
--
-- Additive; RLS unchanged (ldp_risk_profiles stays service-role write).

ALTER TABLE public.ldp_risk_profiles
  ADD COLUMN IF NOT EXISTS runner_trail_pct numeric NOT NULL DEFAULT 0.30
    CHECK (runner_trail_pct > 0 AND runner_trail_pct < 1);

ALTER TABLE public.ldp_risk_profiles ALTER COLUMN exit_ladder SET DEFAULT '{1.0,2.0}';
ALTER TABLE public.ldp_risk_profiles ALTER COLUMN rung_fractions SET DEFAULT '{0.70,0.15}';

UPDATE public.ldp_risk_profiles
   SET exit_ladder = '{1.0,2.0}', rung_fractions = '{0.70,0.15}'
 WHERE exit_ladder = '{1,2,3}'::numeric[] AND rung_fractions IS NULL;

COMMENT ON COLUMN public.ldp_risk_profiles.exit_ladder IS
  'Exit playbook targets: pre-tax gain on the option as a multiple of basis (1.0 = +100%), ascending.';
COMMENT ON COLUMN public.ldp_risk_profiles.rung_fractions IS
  'Share of the ORIGINAL position sold at each target (total ≤ 1; the rest is the runner). NULL = equal split, no runner.';
COMMENT ON COLUMN public.ldp_risk_profiles.runner_trail_pct IS
  'Runner exits when its value falls this fraction below its peak (playbook default 0.30).';

ALTER TABLE public.leaps_positions
  ADD COLUMN IF NOT EXISTS peak_unit_value numeric CHECK (peak_unit_value IS NULL OR peak_unit_value >= 0);

COMMENT ON COLUMN public.leaps_positions.peak_unit_value IS
  'Highest recorded value per contract (options) or per share (stock); the runner trail is measured from it.';

-- Seed the peak from the current value for open positions.
UPDATE public.leaps_positions
   SET peak_unit_value = current_value / CASE
         WHEN instrument_type = 'stock' THEN NULLIF(shares, 0)
         ELSE NULLIF(contracts, 0) END
 WHERE peak_unit_value IS NULL AND closed_at IS NULL;
