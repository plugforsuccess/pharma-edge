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
const APP_URL = Deno.env.get('APP_URL') || 'https://pharma-edge.vercel.app'
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
  contracts_remaining: number
  entry_debit_per_spread: number
  status: string
  last_mid_per_spread: number | null
  // Verdict state cached by monitor-positions every 5 min. This is
  // the SAME computation the client renders in the verdict banner,
  // so when trigger-eval fires thesis_invalidated the user can't
  // open the page and see "intact" — the banner already says
  // invalidated by the time the push arrives.
  last_verdict: 'intact' | 'drifting' | 'invalidated' | 'not_evaluable' | null
  last_verdict_reasons: string[] | null
  last_verdict_at: string | null
}

// Maps a trip kind to the number of contracts to close. Scales out
// against REMAINING contracts, not original — so a second profit
// trigger doesn't accidentally close more than the runner has left.
//   stop_loss_50      → full remaining (exit the whole thing)
//   profit_take_100   → ceil(50% of remaining)   ride 50%
//   profit_take_200   → ceil(75% of remaining)   ride 25%
// Returns 0 if there's nothing to scale out, signalling caller to
// skip the trigger insert (avoids creating a useless 0-contract row).
function contractsToScaleOut(kind: string, remaining: number): number {
  if (remaining <= 0) return 0
  if (kind === 'stop_loss_50') return remaining
  if (kind === 'profit_take_100') return Math.ceil(remaining * 0.5)
  if (kind === 'profit_take_200') return Math.ceil(remaining * 0.75)
  return remaining
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
  const title =
    kind === 'stop_loss_50' ? `${ticker}: stop loss tripped` :
    kind === 'thesis_invalidated' ? `${ticker}: thesis invalidated` :
    `${ticker}: profit target hit`
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
    .select('id, user_id, signal_id, ticker, strategy_type, long_strike, short_strike, expiration, contracts, contracts_remaining, entry_debit_per_spread, status, last_mid_per_spread, last_verdict, last_verdict_reasons, last_verdict_at')
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
    thesis_invalidated_fired: 0,
  }

  // Helper: best-effort insert of a single trigger row, with push
  // fan-out + idempotency-skip accounting. Captured in a closure so
  // both the P&L rules and the thesis-invalidated rule reuse it
  // without duplicating the boilerplate.
  async function fireTrigger(
    pos: Position,
    kind: string,
    reason: string,
    proposedAction: Record<string, unknown>,
    observed: Record<string, unknown>,
  ) {
    const { error: insertErr, data: inserted } = await supabase
      .from('auto_triggers')
      .insert({
        user_id: pos.user_id,
        position_id: pos.id,
        signal_id: pos.signal_id,
        kind,
        reason,
        proposed_action: proposedAction,
        observed,
      })
      .select('id')
      .maybeSingle()

    if (insertErr) {
      if (insertErr.code === '23505') {
        summary.triggers_idempotent_skip++
        return
      }
      console.warn('[trigger-eval] insert failed', pos.id, kind, insertErr.message)
      return
    }
    if (inserted?.id) {
      summary.triggers_created.push({ position_id: pos.id, kind, reason })
      await fanOutPush(supabase, pos.user_id, pos.id, inserted.id, pos.ticker, kind, reason)
    }
  }

  for (const pos of positions ?? []) {
    summary.evaluated++

    // ── 1. thesis_invalidated — independent of leg-quote availability ──
    // monitor-positions caches the verdict on open_positions every 5 min
    // using the same algorithm the client UI displays. We just read the
    // cached state; the verdict doesn't need leg mids, only spot + the
    // GEX matrix, both of which monitor-positions handles. As a result
    // this rule fires even when dxlink quotes are stale or the spread
    // is a credit (which the P&L rules skip).
    //
    // Stale-verdict guard: if last_verdict_at is older than 30 min we
    // skip — the cache might be from before a market event we'd want
    // to reflect first. monitor-positions runs every 5 min so the only
    // way to be >30 min stale is if it's down, in which case the
    // dead-man switch (worker-health) is already alerting on it.
    const VERDICT_STALE_MS = 30 * 60_000
    const verdictAge = pos.last_verdict_at
      ? Date.now() - new Date(pos.last_verdict_at).getTime()
      : Infinity
    if (pos.last_verdict === 'invalidated' && verdictAge <= VERDICT_STALE_MS) {
      // The verdict can compute without a live spread mid, but we
      // STILL need a sane limit_price for the close order. Try the
      // current dxlink mid first; if that's missing, fall back to
      // pos.last_mid_per_spread (broker-polled, possibly delayed).
      // If we have NEITHER, defer — the UI can't submit a close
      // without a price.
      const { data: quotesForLimit } = await supabase
        .from('dxlink_quotes')
        .select('symbol, strike, option_type, mid, updated_at')
        .eq('underlying', pos.ticker)
        .eq('kind', 'option')
        .eq('expiration_date', pos.expiration)
        .in('strike', [Number(pos.long_strike), Number(pos.short_strike)])
        .returns<QuoteRow[]>()
      const livePnlForLimit = computeLivePnl(pos, quotesForLimit ?? [])
      const limitPrice = livePnlForLimit?.currentMid
        ?? (Number.isFinite(Number(pos.last_mid_per_spread))
          ? Number(pos.last_mid_per_spread)
          : null)
      if (Number.isFinite(limitPrice) && (limitPrice as number) > 0) {
        const reasons = pos.last_verdict_reasons ?? []
        const summary_line = reasons[0] ?? 'Entry-time thesis no longer holds.'
        const reason = `Thesis invalidated. ${summary_line} Cash Moves rule: exit when thesis breaks, regardless of P&L.`
        await fireTrigger(
          pos,
          'thesis_invalidated',
          reason,
          {
            position_id: pos.id,
            contracts: pos.contracts_remaining,
            limit_price: Number((limitPrice as number).toFixed(2)),
          },
          {
            last_verdict: pos.last_verdict,
            last_verdict_at: pos.last_verdict_at,
            last_verdict_reasons: reasons,
            limit_source: livePnlForLimit?.currentMid != null ? 'live' : 'last_polled',
            contracts_remaining_at_trip: pos.contracts_remaining,
          },
        )
        summary.thesis_invalidated_fired++
      }
    }

    // ── 2. P&L-based rules — stop loss + profit take ladder ────────────
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

    const targetContracts = contractsToScaleOut(trip.kind, pos.contracts_remaining)
    if (targetContracts <= 0) {
      continue
    }
    const proposed_action = {
      position_id: pos.id,
      contracts: targetContracts,
      limit_price: Number(pnl.currentMid.toFixed(2)),
    }

    await fireTrigger(
      pos,
      trip.kind,
      trip.reason,
      proposed_action,
      {
        pnl_pct: Number(pnl.pnlPct.toFixed(2)),
        current_mid: Number(pnl.currentMid.toFixed(2)),
        entry_debit: Number(pos.entry_debit_per_spread),
        contracts_remaining_at_trip: pos.contracts_remaining,
        scaling_out: targetContracts,
        as_of: pnl.asOf,
      },
    )
  }

  return json({ success: true, rth, force, summary })
})
