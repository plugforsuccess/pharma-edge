-- Leaderboard v1 schema. Implements the TrackRecord + Leaderboard
-- focus-audit spec. Pure additive layer:
--   * extends profiles with reputation + view-count columns
--   * flips is_public default to false (privacy-first for new users;
--     existing rows keep their current setting)
--   * profile_views — per-view audit + dedup ledger
--   * leaderboard_snapshots — daily cached rankings
--   * user_trade_stats — materialized view powering both /record
--     (per-user) and the snapshot job
--
-- No data migration of existing rows. No changes to signals, outcomes,
-- order_history, open_positions, or the verdict pipeline.
--
-- All reads via edge function (service_role). Materialized view is
-- server-only — not granted to anon/authenticated. leaderboard_snapshots
-- is anon-readable (it's the public ranking surface).

-- ─── 1. Extend profiles ────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS exclude_from_leaderboard BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS profile_view_count BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profile_view_count_updated_at TIMESTAMPTZ;

-- Privacy default flip — new profiles default private. Existing rows
-- keep their current is_public value (ALTER ... SET DEFAULT only
-- affects future inserts).
ALTER TABLE public.profiles
  ALTER COLUMN is_public SET DEFAULT false;

-- Slug uniqueness + reserved slugs. The spec calls for blocking common
-- top-level routes from being claimed as profile slugs. Hardcoded list
-- via CHECK constraint — extending later means a new migration, which
-- is the right friction for adding reserved names.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_public_slug_not_reserved
    CHECK (
      public_slug IS NULL OR public_slug NOT IN (
        'admin', 'api', 'app', 'auth', 'leaderboard', 'login', 'logout',
        'me', 'record', 'settings', 'signup', 'support', 'help',
        'u', 'user', 'users', 'profile', 'profiles', 'www', 'about',
        'privacy', 'terms', 'pricing', 'features', 'blog', 'home',
        'index', 'public', 'static', 'assets', 'favicon'
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS profiles_public_slug_unique
  ON public.profiles (public_slug)
  WHERE public_slug IS NOT NULL;

-- ─── 2. profile_views ──────────────────────────────────────────────
--
-- One row per profile-view event. Dedup is per-viewer per-day via two
-- partial unique indexes (one for authenticated viewers, one for
-- anonymous session-based viewers).

CREATE TABLE IF NOT EXISTS public.profile_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewer_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  viewer_session_id TEXT,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- viewed_on is the UTC calendar day, used by the dedup unique
  -- indexes below. Separate column (not a generated expression) because
  -- date_trunc and timestamptz::date aren't IMMUTABLE enough for unique
  -- index predicates in older postgres versions. Default from NOW()
  -- keeps inserts ergonomic.
  viewed_on DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::date,
  user_agent TEXT,
  ip_hash TEXT
);

CREATE INDEX IF NOT EXISTS profile_views_profile_id_viewed_at_idx
  ON public.profile_views (profile_user_id, viewed_at DESC);

-- 24-hour dedup, authenticated viewer path
CREATE UNIQUE INDEX IF NOT EXISTS profile_views_dedup_authed
  ON public.profile_views (profile_user_id, viewer_user_id, viewed_on)
  WHERE viewer_user_id IS NOT NULL;

-- 24-hour dedup, anonymous-session viewer path
CREATE UNIQUE INDEX IF NOT EXISTS profile_views_dedup_anon
  ON public.profile_views (profile_user_id, viewer_session_id, viewed_on)
  WHERE viewer_session_id IS NOT NULL AND viewer_user_id IS NULL;

ALTER TABLE public.profile_views ENABLE ROW LEVEL SECURITY;

-- Profile owners can read their own view rows (for analytics on
-- "who viewed me"; v1 just shows aggregate count, but the row-level
-- access is here for v2 features).
CREATE POLICY profile_views_select_own ON public.profile_views
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = profile_user_id);

-- No INSERT/UPDATE/DELETE policies for non-service-role. The
-- profile-view-track edge function uses the service role and bypasses
-- RLS; client-side writes are intentionally blocked.

-- ─── 3. leaderboard_snapshots ──────────────────────────────────────
--
-- One row per (time_window, rank_type) per snapshot. The
-- leaderboard-snapshot cron writes rows; the leaderboard-public-feed
-- function reads the latest row matching the requested filter.
-- rankings is the top-100 JSON payload — denormalized for read speed.

CREATE TABLE IF NOT EXISTS public.leaderboard_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  time_window TEXT NOT NULL CHECK (time_window IN ('all_time', 'ytd', '30d', '7d')),
  rank_type TEXT NOT NULL CHECK (rank_type IN ('top_earners', 'win_rate', 'biggest_win', 'most_active')),
  rankings JSONB NOT NULL,
  total_eligible_users INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS leaderboard_snapshots_lookup_idx
  ON public.leaderboard_snapshots (time_window, rank_type, computed_at DESC);

ALTER TABLE public.leaderboard_snapshots ENABLE ROW LEVEL SECURITY;

-- Public-readable: anyone can fetch the latest snapshot for any
-- (time_window, rank_type). This is the leaderboard's whole point.
CREATE POLICY leaderboard_snapshots_select_public ON public.leaderboard_snapshots
  FOR SELECT TO anon, authenticated
  USING (true);

GRANT SELECT ON public.leaderboard_snapshots TO anon, authenticated;

-- ─── 4. user_trade_stats materialized view ─────────────────────────
--
-- Per-user closed-trade aggregates. Refreshed nightly by the
-- leaderboard-snapshot job. UNIQUE index on user_id enables
-- REFRESH MATERIALIZED VIEW CONCURRENTLY (no read lock during refresh).
--
-- Includes ALL profiles regardless of is_public — filtering happens
-- in the snapshot job (so privacy toggles flow through on next refresh
-- without a view rebuild).

CREATE MATERIALIZED VIEW IF NOT EXISTS public.user_trade_stats AS
SELECT
  p.id AS user_id,
  p.public_slug,
  p.display_name,
  p.created_at AS joined_at,
  p.is_public,
  p.exclude_from_leaderboard,
  p.profile_view_count,
  COUNT(*) FILTER (WHERE op.status = 'closed') AS closed_trades,
  COUNT(*) FILTER (WHERE op.status = 'closed' AND op.realized_pnl > 0) AS wins,
  COUNT(*) FILTER (WHERE op.status = 'closed' AND op.realized_pnl <= 0) AS losses,
  COALESCE(SUM(op.realized_pnl) FILTER (WHERE op.status = 'closed'), 0)::numeric AS total_pnl,
  COALESCE(MAX(op.realized_pnl) FILTER (WHERE op.status = 'closed'), 0)::numeric AS biggest_win,
  CASE
    WHEN COUNT(*) FILTER (WHERE op.status = 'closed') >= 1
    THEN ROUND(
      COUNT(*) FILTER (WHERE op.status = 'closed' AND op.realized_pnl > 0)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE op.status = 'closed'), 0) * 100,
      1
    )
    ELSE NULL
  END AS win_rate_pct
