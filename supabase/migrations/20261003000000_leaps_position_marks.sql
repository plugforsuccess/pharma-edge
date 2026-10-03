-- Price history for holdings (Charts, 2026-10-03).
--
-- leaps_position_marks keeps one value per holding per day, so /charts
-- can draw value over time from the prices users enter by hand (and,
-- later, from Tradier quotes). Rows are written only by the trigger on
-- leaps_positions: every insert, and every update that changes the
-- value or its date, upserts that day's mark. Users read their own rows.

CREATE TABLE IF NOT EXISTS public.leaps_position_marks (
  position_id  uuid    NOT NULL REFERENCES public.leaps_positions(id) ON DELETE CASCADE,
  user_id      uuid    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  as_of        date    NOT NULL,
  value        numeric NOT NULL CHECK (value >= 0),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (position_id, as_of)
);

CREATE INDEX IF NOT EXISTS leaps_position_marks_user_idx
  ON public.leaps_position_marks (user_id, as_of);

ALTER TABLE public.leaps_position_marks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leaps_position_marks_select_own ON public.leaps_position_marks;
CREATE POLICY leaps_position_marks_select_own ON public.leaps_position_marks
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);

-- Writes come from the trigger only (no INSERT / UPDATE / DELETE policy).
-- SECURITY DEFINER so the trigger can write past RLS; it only ever writes
-- the row's own user_id, taken from the leaps_positions row being saved.
CREATE OR REPLACE FUNCTION public.leaps_position_marks_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.leaps_position_marks (position_id, user_id, as_of, value)
  VALUES (NEW.id, NEW.user_id, (NEW.value_as_of AT TIME ZONE 'America/New_York')::date, NEW.current_value)
  ON CONFLICT (position_id, as_of)
  DO UPDATE SET value = EXCLUDED.value, recorded_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.leaps_position_marks_record() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS leaps_positions_record_mark ON public.leaps_positions;
CREATE TRIGGER leaps_positions_record_mark
  AFTER INSERT OR UPDATE OF current_value, value_as_of ON public.leaps_positions
  FOR EACH ROW EXECUTE FUNCTION public.leaps_position_marks_record();

-- Start every existing holding's history at its last entered price.
INSERT INTO public.leaps_position_marks (position_id, user_id, as_of, value)
SELECT id, user_id, (value_as_of AT TIME ZONE 'America/New_York')::date, current_value
FROM public.leaps_positions
ON CONFLICT (position_id, as_of) DO NOTHING;

COMMENT ON TABLE public.leaps_position_marks IS
  'One value per holding per day, written by the leaps_positions trigger. Feeds /charts.';
