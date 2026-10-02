-- Per-position Exit Targets the user sets by hand, as either a % gain on
-- basis or a dollar value for the whole position:
--
--   exit_targets = [
--     { "kind": "pct", "value": 1.0,   "sell": 0.5 },   -- sell half when up 100%
--     { "kind": "usd", "value": 60000, "sell": 0.5 }    -- sell half at $60,000
--   ]
--
-- "sell" is the share of the position sold at that target (0–1; the
-- shares may add up to less than 1 — the rest is held). The app shows
-- the tax and after-tax dollars at each target (src/utils/afterTax.js
-- customExitTargets). NULL = use the account's after-tax Exit Target
-- ladder from Settings. Additive only; RLS on leaps_positions is
-- unchanged (users write their own rows).

ALTER TABLE public.leaps_positions
  ADD COLUMN IF NOT EXISTS exit_targets jsonb;

ALTER TABLE public.leaps_positions
  DROP CONSTRAINT IF EXISTS leaps_positions_exit_targets_chk;
ALTER TABLE public.leaps_positions
  ADD CONSTRAINT leaps_positions_exit_targets_chk CHECK (
    exit_targets IS NULL
    OR (jsonb_typeof(exit_targets) = 'array' AND jsonb_array_length(exit_targets) BETWEEN 1 AND 5)
  );

COMMENT ON COLUMN public.leaps_positions.exit_targets IS
  'User-set Exit Targets: [{kind: pct|usd, value, sell}] — pct = gain on basis (1.0 = +100%), usd = whole-position value; sell = share sold (0-1). NULL = account ladder.';