FROM public.profiles p
LEFT JOIN public.open_positions op ON op.user_id = p.id
GROUP BY p.id;

CREATE UNIQUE INDEX IF NOT EXISTS user_trade_stats_user_id_idx
  ON public.user_trade_stats (user_id);

CREATE INDEX IF NOT EXISTS user_trade_stats_total_pnl_idx
  ON public.user_trade_stats (total_pnl DESC)
  WHERE is_public AND NOT exclude_from_leaderboard;

CREATE INDEX IF NOT EXISTS user_trade_stats_win_rate_idx
  ON public.user_trade_stats (win_rate_pct DESC)
  WHERE is_public AND NOT exclude_from_leaderboard AND closed_trades >= 20;

CREATE INDEX IF NOT EXISTS user_trade_stats_biggest_win_idx
  ON public.user_trade_stats (biggest_win DESC)
  WHERE is_public AND NOT exclude_from_leaderboard;

CREATE INDEX IF NOT EXISTS user_trade_stats_most_active_idx
  ON public.user_trade_stats (closed_trades DESC)
  WHERE is_public AND NOT exclude_from_leaderboard;

-- Materialized view access: service_role only. Frontend reads
-- /record per-user stats directly from open_positions (RLS-scoped) so
-- it doesn't see other users' rows here. Frontend reads /leaderboard
-- via the leaderboard-public-feed edge function which uses service_role.
REVOKE ALL ON public.user_trade_stats FROM anon, authenticated;
GRANT SELECT ON public.user_trade_stats TO service_role;
