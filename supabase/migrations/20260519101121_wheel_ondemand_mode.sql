-- On-demand single-ticker wheel analysis: widen scan_kind, add
-- requester attribution + a rate-limit index. Additive + idempotent.

ALTER TABLE public.wheel_suggestions
  DROP CONSTRAINT IF EXISTS wheel_suggestions_scan_kind_check;

ALTER TABLE public.wheel_suggestions
  ADD CONSTRAINT wheel_suggestions_scan_kind_check
  CHECK (scan_kind = ANY (ARRAY['rth'::text, 'eod'::text, 'manual'::text, 'ondemand'::text]));

ALTER TABLE public.wheel_suggestions
  ADD COLUMN IF NOT EXISTS requested_by uuid;

COMMENT ON COLUMN public.wheel_suggestions.requested_by IS
  'Auth user id for scan_kind=ondemand single-ticker analyses (NULL for batch scans). Attribution + per-user rate limit only; RLS unchanged (authenticated SELECT, service-role write).';

CREATE INDEX IF NOT EXISTS wheel_suggestions_ondemand_user_idx
  ON public.wheel_suggestions (requested_by, computed_at DESC)
  WHERE scan_kind = 'ondemand';
