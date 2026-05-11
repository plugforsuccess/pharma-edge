-- Phase 1.5 of automated trade management: support partial closes
-- (scale-out 50% at +100%, scale-out 75% of remainder at +200%).
--
-- `contracts` becomes the immutable original size at entry — matches
-- the immutability principle the rest of the schema follows. The new
-- `contracts_remaining` is the live count; close-order decrements it
-- on each fill and flips status='closed' when it hits 0.

ALTER TABLE public.open_positions
  ADD COLUMN IF NOT EXISTS contracts_remaining int;

-- Backfill: for every existing row, assume nothing has been closed
-- yet → remaining = original. For closed positions where contracts
-- have been wound down, this is still safe — they're already
-- status='closed' so contracts_remaining won't be read for trigger
-- evaluation.
UPDATE public.open_positions
SET contracts_remaining = contracts
WHERE contracts_remaining IS NULL;

ALTER TABLE public.open_positions
  ALTER COLUMN contracts_remaining SET NOT NULL,
  ALTER COLUMN contracts_remaining SET DEFAULT 1,
  ADD CONSTRAINT open_positions_contracts_remaining_nonneg
    CHECK (contracts_remaining >= 0);

-- Helper: trip status='closed' automatically when contracts_remaining
-- hits 0 after a close fill. Avoids a "did we forget to flip status"
-- bug in the close-order edge function — the DB enforces it.
CREATE OR REPLACE FUNCTION public.open_positions_close_on_zero_remaining()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.contracts_remaining = 0 AND OLD.status = 'open' THEN
    NEW.status = 'closed';
    IF NEW.closed_at IS NULL THEN
      NEW.closed_at = now();
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS open_positions_close_on_zero_remaining
  ON public.open_positions;
CREATE TRIGGER open_positions_close_on_zero_remaining
  BEFORE UPDATE OF contracts_remaining ON public.open_positions
  FOR EACH ROW EXECUTE FUNCTION public.open_positions_close_on_zero_remaining();
