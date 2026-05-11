// Cash Moves — trigger-eval edge function.
//
// Phase 1 of automated trade management. Every 5 min during RTH, for
// each open position, compute live P&L from streaming leg quotes
// (dxlink_quotes) and check the rule book:
//
//   P&L ≤ -50%   → stop_loss_50      (close full position)
//   P&L ≥ +100%  → profit_take_100   (consider 50% close)
//   P&L ≥ +200%  → profit_take_200   (consider 75% close)
//
// Each trip writes a row to public.auto_triggers with a pre-built
// `proposed_action` body the UI can POST straight to close-order on
// a one-tap "Close now". A partial unique index on
// (position_id, kind) WHERE status='pending' enforces idempotency:
// the cron can run 10 times and we still only ever have one pending
// row per (position, kind).
//
// Fans out a push notification per trigger so the user gets
// notified on their phone even with the app closed.
//
// service-role-only. The worker-health.yml cron pattern with
// SUPABASE_SERVICE_ROLE_KEY in the Authorization header.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const APP_URL = Deno.env.get('APP_URL') || 'https://cashmoves.io'
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')

const STOP_LOSS_PCT = -50
const PROFIT_TAKE_100 = 100
const PROFIT_TAKE_200 = 200
// Quote rows older than this are treated as untrustworthy — the
// eval skips the position rather than tripping on a stale price.
const QUOTE_STALE_MS = 5 * 60_000

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
    const [, payload] = token.split('.')
    if (!payload) return null
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    return JSON.parse(atob(padded))
  } catch {
    return null
  }
}

// US equity RTH check, DST-safe via Intl.
function isRegularTradingHours(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const weekday = parts.find((p) => p.type === 'weekday')?.value
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const mins = hour * 60 + minute
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}

interface Position {
  id: string
  user_id: string
  signal_id: string | null
  ticker: string
  strategy_type: string
  long_strike: number
  short_strike: number
  expiration: string
  contracts: number
  entry_debit_per_spread: number
  status: string
  last_mid_per_spread: number | null
}

interface QuoteRow {
  symbol: string | null
  strike: number
  option_type: string
  mid: number | null
  updated_at: string
}

// Live spread mid + P&L for a debit spread, computed off the worker's
// streaming quotes. Returns null when either leg is missing or the
// freshest leg quote is older than QUOTE_STALE_MS — we'd rather skip
// the eval than trip on a stale price.
function computeLivePnl(pos: Position, quotes: QuoteRow[]) {
  const strat = pos.strategy_type.toLowerCase()
  // Phase 1 covers debit spreads only. Credit spreads need a
  // different sign convention on entry_debit_per_spread we haven't
  // unified yet — skip them rather than mis-trip.
  const isDebit = strat === 'bull_call_spread' || strat === 'bear_put_spread'
  if (!isDebit) return null

  const optionType = strat === 'bull_call_spread' ? 'C' : 'P'
  const long = quotes.find(
    (q) => q.option_type === optionType && Number(q.strike) === Number(pos.long_strike),
  )
  const short = quotes.find(
    (q) => q.option_type === optionType && Number(q.strike) === Number(pos.short_strike),
  )
  if (!long?.mid || !short?.mid) return null

  const longTs = long.updated_at ? new Date(long.updated_at).getTime() : 0
  const shortTs = short.updated_at ? new Date(short.updated_at).getTime() : 0
  const newest = Math.max(longTs, shortTs)
  if (newest === 0 || Date.now() - newest > QUOTE_STALE_MS) return null

  const longMid = Number(long.mid)
  const shortMid = Number(short.mid)
  const currentMid = longMid - shortMid
  const entry = Number(pos.entry_debit_per_spread)
  if (!Number.isFinite(entry) || entry <= 0) return null

  const pnlPct = ((currentMid - entry) / entry) * 100
  return {
    currentMid,
    pnlPct,
    asOf: new Date(newest).toISOString(),
  }
}

// Evaluate which (if any) rule trips for this position at the
// current pnlPct. Returns the kind + reason text; null means
// nothing to do. Highest-severity rule wins when multiple match
// (stop loss > profit_take_200 > profit_take_100).
function evaluateRules(pnlPct: number): { kind: string; reason: string } | null {
  if (pnlPct <= STOP_LOSS_PCT) {
    return {
      kind: 'stop_loss_50',
      reason: `P&L hit ${pnlPct.toFixed(0)}% (threshold ${STOP_LOSS_PCT}%). Cash Moves rule: exit immediately.`,
    }
  }
  if (pnlPct >= PROFIT_TAKE_200) {
    return {
      kind: 'profit_take_200',
      reason: `P&L hit +${pnlPct.toFixed(0)}% (target +${PROFIT_TAKE_200}%). Playbook: scale out 75%, keep 25% running.`,
    }
  }
  if (pnlPct >= PROFIT_TAKE_100) {
    return {
      kind: 'profit_take_100',
      reason: `P&L hit +${pnlPct.toFixed(0)}% (target +${PROFIT_TAKE_100}%). Playbook: scale out 50%.`,
    }
  }
  return null
}

