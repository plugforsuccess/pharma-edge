-- Tie close-order rows in order_history to the position they're
-- closing. signal_id stays present for opens (the order that created
-- the position), but a position's lifetime can outlive its signal —
-- and manual positions don't have a signal_id at all. position_id
-- is the canonical key for close-order's idempotency check.

ALTER TABLE public.order_history
  ADD COLUMN IF NOT EXISTS position_id uuid REFERENCES public.open_positions(id);

CREATE INDEX IF NOT EXISTS order_history_position_id_idx
  ON public.order_history (position_id, order_type, status);
