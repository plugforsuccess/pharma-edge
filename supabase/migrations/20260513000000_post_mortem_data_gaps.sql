-- Post-mortem data gaps — Gap 1: persist Claude prompt/response payloads
-- alongside the token-ledger row, and FK the resulting signal back to the
-- exact claude_calls row that produced it.
--
-- Why: the first filled-in post-mortem (docs/post-mortems/2026-05-12-
-- QQQ-bear-put-705-700.md) had to reconstruct the Claude conversation
-- from cache rather than load it from the database, because
-- claude_calls only stored token + cost columns. Every future
-- post-mortem needs the actual prompt and response, plus the GEX
-- matrix that was visible to Claude at suggestion time, plus the
-- subset of plays the user picked from. This migration unlocks that.

-- ─── claude_calls: persist prompt + response payloads ───────────────
ALTER TABLE public.claude_calls
  ADD COLUMN IF NOT EXISTS ticker          text,
  ADD COLUMN IF NOT EXISTS prompt_input    jsonb,
  ADD COLUMN IF NOT EXISTS prompt_output   jsonb,
  ADD COLUMN IF NOT EXISTS matrix_at_call  jsonb,
  ADD COLUMN IF NOT EXISTS duration_ms     integer,
  ADD COLUMN IF NOT EXISTS error           text;

COMMENT ON COLUMN public.claude_calls.ticker         IS 'Ticker the call was scoped to, if any (suggest-plays).';
COMMENT ON COLUMN public.claude_calls.prompt_input   IS 'Full request body sent to Anthropic — system + messages + tools.';
COMMENT ON COLUMN public.claude_calls.prompt_output  IS 'Full response from Anthropic — content blocks + stop_reason + usage.';
COMMENT ON COLUMN public.claude_calls.matrix_at_call IS 'GEX matrix that was visible to Claude at the moment of the call. Snapshot, not a reference.';
COMMENT ON COLUMN public.claude_calls.duration_ms    IS 'Wall-clock duration of the Anthropic call in milliseconds.';
COMMENT ON COLUMN public.claude_calls.error          IS 'Error message if the call failed; null on success.';

-- ─── signals: link back to the claude_calls row that produced this trade ─
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS originating_claude_call_id uuid REFERENCES public.claude_calls(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claude_chosen_play         jsonb,
  ADD COLUMN IF NOT EXISTS claude_other_plays         jsonb;

COMMENT ON COLUMN public.signals.originating_claude_call_id IS 'FK to the claude_calls row whose prompt_output produced this signal. NULL for manually-logged signals.';
COMMENT ON COLUMN public.signals.claude_chosen_play         IS 'The exact play object the user picked from the suggested-plays response.';
COMMENT ON COLUMN public.signals.claude_other_plays         IS 'The other plays Claude returned that the user did NOT pick — important counterfactual data for post-mortems.';

CREATE INDEX IF NOT EXISTS idx_signals_originating_claude_call_id
  ON public.signals(originating_claude_call_id)
  WHERE originating_claude_call_id IS NOT NULL;
