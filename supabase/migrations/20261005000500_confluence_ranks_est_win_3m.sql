-- Sell-side track record line needs the 3-month win rate next to the 3-month average.
ALTER TABLE public.confluence_ranks ADD COLUMN IF NOT EXISTS est_win_3m numeric;
NOTIFY pgrst, 'reload schema';
