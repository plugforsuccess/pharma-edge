-- NOT NOW (owner, 2026-10-05: UNH ranked #1 while the rule's own June
-- entry on UNH sat at −51%): the rule is met today but it is already
-- losing on this ticker — an open entry on the rule below −30%, or the
-- ticker's own record of the rule negative. Shown, never as a buy.
ALTER TABLE public.confluence_ranks DROP CONSTRAINT IF EXISTS confluence_ranks_verdict_check;
ALTER TABLE public.confluence_ranks ADD CONSTRAINT confluence_ranks_verdict_check CHECK (verdict IS NULL OR verdict IN ('enter', 'hold', 'wait', 'watch', 'extended', 'turning'));
ALTER TABLE public.confluence_ranks ADD COLUMN IF NOT EXISTS hold_reason text;
NOTIFY pgrst, 'reload schema';
