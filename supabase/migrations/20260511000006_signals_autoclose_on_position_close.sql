-- When a position fully closes (contracts_remaining → 0, status →
-- 'closed' via the open_positions_close_on_zero_remaining trigger),
-- mirror the close onto the linked signals row. Without this, signals
-- stay 'active' forever after a close — they only flip when the user
-- manually logs an outcome via LogOutcomeModal, and most never do.
--
-- The user's outcome capture (thesis_correct, P&L, notes) is still
-- the canonical exit-record contract. This trigger does NOT skip that
-- step — it just transitions signals.status so dashboards and
-- calendars stop showing the signal as live, AND surfaces the closed
-- signal in a new "outcome inbox" on the Tape so the user is
-- prompted to log the outcome on their next visit.
--
-- signals.status is NOT in the immutability gate
-- (enforce_signal_immutability_fn) — protected fields are thesis,
-- direction, catalyst_date, logged_at, signal_hash, user_id,
-- entry_pop_bp, hash_version. status was always intended as a
-- lifecycle column.

CREATE OR REPLACE FUNCTION public.signals_autoclose_on_position_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status = 'open' AND NEW.signal_id IS NOT NULL THEN
    UPDATE public.signals
    SET status = 'closed'
    WHERE id = NEW.signal_id
      AND status = 'active';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS signals_autoclose_on_position_close
  ON public.open_positions;
CREATE TRIGGER signals_autoclose_on_position_close
  AFTER UPDATE OF status ON public.open_positions
  FOR EACH ROW
  WHEN (NEW.status = 'closed' AND OLD.status <> 'closed')
  EXECUTE FUNCTION public.signals_autoclose_on_position_close();

-- Backfill: any signals whose linked position is already closed but
-- signal is still 'active'. Catches the historical case where the
-- position-close trigger fired before this cascade existed.
UPDATE public.signals s
SET status = 'closed'
WHERE s.status = 'active'
  AND EXISTS (
    SELECT 1 FROM public.open_positions p
    WHERE p.signal_id = s.id
      AND p.status = 'closed'
  );
