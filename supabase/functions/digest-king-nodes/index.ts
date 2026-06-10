// Cash Moves — digest-king-nodes edge function.
//
// Daily broadcast of the top 10 |GEX| king nodes (across all tickers ×
// first 3 expirations) to every active push_subscriptions row.
//
// Triggered by pg_cron on weekday mornings. Service-role only.
//
// Output is a single web-push notification per subscriber whose body
// lists the top setups. Each clicks through to /markets/king-board so
// the user can dig into per-ticker GEX + suggested plays.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:noreply@example.com'
const APP_URL = Deno.env.get('APP_URL') || 'https://cashmoves.io'

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

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : ''
    return JSON.parse(atob(padded + pad))
  } catch {
    return null
  }
}

function formatGex(v: number): string {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : '+'
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${Math.round(abs / 1e6)}M`
  return `${sign}$${Math.round(abs)}`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Top 10 king nodes by |GEX| across the whole universe + first 3 exps.
  const { data: rows, error: viewError } = await supabase
    .from('current_king_nodes')
    .select('ticker, exp_idx, exp_date, dte, king_strike, king_gex, side')
  if (viewError) {
    return json({ success: false, error: `view query: ${viewError.message}` }, 500)
  }
  const top = (rows ?? [])
    .map((r) => ({ ...r, abs_gex: Math.abs(Number(r.king_gex) || 0) }))
    .sort((a, b) => b.abs_gex - a.abs_gex)
    .slice(0, 10)

  if (top.length === 0) {
    return json({ success: true, sent: 0, pruned: 0, errors: 0, note: 'no king nodes available' })
  }

  // "SPY 735p · 0DTE · -$300M"
  const lines = top.map((r) => {
    const strike = Number(r.king_strike)
    const sideMark = r.side === 'call' ? 'C' : 'P'
    return `${r.ticker} ${strike}${sideMark} · ${r.dte}d · ${formatGex(Number(r.king_gex))}`
  })
  const title = `King Board · top ${top.length}`
  const body = lines.join('\n')
  const clickUrl = `${APP_URL}/markets/king-board`

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return json({ success: false, error: 'VAPID keys not configured' }, 500)
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

  const { data: subs, error: subsError } = await supabase
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth')
  if (subsError) {
    return json({ success: false, error: `subs query: ${subsError.message}` }, 500)
  }

  let sent = 0
  let pruned = 0
  let errors = 0
  for (const sub of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body, url: clickUrl, type: 'king_node_digest' }),
        { TTL: 60 * 60 * 6 },
      )
      sent += 1
      await supabase
        .from('push_subscriptions')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', sub.id)
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode
      if (status === 404 || status === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id)
        pruned += 1
      } else {
        console.warn('push send failed', status, (err as Error).message)
        errors += 1
      }
    }
  }

  return json({ success: true, sent, pruned, errors, top_count: top.length })
})
