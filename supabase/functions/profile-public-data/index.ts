// Cash Moves — profile-public-data edge function.
//
// Public-readable endpoint that returns everything the /u/:slug page
// needs: profile header, aggregate stats, and recent positions
// (active + closed). Single source of truth so the page, the
// SSR-middleware that injects meta tags, and the OG image endpoint
// all read the same recipe.
//
// verify_jwt=false — anyone can hit this with a public_slug. Reads
// only `is_public = true AND exclude_from_leaderboard = false`
// profiles. RLS on open_positions is bypassed via service_role inside
// this function; we explicitly filter to the resolved profile's
// user_id so a malformed slug can't leak someone else's positions.
//
// Returns 404 for unknown / private slugs.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
  })
}

const ACTIVE_POSITION_FIELDS =
  'id, signal_id, ticker, strategy_type, contracts, ' +
  'entry_debit_per_spread, last_mid_per_spread, last_pnl_pct, ' +
  'last_verdict, entry_at, expiration, long_strike, short_strike'

const CLOSED_POSITION_FIELDS =
  'id, signal_id, ticker, strategy_type, contracts, ' +
  'entry_debit_per_spread, exit_credit_per_spread, realized_pnl, ' +
  'entry_at, closed_at, expiration, long_strike, short_strike'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  let body: { slug?: string }
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const slug = (body.slug ?? '').trim().toLowerCase()
  if (!slug) return json({ success: false, error: 'slug required' }, 400)

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // ── 1. Profile ──────────────────────────────────────────────────
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id, display_name, public_slug, is_public, exclude_from_leaderboard, profile_view_count, created_at')
    .eq('public_slug', slug)
    .maybeSingle()
  if (profileErr) return json({ success: false, error: `profile: ${profileErr.message}` }, 500)
  if (!profile || !profile.is_public || profile.exclude_from_leaderboard) {
    return json({ success: false, error: 'profile not found' }, 404)
  }

  // ── 2. Aggregate stats from open_positions ──────────────────────
  //
  // Mirrors the recipe used by the leaderboard's top_earners ranking
  // and TrackRecord's stat blocks — keeps /u/:slug, /record, and
  // /leaderboard agreeing on a single number per user.
  const { data: closedRows, error: closedErr } = await admin
    .from('open_positions')
    .select(CLOSED_POSITION_FIELDS)
    .eq('user_id', profile.id)
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(100)
  if (closedErr) return json({ success: false, error: `closed: ${closedErr.message}` }, 500)

  const { data: openRows, error: openErr } = await admin
    .from('open_positions')
    .select(ACTIVE_POSITION_FIELDS)
    .eq('user_id', profile.id)
    .eq('status', 'open')
    .order('entry_at', { ascending: false })
    .limit(50)
  if (openErr) return json({ success: false, error: `open: ${openErr.message}` }, 500)

  let totalPnl = 0
  let biggestWin = 0
  let wins = 0
  let losses = 0
  for (const p of closedRows ?? []) {
    const pnl = Number(p.realized_pnl ?? 0)
    totalPnl += pnl
    if (pnl > biggestWin) biggestWin = pnl
    if (pnl > 0) wins += 1
    else losses += 1
  }
  const trades = (closedRows ?? []).length
  const winRatePct = trades > 0 ? Math.round((wins / trades) * 1000) / 10 : null

  // ── 3. Leaderboard rank (latest all_time / top_earners snapshot) ─
  let leaderboardRank: number | null = null
  const { data: snapshot } = await admin
    .from('leaderboard_snapshots')
    .select('rankings')
    .eq('time_window', 'all_time')
    .eq('rank_type', 'top_earners')
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (snapshot?.rankings) {
    const row = (snapshot.rankings as Array<{ user_id: string; rank: number }>).find(
      (r) => r.user_id === profile.id,
    )
    leaderboardRank = row?.rank ?? null
  }

  return json(
    {
      success: true,
      data: {
        profile: {
          display_name: profile.display_name,
          public_slug: profile.public_slug,
          joined_at: profile.created_at,
          view_count: Number(profile.profile_view_count ?? 0),
        },
        stats: {
          total_pnl: totalPnl,
          biggest_win: biggestWin,
          trades,
          wins,
          losses,
          win_rate_pct: winRatePct,
          leaderboard_rank: leaderboardRank,
        },
        positions: {
          open: openRows ?? [],
          closed: closedRows ?? [],
        },
      },
    },
    200,
    {
      // 1-min CDN cache for the public endpoint. Stats lag at most 1
      // minute behind reality on /u/:slug; OG previews and the
      // middleware respect this too.
      'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
    },
  )
})
