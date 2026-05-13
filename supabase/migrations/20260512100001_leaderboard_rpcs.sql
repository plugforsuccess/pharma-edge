-- Leaderboard v1 RPCs. Two SECURITY DEFINER functions called by the
-- leaderboard-snapshot edge function (service_role context).
--
-- Why SECURITY DEFINER:
--   * refresh_user_trade_stats — refreshing a materialized view
--     requires owner-level privileges. The cron runs as service_role
--     which is a high-privilege role but not the view's OWNER.
--     SECURITY DEFINER lets us scope the privilege to this one operation.
--   * compute_leaderboard_ranking — wraps the dynamic ORDER BY required
--     to pick the metric column (total_pnl vs biggest_win vs win_rate_pct
--     vs closed_trades) without exposing arbitrary SQL to the caller.
--     Inputs are validated against the rank_type and time_window enums
--     defined in the migration above, so the EXECUTE string is safe.
--
-- Both functions are anyone-callable; the leaderboard-snapshot function
-- gates access at the edge layer.

-- ─── refresh_user_trade_stats ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.refresh_user_trade_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- CONCURRENTLY keeps /record reads unblocked during refresh.
  -- Requires the unique index on user_trade_stats(user_id) from the
  -- prior migration.
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.user_trade_stats;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_user_trade_stats() FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_user_trade_stats() TO service_role;

-- ─── compute_leaderboard_ranking ───────────────────────────────────
--
-- Returns the top N rows for a given (time_window, rank_type) pair,
-- already filtered and ordered.

CREATE OR REPLACE FUNCTION public.compute_leaderboard_ranking(
  p_time_window TEXT,
  p_rank_type TEXT,
  p_top_n INTEGER DEFAULT 100
)
RETURNS TABLE (
  user_id UUID,
  public_slug TEXT,
  display_name TEXT,
  profile_view_count BIGINT,
  closed_trades INTEGER,
  wins INTEGER,
  losses INTEGER,
  total_pnl NUMERIC,
  biggest_win NUMERIC,
  win_rate_pct NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_date_floor TEXT;
  v_min_trades INTEGER;
  v_order_by TEXT;
  v_sql TEXT;
BEGIN
  -- Validate inputs against the enum values declared in the
  -- leaderboard_snapshots CHECK constraints. Anything else raises and
  -- the cron logs the error.
  IF p_time_window NOT IN ('all_time', 'ytd', '30d', '7d') THEN
    RAISE EXCEPTION 'invalid time_window: %', p_time_window;
  END IF;
  IF p_rank_type NOT IN ('top_earners', 'win_rate', 'biggest_win', 'most_active') THEN
    RAISE EXCEPTION 'invalid rank_type: %', p_rank_type;
  END IF;

  -- Date floor for the window. all_time has no floor.
  v_date_floor := CASE p_time_window
    WHEN 'all_time' THEN ''
    WHEN 'ytd'      THEN 'AND op.closed_at >= date_trunc(''year'', now())'
    WHEN '30d'      THEN 'AND op.closed_at >= now() - interval ''30 days'''
    WHEN '7d'       THEN 'AND op.closed_at >= now() - interval ''7 days'''
  END;

  -- Min closed-trade count gate. Tighter for win_rate; small samples
  -- skew (3/3 = 100% is meaningless).
  v_min_trades := CASE p_rank_type
    WHEN 'top_earners' THEN 10
    WHEN 'win_rate'    THEN 20
    WHEN 'biggest_win' THEN 1
    WHEN 'most_active' THEN 1
  END;

  -- ORDER BY column matching the rank type.
  v_order_by := CASE p_rank_type
    WHEN 'top_earners' THEN 'total_pnl'
    WHEN 'win_rate'    THEN 'win_rate_pct'
    WHEN 'biggest_win' THEN 'biggest_win'
    WHEN 'most_active' THEN 'closed_trades'
  END;

  -- Inputs above are constrained to enum literals; no caller-controlled
  -- strings flow into the EXECUTE. Safe.
  v_sql := format($q$
    WITH agg AS (
      SELECT
        p.id AS user_id,
        p.public_slug,
        p.display_name,
        p.profile_view_count,
        COUNT(*)::int AS closed_trades,
        COUNT(*) FILTER (WHERE op.realized_pnl > 0)::int AS wins,
        COUNT(*) FILTER (WHERE op.realized_pnl <= 0)::int AS losses,
        COALESCE(SUM(op.realized_pnl), 0)::numeric AS total_pnl,
        COALESCE(MAX(op.realized_pnl), 0)::numeric AS biggest_win,
        CASE
          WHEN COUNT(*) >= 1
          THEN ROUND(
            COUNT(*) FILTER (WHERE op.realized_pnl > 0)::numeric
            / NULLIF(COUNT(*), 0) * 100,
            1
          )
          ELSE NULL
        END AS win_rate_pct
      FROM public.profiles p
      JOIN public.open_positions op
        ON op.user_id = p.id
        AND op.status = 'closed'
        %s
      WHERE p.is_public = true
        AND p.exclude_from_leaderboard = false
      GROUP BY p.id
      HAVING COUNT(*) >= %s
    )
    SELECT
      user_id, public_slug, display_name, profile_view_count,
      closed_trades, wins, losses, total_pnl, biggest_win, win_rate_pct
    FROM agg
    WHERE %I IS NOT NULL
    ORDER BY %I DESC NULLS LAST
    LIMIT %s
  $q$, v_date_floor, v_min_trades, v_order_by, v_order_by, p_top_n);

  RETURN QUERY EXECUTE v_sql;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_leaderboard_ranking(TEXT, TEXT, INTEGER) FROM public;
GRANT EXECUTE ON FUNCTION public.compute_leaderboard_ranking(TEXT, TEXT, INTEGER) TO service_role;
