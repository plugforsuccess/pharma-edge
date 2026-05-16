-- Surface the scanner's reasoning into the user-facing drift trail.
--
-- scan-universe-plays runs Claude over watchlist ∪ holdings every 30
-- min and writes top_plays_feed, but it is system-level (user_id NULL)
-- so it deliberately does NOT write reasoning_history (that table is
-- user_id NOT NULL). Result: for the names you actually hold, a
-- regular, decision-relevant regime/confidence read was generated
-- every 30 min and discarded from the Reasoning History panel — the
-- one place you'd look to answer "how did the engine's read drift
-- while I held this?" (the AMD post-mortem question).
--
-- The data is NOT lost: claude_calls captures every scanner call's
-- matrix_at_call + prompt_output at full fidelity. This is purely a
-- read-side projection — no schema/RLS change to immutable surfaces,
-- no new writes. The view is restricted to scanner rows only and
-- exposes only normalized GEX/regime fields (market reasoning about
-- public tickers — same data class as gex_history), never raw
-- prompt_input/output.
--
-- security_invoker=true: claude_calls RLS still governs row
-- visibility. Scanner rows have user_id NULL, so they surface via the
-- admin-SELECT policy — i.e. visible to the operator (is_admin), not
-- to arbitrary users. This is the single-operator behavior that was
-- explicitly confirmed before building.

-- Robust text→jsonb: Claude's response is a ```json-fenced blob; a
-- pathological row must yield NULL, never error a view powering a UI.
CREATE OR REPLACE FUNCTION public.safe_jsonb(t text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.safe_jsonb(text) TO authenticated;

CREATE OR REPLACE VIEW public.scanner_reasoning
WITH (security_invoker = true) AS
SELECT
  s.id,
  s.computed_at,
  s.ticker,
  s.spot,
  s.net_gex,
  s.expected_move,
  s.pinning_probability,
  s.call_wall,
  s.flip_strike,
  -- Mirror deriveRegime() in Reasoning.jsx EXACTLY so the merged
  -- trail is internally consistent with the live banner:
  --   aboveFlip   = flip IS NULL OR spot >= flip
  --   positiveGex = net_gex >= 0
  --   A if aboveFlip AND positiveGex
  --   B if (NOT aboveFlip) AND (NOT positiveGex)
  --   else mixed
  CASE
    WHEN s.spot IS NULL OR s.net_gex IS NULL THEN 'mixed'
    WHEN (s.flip_strike IS NULL OR s.spot >= s.flip_strike) AND s.net_gex >= 0 THEN 'A'
    WHEN (s.flip_strike IS NOT NULL AND s.spot < s.flip_strike) AND s.net_gex < 0 THEN 'B'
    ELSE 'mixed'
  END AS regime,
  s.parsed->>'regime_explanation' AS regime_explanation,
  -- Proposed-play count (Claude's raw output, pre server R/R+EV
  -- filter). Labeled distinctly in the UI so it is not conflated
  -- with reasoning_history.play_count (post-filter / verified).
  jsonb_array_length(COALESCE(s.parsed->'plays', '[]'::jsonb)) AS play_count,
  -- confidence is aggregateConfidence(plays) in JS; not replicated in
  -- SQL — faking it would diverge from the canonical definition.
  NULL::numeric AS confidence,
  'scan'::text AS source
FROM (
  SELECT
    cc.id,
    cc.called_at AS computed_at,
    cc.ticker,
    NULLIF(cc.matrix_at_call->>'spot', '')::numeric                AS spot,
    NULLIF(cc.matrix_at_call->>'net_gex', '')::numeric             AS net_gex,
    NULLIF(cc.matrix_at_call->>'expected_move', '')::numeric       AS expected_move,
    NULLIF(cc.matrix_at_call->>'pinning_probability', '')::numeric AS pinning_probability,
    NULLIF(cc.matrix_at_call->'largest'->>'strike', '')::numeric   AS call_wall,
    NULLIF(cc.matrix_at_call->>'zero_gamma_strike', '')::numeric   AS flip_strike,
    public.safe_jsonb(
      substring(cc.prompt_output->'content'->0->>'text' FROM '\{[\s\S]*\}')
    ) AS parsed
  FROM public.claude_calls cc
  WHERE cc.function_name = 'scan-universe-plays'
    AND cc.error IS NULL
    AND cc.called_at > now() - interval '7 days'
) s;

GRANT SELECT ON public.scanner_reasoning TO authenticated;

COMMENT ON VIEW public.scanner_reasoning IS
  'Read-side projection of scan-universe-plays claude_calls into the '
  'reasoning-history shape (regime derived deterministically from '
  'matrix_at_call, regime_explanation + proposed play_count parsed '
  'from prompt_output). Scanner rows only; no raw prompt exposed. '
  'security_invoker=true → visible via claude_calls admin-SELECT '
  '(operator), consistent with single-operator design.';
