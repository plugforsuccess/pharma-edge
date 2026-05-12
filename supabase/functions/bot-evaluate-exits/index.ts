// bot-evaluate-exits — autonomous exit rule engine for whale-tail
// positions.
//
// Cron-invoked every 5 min during US RTH. For every open whale-tail
// position, computes live P&L from dxlink_quotes + position state and
// fires bot-place-exit when ANY of these triggers:
//
//   * whale_profit_take_100: P&L ≥ +100% → close 50% of remaining
//   * whale_profit_take_200: P&L ≥ +200% → close 75% of remaining
//   * whale_stop_50:         P&L ≤  -50% → close full position
//   * whale_time_stop:       DTE ≤ 50% of original_dte → close full
//   * whale_trailing_stop:   P&L was ≥ +50% and current_mid is ≤ 70%
//                            of peak_mid → close full
//   * whale_kill_switch:     bot_paused_until in the future → close full
//
// Idempotency via the existing partial unique index on auto_triggers
// (position_id, kind) WHERE status='pending'. Same insert pattern
// PR #1 set up. bot-evaluate-exits inserts pending trigger rows then
// immediately calls bot-place-exit which transitions them to executed.
//
// Whale positions are single-leg long options:
//   strategy_type = 'whale_long_call' | 'whale_long_put'
//   long_strike   = the strike, short_strike NULL
//   entry_debit_per_spread = the ask we paid (per contract)
//   option_price_peak      = trailing-stop reference
//
// Live mid sourced from dxlink_quotes by underlying + strike +
// expiration. Stale-quote guard at 5 min (same as trigger-eval).

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

interface WhaleTailPosition {
  id: string
  user_id: string
  ticker: string
  strategy_type: string
  long_strike: number
  expiration: string
  contracts: number
  contracts_remaining: number
  entry_debit_per_spread: number
  entry_at: string
  option_price_peak: number | null
  status: string
}

const QUOTE_STALE_MS = 5 * 60_000

// Pull live mid for a single option leg from dxlink_quotes.
// Returns null when the row is missing or stale.
async function livePrice(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
  expiration: string,
  optionType: 'C' | 'P',
  strike: number,
): Promise<{ mid: number; updated_at: string } | null> {
  const { data } = await supabase
    .from('dxlink_quotes')
    .select('mid, updated_at')
    .eq('underlying', ticker)
    .eq('kind', 'option')
    .eq('expiration_date', expiration)
    .eq('option_type', optionType)
    .eq('strike', strike)
    .maybeSingle()
  if (!data?.mid || !data.updated_at) return null
  const age = Date.now() - new Date(data.updated_at).getTime()
  if (age > QUOTE_STALE_MS) return null
  return { mid: Number(data.mid), updated_at: data.updated_at }
}

