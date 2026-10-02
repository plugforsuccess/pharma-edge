-- Runner on custom Exit Targets (owner, 2026-10-02).
--
-- leaps_positions.runner_trail_pct: when a holding uses custom
-- exit_targets, whatever those targets don't sell can run as a runner
-- that exits on this give-back from its peak (0.30 = 30%).
-- NULL = no runner; the unsold rest is simply kept. Ignored when
-- exit_targets is NULL (the account playbook has its own runner).
--
-- Additive; RLS on leaps_positions is unchanged (users write their own rows).

ALTER TABLE public.leaps_positions
  ADD COLUMN IF NOT EXISTS runner_trail_pct numeric
    CHECK (runner_trail_pct IS NULL OR (runner_trail_pct > 0 AND runner_trail_pct < 1));

COMMENT ON COLUMN public.leaps_positions.runner_trail_pct IS
  'Custom exit targets: the unsold rest exits on this give-back from its peak (0.30 = 30%). NULL = no runner.';