async function fanOutPush(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  positionId: string,
  triggerId: string,
  ticker: string,
  kind: string,
  reason: string,
) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  } catch (err) {
    console.warn('[trigger-eval] vapid setup failed:', (err as Error).message)
    return
  }
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId)
  const title = kind === 'stop_loss_50'
    ? `${ticker}: stop loss tripped`
    : `${ticker}: profit target hit`
  const payload = {
    title,
    body: reason,
    url: `${APP_URL}/position/${positionId}?trigger=${triggerId}`,
  }
  for (const sub of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 },
      )
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode
      if (status === 404 || status === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id)
      } else {
        console.warn('[trigger-eval] push failed', status, (err as Error).message)
      }
    }
  }
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
  const token = authHeader.slice('Bearer '.length)
  const claims = decodeJwtPayload(token)
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const now = new Date()

  // Outside RTH: workers aren't streaming → quote staleness guard
  // would skip every position anyway → no-op the whole eval. We
  // still allow workflow_dispatch overrides in dev by accepting
  // body.force = true, since that's the only useful thing to do
  // when verifying wiring outside hours.
  const rth = isRegularTradingHours(now)
  let force = false
  try {
    const body = await req.json()
    force = body?.force === true
  } catch { /* no body — fine */ }

  if (!rth && !force) {
    return json({ success: true, rth: false, skipped: 'outside RTH' })
  }

  const { data: positions, error: posErr } = await supabase
    .from('open_positions')
    .select('id, user_id, signal_id, ticker, strategy_type, long_strike, short_strike, expiration, contracts, entry_debit_per_spread, status, last_mid_per_spread')
    .eq('status', 'open')
    .returns<Position[]>()
  if (posErr) {
    return json({ success: false, error: `positions fetch failed: ${posErr.message}` }, 502)
  }

  const summary = {
    evaluated: 0,
    skipped_no_quotes: 0,
    skipped_credit_spread: 0,
    triggers_created: [] as Array<{ position_id: string; kind: string; reason: string }>,
    triggers_idempotent_skip: 0,
  }

  for (const pos of positions ?? []) {
    summary.evaluated++

    // Pull both legs from dxlink_quotes in one query.
    const { data: quotes } = await supabase
      .from('dxlink_quotes')
      .select('symbol, strike, option_type, mid, updated_at')
      .eq('underlying', pos.ticker)
      .eq('kind', 'option')
      .eq('expiration_date', pos.expiration)
      .in('strike', [Number(pos.long_strike), Number(pos.short_strike)])
      .returns<QuoteRow[]>()

    const pnl = computeLivePnl(pos, quotes ?? [])
    if (!pnl) {
      // Either credit spread (we don't eval those in phase 1) or
      // stale/missing quotes. Both cases: skip.
      const strat = pos.strategy_type.toLowerCase()
      if (strat !== 'bull_call_spread' && strat !== 'bear_put_spread') {
        summary.skipped_credit_spread++
      } else {
        summary.skipped_no_quotes++
      }
      continue
    }

    const trip = evaluateRules(pnl.pnlPct)
    if (!trip) continue

    // Build the proposed_action body. close-order takes
    // { position_id, account_number, contracts, limit_price,
    //   trigger_id }. We don't know the user's preferred account
    // here — they may have multiple — so we omit account_number and
    // let the UI fill it in from their selected account on
    // PositionDetail. contracts default = full close.
    //
    // limit_price = current spread mid (we'll receive this). For
    // partial closes the UI can reduce contracts but keep the same
    // mid price.
    const proposed_action = {
      position_id: pos.id,
      contracts: pos.contracts,
      limit_price: Number(pnl.currentMid.toFixed(2)),
    }

    const { error: insertErr, data: inserted } = await supabase
      .from('auto_triggers')
      .insert({
        user_id: pos.user_id,
        position_id: pos.id,
        signal_id: pos.signal_id,
        kind: trip.kind,
        reason: trip.reason,
        proposed_action,
        observed: {
          pnl_pct: Number(pnl.pnlPct.toFixed(2)),
          current_mid: Number(pnl.currentMid.toFixed(2)),
          entry_debit: Number(pos.entry_debit_per_spread),
          as_of: pnl.asOf,
        },
      })
      .select('id')
      .maybeSingle()

    if (insertErr) {
      // Most common: 23505 unique violation from the partial
      // index → there's already a pending trigger of this kind.
      // Idempotency working as intended.
      if (insertErr.code === '23505') {
        summary.triggers_idempotent_skip++
        continue
      }
      console.warn('[trigger-eval] insert failed', pos.id, trip.kind, insertErr.message)
      continue
    }

    if (inserted?.id) {
      summary.triggers_created.push({
        position_id: pos.id,
        kind: trip.kind,
        reason: trip.reason,
      })
      // Fire the push notification — best-effort, never fails the
      // eval if push delivery has hiccups.
      await fanOutPush(
        supabase, pos.user_id, pos.id, inserted.id, pos.ticker, trip.kind, trip.reason,
      )
    }
  }

  return json({ success: true, rth, force, summary })
})
