-- Per-holding after-tax return goal (owner, 2026-10-02).
--
-- leaps_positions.goal_pct: the after-tax return this holding is aiming
-- for, as a fraction of its cost (0.5 = +50% after tax). Set in the
-- holding editor; NULL = use the account default
-- (leaps_tax_profiles.selected_target_pct, Settings → Goals). The card's
-- goal bar solves it on the holding's own cost.
--
-- Additive; RLS on leaps_positions is unchanged (users write their own rows).

ALTER TABLE public.leaps_positions
  ADD COLUMN IF NOT EXISTS goal_pct numeric
    CHECK (goal_pct IS NULL OR (goal_pct > 0 AND goal_pct <= 10));

COMMENT ON COLUMN public.leaps_positions.goal_pct IS
  'After-tax return goal for this holding (fraction of cost, 0.5 = +50%). NULL = account default (leaps_tax_profiles.selected_target_pct).';
