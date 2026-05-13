// Cash Moves — leaderboard-public-feed edge function.
//
// Public read endpoint for /leaderboard. Returns the latest snapshot
// row for a (time_window, rank_type) pair, with optional strategy
// filter and pagination.
//
// verify_jwt=false — the leaderboard is publicly browseable. Anyone
// landing on cashmoves.io/leaderboard can read it without an account.
//
// The strategy_filter parameter is documented in the spec but not yet
// wired to data — the snapshot stores aggregated stats per user
// across all strategies. When per-strategy stats land in a later
// migration we'll re-rank from the cached payload here; for now the
// parameter is accepted and silently ignored, marked TODO.

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

const VALID_WINDOWS = new Set(['all_time', 'ytd', '30d', '7d'])
const VALID_RANK_TYPES = new Set(['top_earners', 'win_rate', 'biggest_win', 'most_active'])

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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  let body: {
    time_window?: string
    rank_type?: string
    strategy_filter?: string | null
    page?: number
    per_page?: number
  }
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const timeWindow = String(body.time_window ?? 'all_time')
  const rankType = String(body.rank_type ?? 'top_earners')
  if (!VALID_WINDOWS.has(timeWindow)) return json({ success: false, error: 'invalid time_window' }, 400)
  if (!VALID_RANK_TYPES.has(rankType)) return json({ success: false, error: 'invalid rank_type' }, 400)

  // Clamp pagination. per_page hard-capped at 100 (full snapshot) to
  // prevent malicious bodies from forcing huge responses.
  const page = Math.max(1, Math.min(20, Number(body.page) || 1))
  const perPage = Math.max(1, Math.min(100, Number(body.per_page) || 50))

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Latest snapshot for this (window, rank_type) pair.
  const { data: snapshot, error: snapErr } = await admin
    .from('leaderboard_snapshots')
    .select('computed_at, rankings, total_eligible_users')
    .eq('time_window', timeWindow)
    .eq('rank_type', rankType)
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (snapErr) return json({ success: false, error: `snapshot lookup: ${snapErr.message}` }, 500)

  if (!snapshot) {
    // Pre-launch state: cron hasn't run yet for this combo. Return
    // an empty result so the UI can render the "first leaderboard
    // snapshot tomorrow at midnight ET" empty state.
    return json({
      success: true,
      data: {
        snapshot_computed_at: null,
        total_eligible: 0,
        page,
        per_page: perPage,
        total_pages: 0,
        rankings: [],
      },
    })
  }

  const rankings = (snapshot.rankings ?? []) as RankingRow[]
  const totalPages = Math.max(1, Math.ceil(rankings.length / perPage))
  const start = (page - 1) * perPage
  const slice = rankings.slice(start, start + perPage)

  return json({
    success: true,
    data: {
      snapshot_computed_at: snapshot.computed_at,
      total_eligible: snapshot.total_eligible_users,
      page,
      per_page: perPage,
      total_pages: totalPages,
      rankings: slice,
    },
  })
})
