-- Atomic profile-view-counter bump. Called by profile-view-track
-- after a successful (non-deduped) insert into profile_views. Single
-- statement so concurrent calls don't race; the row-level lock from
-- UPDATE handles serialization.

CREATE OR REPLACE FUNCTION public.bump_profile_view_count(
  p_profile_user_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.profiles
  SET
    profile_view_count = profile_view_count + 1,
    profile_view_count_updated_at = NOW()
  WHERE id = p_profile_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_profile_view_count(UUID) FROM public;
GRANT EXECUTE ON FUNCTION public.bump_profile_view_count(UUID) TO service_role;
