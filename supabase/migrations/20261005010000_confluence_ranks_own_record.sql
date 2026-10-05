-- This ticker's own replay record of the app's rule (owner, 2026-10-05:
-- UNH's card showed the pattern's record across all stocks while the rule
-- on UNH itself had lost 3 of 4). jsonb written nightly by
-- scripts/lib/verdict.mjs ownRecord(): per entry rule (zone, confluence)
-- the trades closed / won / avg / median option return, the open trade,
-- the last trades, and big rallies caught vs missed.
ALTER TABLE public.confluence_ranks ADD COLUMN IF NOT EXISTS own_record jsonb;
NOTIFY pgrst, 'reload schema';