function dteFor(expiration: string, now = new Date()): number {
  const exp = new Date(expiration + 'T16:00:00-04:00').getTime()
  const ms = exp - now.getTime()
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

function originalDte(entryAt: string, expiration: string): number {
  return dteFor(expiration, new Date(entryAt))
}

interface ExitDecision {
  kind: string
  reason: string
  contracts_to_close: number
  market: boolean
}

function evaluateExitRules(
  pos: WhaleTailPosition,
  currentMid: number,
  killSwitchTripped: boolean,
): ExitDecision | null {
  // Kill switch is highest priority — close everything at market
  if (killSwitchTripped) {
    return {
      kind: 'whale_kill_switch',
      reason: 'Bot kill switch is tripped — flatten this position immediately.',
      contracts_to_close: pos.contracts_remaining,
      market: true,
    }
  }

  const entry = Number(pos.entry_debit_per_spread)
  if (!Number.isFinite(entry) || entry <= 0) return null

  const pnlPct = ((currentMid - entry) / entry) * 100

  // Stop loss: -50% closes everything
  if (pnlPct <= -50) {
    return {
      kind: 'whale_stop_50',
      reason: `P&L ${pnlPct.toFixed(0)}% ≤ -50% stop. Closing full position.`,
      contracts_to_close: pos.contracts_remaining,
      market: false,
    }
  }

  // Profit-take 200: scale out 75% of remaining
  if (pnlPct >= 200) {
    return {
      kind: 'whale_profit_take_200',
      reason: `P&L +${pnlPct.toFixed(0)}% ≥ +200% target. Scaling out 75% of remaining, ride the last 25%.`,
      contracts_to_close: Math.ceil(pos.contracts_remaining * 0.75),
      market: false,
    }
  }

  // Profit-take 100: scale out 50% of remaining
  if (pnlPct >= 100) {
    return {
      kind: 'whale_profit_take_100',
      reason: `P&L +${pnlPct.toFixed(0)}% ≥ +100% target. Scaling out 50%, ride the runner.`,
      contracts_to_close: Math.ceil(pos.contracts_remaining * 0.5),
      market: false,
    }
  }

  // Trailing stop: only active once peak ≥ +50% from entry
  const peak = Number(pos.option_price_peak) || entry
  const peakPnlPct = ((peak - entry) / entry) * 100
  if (peakPnlPct >= 50 && peak > 0) {
    const drawdownFromPeak = ((peak - currentMid) / peak) * 100
    if (drawdownFromPeak >= 30) {
      return {
        kind: 'whale_trailing_stop',
        reason: `Trailing stop fired: peak ${peakPnlPct.toFixed(0)}% gain has retraced ${drawdownFromPeak.toFixed(0)}% (≥30% threshold).`,
        contracts_to_close: pos.contracts_remaining,
        market: false,
      }
    }
  }

  // Time stop: 50% of original DTE consumed
  const origDte = originalDte(pos.entry_at, pos.expiration)
  const currentDte = dteFor(pos.expiration)
  if (origDte > 0 && currentDte <= origDte * 0.5) {
    return {
      kind: 'whale_time_stop',
      reason: `Time stop: ${currentDte} DTE remaining of original ${origDte} (≤50%). Theta now dominates.`,
      contracts_to_close: pos.contracts_remaining,
      market: false,
    }
  }

  return null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  const now = new Date()
  let force = false
  try { const b = await req.json(); force = b?.force === true } catch { /* */ }

  if (!isRegularTradingHours(now) && !force) {
    return json({ success: true, rth: false, skipped: 'outside RTH' })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const { data: positions, error: posErr } = await supabase
    .from('open_positions')
    .select('id, user_id, ticker, strategy_type, long_strike, expiration, contracts, contracts_remaining, entry_debit_per_spread, entry_at, option_price_peak, status')
    .eq('status', 'open')
    .in('strategy_type', ['whale_long_call', 'whale_long_put'])
    .returns<WhaleTailPosition[]>()
  if (posErr) {
    return json({ success: false, error: `positions fetch: ${posErr.message}` }, 502)
  }

  const summary = {
    evaluated: 0,
    skipped_stale_quote: 0,
    skipped_idempotent: 0,
    triggers_fired: [] as Array<{ position_id: string; kind: string; reason: string }>,
    exit_orders_submitted: 0,
    exit_orders_failed: 0,
  }

  for (const pos of positions ?? []) {
    summary.evaluated++

    const optionType = pos.strategy_type === 'whale_long_call' ? 'C' : 'P'
    const quote = await livePrice(supabase, pos.ticker, pos.expiration, optionType, Number(pos.long_strike))
    if (!quote) {
      summary.skipped_stale_quote++
      continue
    }

    // Update peak if current mid exceeds it
    const peak = Number(pos.option_price_peak) || Number(pos.entry_debit_per_spread)
    if (quote.mid > peak) {
      await supabase
        .from('open_positions')
        .update({ option_price_peak: quote.mid })
        .eq('id', pos.id)
      pos.option_price_peak = quote.mid
    }

    // Check kill-switch state for this user
    const { data: profile } = await supabase
      .from('profiles')
      .select('bot_paused_until, bot_config')
      .eq('id', pos.user_id)
      .maybeSingle()
    const killSwitchTripped = Boolean(
      profile?.bot_paused_until &&
        new Date(profile.bot_paused_until).getTime() > Date.now(),
    )

    const decision = evaluateExitRules(pos, quote.mid, killSwitchTripped)
    if (!decision) continue

    // Insert auto_triggers row (idempotent on partial unique index)
    const { data: trigger, error: triggerErr } = await supabase
      .from('auto_triggers')
      .insert({
        user_id: pos.user_id,
        position_id: pos.id,
        signal_id: null,
        kind: decision.kind,
        reason: decision.reason,
        proposed_action: {
          position_id: pos.id,
          contracts: decision.contracts_to_close,
          limit_price: Number(quote.mid.toFixed(2)),
          market: decision.market,
        },
        observed: {
          mid_at_trigger: quote.mid,
          entry: Number(pos.entry_debit_per_spread),
          peak: pos.option_price_peak,
          pnl_pct: Number((((quote.mid - Number(pos.entry_debit_per_spread)) / Number(pos.entry_debit_per_spread)) * 100).toFixed(2)),
          contracts_remaining_at_trip: pos.contracts_remaining,
          as_of: quote.updated_at,
        },
      })
      .select('id')
      .maybeSingle()

    if (triggerErr) {
      if (triggerErr.code === '23505') {
        // Already a pending trigger for this (position, kind) — skip
        summary.skipped_idempotent++
        continue
      }
      console.warn('[bot-evaluate-exits] trigger insert failed', triggerErr.message)
      continue
    }
    if (!trigger?.id) continue

    summary.triggers_fired.push({
      position_id: pos.id,
      kind: decision.kind,
      reason: decision.reason,
    })

    // Resolve account number from bot_config (mode-aware)
    const cfg = (profile?.bot_config ?? {}) as { mode?: string; sandbox_account_number?: string | null; live_account_number?: string | null }
    const accountNumber = (cfg.mode === 'live') ? cfg.live_account_number : cfg.sandbox_account_number
    if (!accountNumber) {
      await supabase
        .from('auto_triggers')
        .update({ status: 'failed', execution_result: { error: 'no_account_number' }, resolved_at: new Date().toISOString() })
        .eq('id', trigger.id)
      summary.exit_orders_failed++
      continue
    }

    // Submit the close order
    const exitResp = await fetch(`${SUPABASE_URL}/functions/v1/bot-place-exit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        position_id: pos.id,
        account_number: accountNumber,
        contracts: decision.contracts_to_close,
        limit_price: quote.mid,
        market: decision.market,
        trigger_id: trigger.id,
      }),
    })
    if (exitResp.ok) {
      summary.exit_orders_submitted++
    } else {
      summary.exit_orders_failed++
    }
  }

  return json({ success: true, rth: true, summary })
})
