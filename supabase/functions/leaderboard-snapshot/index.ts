// Cash Moves — leaderboard-snapshot edge function.
//
// Daily cron that recomputes every leaderboard ranking and writes a
// snapshot row per (time_window × rank_type) combination. Reads
// happen against leaderboard_snapshots; this job is the only writer.
//
// Triggered by `.github/workflows/leaderboard-snapshot.yml` at
// 00:30 ET (= 04:30 / 05:30 UTC depending on DST). Service-role only.
//
// Steps:
//   1. refresh_user_trade_stats() — refreshes the materialized view
//      that powers /record per-user stats.
//   2. For each (time_window, rank_type) pair, call
//      compute_leaderboard_ranking RPC and insert a snapshot row.
//   3. Return a per-combo summary.
//
// Each snapshot is independent — one failing doesn't roll back the
// others. The /leaderboard tab for that combo serves yesterday's
// snapshot until the next run.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

type TimeWindow = 'all_time' | 'ytd' | '30d' | '7d'
type RankType = 'top_earners' | 'win_rate' | 'biggest_win' | 'most_active'

const TIME_WINDOWS: TimeWindow[] = ['all_time', 'ytd', '30d', '7d']
const RANK_TYPES: RankType[] = ['top_earners', 'win_rate', 'biggest_win', 'most_active']

const TOP_N = 100

// Column on the RPC result that corresponds to each rank_type's
// headline stat. The snapshot stores this as `stat_value` on each row
// so the read endpoint doesn't have to re-pick.
const STAT_COLUMN: Record<RankType, 'total_pnl' | 'biggest_win' | 'win_rate_pct' | 'closed_trades'> = {
  top_earners: 'total_pnl',
  biggest_win: 'biggest_win',
  win_rate: 'win_rate_pct',
  most_active: 'closed_trades',
}

interface RpcRow {
  user_id: string
  public_slug: string | null
  display_name: string | null
  profile_view_count: number | string
  closed_trades: number
  wins: number
  losses: number
  total_pnl: number | string
  biggest_win: number | string
  win_rate_pct: number | string | null
}

interface RankingRow {
  rank: number
  user_id: string
  public_slug: string | null
  display_name: string | null
  stat_value: number
  total_pnl: number
  biggest_win: number
  closed_trades: number
  wins: number
  losses: number
  win_rate_pct: number | null
  profile_view_count: number
}

function isServiceRole(authHeader: string | null): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false
  const token = authHeader.slice(7)
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload?.role === 'service_role'
  } catch {
    return false
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  if (!isServiceRole(req.headers.get('Authorization'))) {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const startedAt = Date.now()

  // 1. Refresh per-user stats materialized view (powers /record).
  const refresh = await supabase.rpc('refresh_user_trade_stats')
  const refreshError = refresh.error?.message ?? null

  // 2. Compute and write each (window, rank_type) snapshot.
  const results: Array<{
    time_window: TimeWindow
    rank_type: RankType
    inserted: boolean
    count: number
    error?: string
  }> = []

  for (const window of TIME_WINDOWS) {
    for (const rankType of RANK_TYPES) {
      try {
        const { data, error } = await supabase.rpc('compute_leaderboard_ranking', {
          p_time_window: window,
          p_rank_type: rankType,
          p_top_n: TOP_N,
        })
        if (error) throw new Error(`rpc: ${error.message}`)
        const rows = (data ?? []) as RpcRow[]

        const statKey = STAT_COLUMN[rankType]
        const rankings: RankingRow[] = rows.map((r, idx) => {
          const totalPnl = Number(r.total_pnl)
          const biggestWin = Number(r.biggest_win)
          const winRate = r.win_rate_pct != null ? Number(r.win_rate_pct) : null
          const closedTrades = Number(r.closed_trades)
          const statValue =
            statKey === 'total_pnl' ? totalPnl :
            statKey === 'biggest_win' ? biggestWin :
            statKey === 'win_rate_pct' ? (winRate ?? 0) :
            closedTrades
          return {
            rank: idx + 1,
            user_id: r.user_id,
            public_slug: r.public_slug,
            display_name: r.display_name,
            stat_value: statValue,
            total_pnl: totalPnl,
            biggest_win: biggestWin,
            closed_trades: closedTrades,
            wins: Number(r.wins),
            losses: Number(r.losses),
            win_rate_pct: winRate,
            profile_view_count: Number(r.profile_view_count),
          }
        })

        const { error: insertError } = await supabase
          .from('leaderboard_snapshots')
          .insert({
            time_window: window,
            rank_type: rankType,
            rankings,
            total_eligible_users: rankings.length,
          })
        if (insertError) throw new Error(`insert: ${insertError.message}`)

        results.push({ time_window: window, rank_type: rankType, inserted: true, count: rankings.length })
      } catch (e) {
        results.push({
          time_window: window,
          rank_type: rankType,
          inserted: false,
          count: 0,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  const failures = results.filter((r) => !r.inserted)
  return json({
    success: failures.length === 0,
    elapsed_ms: Date.now() - startedAt,
    refresh_error: refreshError,
    snapshots: results,
    failure_count: failures.length,
  })
})
