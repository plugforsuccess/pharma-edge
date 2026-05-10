-- Phase 3a — structured thesis schema. Replaces the heuristic
-- guesses in computeThesisVerdict (PRs #112 + #113) with explicit
-- declarations of what each trade is structurally trying to do.
--
-- Captured at LogSignal lock time from Suggested Plays' new emission
-- fields, OR from a manual entry in the Log flow. Verdict logic
-- prefers these fields over heuristics; legacy v1/v2 rows fall
-- through to the heuristic path unchanged.
--
-- NOT in the signal_hash payload (Phase 3a). Including them in the
-- hash is Phase 3b — separate migration when we want immutable
-- thesis declarations on the public record.
--
-- Field semantics:
--
-- target_king_node — what the trade is anchored to:
--   'call_wall'  the dominant positive-GEX cluster (resistance up)
--   'put_wall'   the dominant negative-GEX cluster (support down)
--   'flip'       the zero-gamma line (regime boundary)
--
-- target_strike — the strike price the king node sits at
--   For pin trades: the strike spot is expected to pin to
--   For break trades: the strike spot is expected to push through
--
-- target_expiration — the king node's expiration (the wall's, not
--   the trade's). Often DIFFERENT from the spread expiration.
--   Example: bull call expiring 5/12 anchored to a $725 wall that
--   peaks at 5/12; or anchored to a $710 wall expiring 5/8 that
--   the trade EXPECTS to roll off.
--
-- target_thesis_kind — what spot needs to do for the trade to win:
--   'pin_to'        wall holds, spot stays at/near the strike
--   'break_through' wall fails as resistance/support, spot crosses it
--   'fade'          spot returns from extreme back to the wall (mean revert)
--
-- regime_at_entry — A/B/mixed regime classification at lock time.
--   Lets the verdict know what regime the user committed to without
--   reconstructing it from the entry_gex_snapshot.

ALTER TABLE public.signals
    ADD COLUMN IF NOT EXISTS target_king_node TEXT
        CHECK (target_king_node IS NULL OR target_king_node IN ('call_wall', 'put_wall', 'flip')),
    ADD COLUMN IF NOT EXISTS target_strike NUMERIC,
    ADD COLUMN IF NOT EXISTS target_expiration DATE,
    ADD COLUMN IF NOT EXISTS target_thesis_kind TEXT
        CHECK (target_thesis_kind IS NULL OR target_thesis_kind IN ('pin_to', 'break_through', 'fade')),
    ADD COLUMN IF NOT EXISTS regime_at_entry TEXT
        CHECK (regime_at_entry IS NULL OR regime_at_entry IN ('A', 'B', 'mixed'));

COMMENT ON COLUMN public.signals.target_king_node IS
'Phase 3a: which type of king node the trade is anchored to (call_wall / put_wall / flip). NULL for legacy v1/v2 rows; verdict logic falls back to heuristics for those.';

COMMENT ON COLUMN public.signals.target_thesis_kind IS
'Phase 3a: what spot needs to do for the trade to win (pin_to / break_through / fade). NULL for legacy rows.';

COMMENT ON COLUMN public.signals.regime_at_entry IS
'Phase 3a: regime classification (A / B / mixed) at lock time. Persisted explicitly so the verdict does not need to reconstruct it from the entry_gex_snapshot net_gex sign.';
