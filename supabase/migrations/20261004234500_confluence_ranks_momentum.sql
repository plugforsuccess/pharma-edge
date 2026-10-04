-- Momentum beside the verdict (owner, 2026-10-04: a buy zone YES next to a
-- Bravo bear read as a contradiction): 'up' when Bravo's regime is bull
-- (close and fast EMA above the basis) at the close, 'down' otherwise.
-- ENTER + down = an early entry; ENTER + up = confirmed.
ALTER TABLE public.confluence_ranks ADD COLUMN IF NOT EXISTS momentum text CHECK (momentum IS NULL OR momentum IN ('up', 'down'));
NOTIFY pgrst, 'reload schema';
