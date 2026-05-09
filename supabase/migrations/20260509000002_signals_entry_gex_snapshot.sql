-- Capture the GEX matrix headline fields at signal-lock time so the
-- position page can render an "entry vs now" diff. The full per-cell
-- matrix is too large to persist per signal — we store the headline
-- fields the UI actually surfaces (spot, regime, walls, flip, expected
-- move). LogSignal calls compute-gex one extra time at submit and
-- writes the trimmed payload here.
--
-- NOT included in the signal_hash payload — this is informational
-- "show your work" metadata, not part of the immutability proof.
-- Anyone backdating a snapshot via direct SQL would still be caught
-- by the hashed thesis/direction/catalyst_date fields. Keeping the
-- snapshot out of the hash means we don't have to touch
-- compute_signal_hash or generateSignalHash, which CLAUDE.md
-- explicitly forbids without explicit instruction.
--
-- Nullable + DEFAULT NULL — every legacy row stays unaffected; new
-- rows logged from a client that doesn't send the field also stay
-- null without erroring (e.g., a stale PWA bundle).

ALTER TABLE public.signals
    ADD COLUMN IF NOT EXISTS entry_gex_snapshot JSONB;

COMMENT ON COLUMN public.signals.entry_gex_snapshot IS
'Trimmed compute-gex response captured at LogSignal lock time. Not in signal_hash. Headline fields: spot, regime, net_gex, flip_strike, call_wall, put_wall, expected_move, captured_at, source.';
