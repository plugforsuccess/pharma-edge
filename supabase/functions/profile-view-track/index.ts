// Cash Moves — profile-view-track edge function.
//
// Called from /u/:slug page loads. Records a view (with dedup) and
// atomically increments profiles.profile_view_count. Public route
// (verify_jwt=false) because anonymous viewers need to count.
//
// Dedup contract:
//   * Authenticated viewer + same profile within 24h UTC = 1 view
//   * Anonymous session + same profile within 24h UTC = 1 view
//   * Owner viewing own profile = 0 views
//   * Bot user-agents (Google, Bing) = 0 views
//   * Social-card crawlers (Twitterbot, facebookexternalhit) = allowed
//     so OG preview pulls "count" as engagement signal.
//
// The DB layer enforces dedup via partial unique indexes on
// profile_views (see migration 20260512100000). We INSERT ... ON CONFLICT
// DO NOTHING and rely on the indexes to silently drop duplicates.
// Only when the insert succeeded do we bump the counter.

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

// User-agents we silently ignore. Search crawlers shouldn't inflate
// the social-validator counter. Twitterbot / facebookexternalhit are
// the OG-preview fetchers — those we COUNT, because a shared link being
// previewed is engagement.
const BOT_UA_PATTERNS = [
  /googlebot/i,
  /bingbot/i,
  /yandex/i,
  /baiduspider/i,
  /duckduckbot/i,
  /ahrefsbot/i,
  /semrushbot/i,
  /mj12bot/i,
  /dotbot/i,
  /\bbot\b.*\bcrawl/i,  // generic crawl bots
]

function isCrawlerBot(ua: string | null): boolean {
  if (!ua) return false
  return BOT_UA_PATTERNS.some((re) => re.test(ua))
}

// SHA-256 hex hash for IP storage. Salt with a server secret so the
// hash isn't trivially rainbow-attackable. The IP is only used for
// internal abuse signals — never displayed.
async function hashIp(ip: string | null): Promise<string | null> {
  if (!ip) return null
  const salt = Deno.env.get('IP_HASH_SALT') ?? 'cm-default-salt'
  const data = new TextEncoder().encode(`${salt}:${ip}`)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  let body: { slug?: string; viewer_user_id?: string | null; viewer_session_id?: string | null }
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const slug = (body.slug ?? '').trim().toLowerCase()
  if (!slug) return json({ success: false, error: 'slug required' }, 400)

  const viewerUserId = body.viewer_user_id ?? null
  const viewerSessionId = body.viewer_session_id ?? null
  if (!viewerUserId && !viewerSessionId) {
    return json({ success: false, error: 'viewer_user_id or viewer_session_id required' }, 400)
  }

  const userAgent = req.headers.get('User-Agent')
  if (isCrawlerBot(userAgent)) {
    // Silently 204 — don't tell the bot we filtered them, no need to
    // surface this in app logs.
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Resolve profile. Reject if not public or excluded — we don't track
  // views on private profiles.
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id, is_public, exclude_from_leaderboard')
    .eq('public_slug', slug)
    .maybeSingle()
  if (profileErr) return json({ success: false, error: `profile lookup: ${profileErr.message}` }, 500)
  if (!profile) return json({ success: false, error: 'profile not found' }, 404)
  if (!profile.is_public || profile.exclude_from_leaderboard) {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  // Owner viewing own profile = no count.
  if (viewerUserId && viewerUserId === profile.id) {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  // Best-effort IP capture. The Forwarded / X-Forwarded-For headers
  // are set by Supabase's edge proxy.
  const fwdHeader = req.headers.get('X-Forwarded-For') ?? req.headers.get('CF-Connecting-IP')
  const ip = fwdHeader?.split(',')[0]?.trim() ?? null
  const ipHash = await hashIp(ip)

  // Insert the view row. The partial unique indexes
  // (profile_views_dedup_authed / _dedup_anon) on (profile_user_id,
  // viewer_user_id, viewed_on) and (profile_user_id, viewer_session_id,
  // viewed_on) handle 24h dedup. ON CONFLICT DO NOTHING means a
  // duplicate-day view silently no-ops.
  const insertRow = {
    profile_user_id: profile.id,
    viewer_user_id: viewerUserId,
    viewer_session_id: viewerUserId ? null : viewerSessionId,
    user_agent: userAgent?.slice(0, 500) ?? null,
    ip_hash: ipHash,
  }
  const { data: inserted, error: insertErr } = await admin
    .from('profile_views')
    .insert(insertRow)
    .select('id')
    .maybeSingle()

  // PostgREST returns null + no error when ON CONFLICT silently drops
  // — we treat that as "already counted today, no bump needed."
  // It also surfaces 23505 (unique_violation) as an error; we treat
  // that the same way (no bump). Anything else is a real failure.
  if (insertErr && insertErr.code !== '23505') {
    return json({ success: false, error: `insert: ${insertErr.message}` }, 500)
  }
  if (!inserted) {
    // Duplicate within 24h — skip the counter increment.
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  // Atomically increment the running counter on profiles. Using rpc()
  // via a small SQL function (defined inline below in the migration)
  // would be cleaner; for now we accept the read-modify-write
  // approximation since concurrent inserts on the same profile within
  // the same second are vanishingly rare for v1 user counts.
  const { error: bumpErr } = await admin.rpc('bump_profile_view_count', {
    p_profile_user_id: profile.id,
  })
  if (bumpErr) {
    // Counter is informational; the view row already persisted.
    console.warn('[profile-view-track] counter bump failed:', bumpErr.message)
  }

  return new Response(null, { status: 204, headers: corsHeaders })
})
