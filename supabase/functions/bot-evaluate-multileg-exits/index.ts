// deploy-trigger: 2026-05-12 (manual workflow nudge)
// bot-evaluate-multileg-exits — autonomous exit engine for 2-leg
// credit verticals and 4-leg iron condors / iron butterflies.
//
// Cron-invoked every 10 min during US RTH. For every open position
// with strategy ∈ {iv_meanrev, earnings_crush, opex_pin}, computes
// the live net debit-to-close from dxlink_quotes and fires
// bot-place-multileg-exit when any of these triggers:
//
//   * profit_take_50    — P&L ≥ +50% of max credit  → close full
//   * profit_take_75    — P&L ≥ +75% of max credit  → close full (OPEX)
//   * stop_2x           — close-debit ≥ 2× entry-credit → close full
//   * time_stop         — DTE ≤ 0 OR (strategy=opex_pin AND past 15:50 ET) → close full
//   * close_open        — strategy=earnings_crush AND tomorrow == expiry → close full at open
//   * kill_switch       — bot_paused_until or strategy.kill_switch true → close full at market
//
// Idempotency: relies on the partial unique index on auto_triggers
// (position_id, kind) WHERE status='pending'.
//
// Multileg pricing: net debit = sum(long_mid) - sum(short_mid)  for an
// inverted close. Open credit at entry was entry_debit_per_spread (we
// stored the per-lot credit in that column). P&L per lot = credit_in - debit_out.
//
// service-role only.

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
  } catch { return null }
}

function isRegularTradingHours(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const weekday = parts.find((p) => p.type === 'weekday')?.value
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const mins = hour * 60 + minute
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}

function nyMinutesNow(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const h = Number(parts.find((p) => p.type === 'hour')?.value)
  const m = Number(parts.find((p) => p.type === 'minute')?.value)
  return h * 60 + m
}

function todayNyDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

const QUOTE_STALE_MS = 5 * 60_000

async function legMid(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
  expiration: string,
  optionType: 'C' | 'P',
  strike: number,
): Promise<number | null> {
  const { data } = await supabase
    .from('dxlink_quotes')
    .select('mid, bid, ask, updated_at')
    .eq('ticker', ticker.toUpperCase())
    .eq('expiration_date', expiration)
    .eq('option_type', optionType)
    .eq('strike', strike)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const age = Date.now() - new Date(data.updated_at as string).getTime()
  if (age > QUOTE_STALE_MS) return null
  const mid = Number(data.mid) || (Number(data.bid) + Number(data.ask)) / 2
  return Number.isFinite(mid) && mid > 0 ? mid : null
}

interface MultilegPosition {
  id: string
  user_id: string
  ticker: string
  strategy: string
  strategy_type: string
  long_strike: number | null         // long put strike (4-leg) or long strike (2-leg debit)
  short_strike: number | null        // short put strike (4-leg) or short strike (2-leg credit)
  short_call_strike: number | null
  long_call_strike: number | null
  expiration: string
  contracts: number
  contracts_remaining: number
  entry_debit_per_spread: number     // For credit structures, this column stores the credit per lot
  entry_at: string
  status: string
}

interface StrategyExitConfig {
  profit_take_pct?: number          // 0.5 = 50%
  stop_loss_multiplier?: number     // 2 = close when debit-to-close = 2× entry credit
  time_stop_dte?: number            // close when DTE <= this
  close_at_minute?: number          // ET minutes-from-midnight to force close (e.g. 15:50 = 950)
  is_credit_structure?: boolean
}

const STRATEGY_EXIT_RULES: Record<string, StrategyExitConfig> = {
  iv_meanrev:     { profit_take_pct: 0.5,  stop_loss_multiplier: 2, time_stop_dte: 7,  is_credit_structure: true },
  earnings_crush: { profit_take_pct: 0.5,  stop_loss_multiplier: 2, time_stop_dte: 0,  is_credit_structure: true },
  opex_pin:       { profit_take_pct: 0.75, stop_loss_multiplier: 2, time_stop_dte: 0, close_at_minute: 950, is_credit_structure: true },
}

const KIND_BY_STRATEGY_AND_TRIGGER: Record<string, Record<string, string>> = {
  iv_meanrev:     { profit: 'meanrev_profit_take_50', stop: 'meanrev_stop_2x',  time: 'meanrev_time_stop' },
  earnings_crush: { profit: 'earnings_profit_take_50', stop: 'earnings_stop_2x', time: 'earnings_close_open' },
  opex_pin:       { profit: 'opex_profit_take_75',    stop: 'opex_stop_2x',     time: 'opex_close_eod' },
}

async function insertTrigger(
  supabase: ReturnType<typeof createClient>,
  position: MultilegPosition,
  kind: string,
  reason: string,
  observed: Record<string, unknown>,
  market = false,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('auto_triggers')
    .insert({
      user_id: position.user_id,
      position_id: position.id,
      kind,
      reason,
      observed,
      proposed_action: {
        position_id: position.id,
        action: 'close_all',
        market,
      },
      status: 'pending',
      approved_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle()
  if (error) {
    if (String(error.message).includes('duplicate')) return null
    console.warn('insertTrigger:', error.message)
    return null
  }
  return data?.id ?? null
}

async function fireExit(
  supabase: ReturnType<typeof createClient>,
  position: MultilegPosition,
  triggerId: string,
  reason: string,
  exitDebit: number,
  market = false,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/bot-place-multileg-exit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        position_id: position.id,
        limit_price: market ? null : exitDebit,
        market,
        reason,
      }),
    })
    const result = await resp.json().catch(() => ({}))
    await supabase
      .from('auto_triggers')
      .update({
        status: result.success ? 'executed' : 'failed',
        executed_at: result.success ? new Date().toISOString() : null,
        resolved_at: new Date().toISOString(),
        execution_result: result,
      })
      .eq('id', triggerId)
  } catch (err) {
    console.error('fireExit failed:', err)
    await supabase
      .from('auto_triggers')
      .update({ status: 'failed', resolved_at: new Date().toISOString(), execution_result: { error: String(err) } })
      .eq('id', triggerId)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  if (!isRegularTradingHours(new Date())) {
    return json({ success: true, skipped: true, reason: 'after_hours' })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const { data: positions } = await supabase
    .from('open_positions')
    .select('*')
    .eq('status', 'open')
    .in('strategy', ['iv_meanrev', 'earnings_crush', 'opex_pin'])

  if (!positions || positions.length === 0) {
    return json({ success: true, evaluated: 0 })
  }

  const today = todayNyDate()
  const nowMin = nyMinutesNow()
  const results: Array<Record<string, unknown>> = []

  // Lookup user → bot_config for kill switches
  const userIds = Array.from(new Set(positions.map((p) => p.user_id)))
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, bot_config, bot_paused_until')
    .in('id', userIds)
  const profileMap = new Map((profiles ?? []).map((p) => [p.id as string, p]))

  for (const pos of positions as MultilegPosition[]) {
    const strategy = pos.strategy
    const rules = STRATEGY_EXIT_RULES[strategy]
    if (!rules) continue

    const profile = profileMap.get(pos.user_id)
    const cfg = (profile?.bot_config ?? {}) as Record<string, unknown>
    const stratCfg = ((cfg.strategies as Record<string, unknown>)?.[strategy] ?? {}) as Record<string, unknown>

    // ── Kill-switch / pause: market exit first, no further evaluation
    const paused = profile?.bot_paused_until && new Date(profile.bot_paused_until as string).getTime() > Date.now()
    if (paused || stratCfg.kill_switch === true) {
      const tid = await insertTrigger(supabase, pos, KIND_BY_STRATEGY_AND_TRIGGER[strategy].stop, 'kill_switch market exit', { strategy, reason: paused ? 'bot_paused' : 'strategy_kill_switch' }, true)
      if (tid) await fireExit(supabase, pos, tid, 'kill_switch', 0, true)
      results.push({ pos: pos.id, action: 'kill_switch' })
      continue
    }

    // ── Compute live close-debit ─────────────────────────────────
    const longP  = Number(pos.long_strike)
    const shortP = Number(pos.short_strike)
    const shortC = Number(pos.short_call_strike)
    const longC  = Number(pos.long_call_strike)
    let exitDebit = 0
    let priceAvailable = true

    // 4-leg structures
    if (longP && shortP && shortC && longC) {
      const lp = await legMid(supabase, pos.ticker, pos.expiration, 'P', longP)
      const sp = await legMid(supabase, pos.ticker, pos.expiration, 'P', shortP)
      const sc = await legMid(supabase, pos.ticker, pos.expiration, 'C', shortC)
      const lc = await legMid(supabase, pos.ticker, pos.expiration, 'C', longC)
      if (lp == null || sp == null || sc == null || lc == null) priceAvailable = false
      else exitDebit = (sp + sc) - (lp + lc)
    }
    // 2-leg credit verticals
    else if (longP && shortP) {
      const lp = await legMid(supabase, pos.ticker, pos.expiration, 'P', longP)
      const sp = await legMid(supabase, pos.ticker, pos.expiration, 'P', shortP)
      if (lp == null || sp == null) priceAvailable = false
      else exitDebit = sp - lp
    }
    else if (shortC && longC) {
      const sc = await legMid(supabase, pos.ticker, pos.expiration, 'C', shortC)
      const lc = await legMid(supabase, pos.ticker, pos.expiration, 'C', longC)
      if (sc == null || lc == null) priceAvailable = false
      else exitDebit = sc - lc
    } else {
      // Unknown structure — skip; let monitor-positions handle.
      continue
    }

    const entryCredit = Math.abs(Number(pos.entry_debit_per_spread)) || 0

    // Update live P&L on position row for UI
    if (priceAvailable && entryCredit > 0) {
      const pnlPerLot = entryCredit - exitDebit
      const pnlPct = (pnlPerLot / entryCredit) * 100
      await supabase
        .from('open_positions')
        .update({
          last_mid_per_spread: exitDebit,
          last_pnl_pct: pnlPct,
          last_polled_at: new Date().toISOString(),
          last_poll_source: 'dxlink',
        })
        .eq('id', pos.id)
    }

    // DTE
    const dte = Math.floor((new Date(pos.expiration + 'T00:00:00Z').getTime() - Date.now()) / 86_400_000)

    // ── Profit take ─────────────────────────────────────────────
    if (priceAvailable && entryCredit > 0 && exitDebit / entryCredit <= 1 - (rules.profit_take_pct ?? 0.5)) {
      const tid = await insertTrigger(
        supabase, pos,
        KIND_BY_STRATEGY_AND_TRIGGER[strategy].profit,
        `profit ${rules.profit_take_pct! * 100}% — close debit $${exitDebit.toFixed(2)} ≤ ${(1 - (rules.profit_take_pct ?? 0.5)).toFixed(2)} × entry credit $${entryCredit.toFixed(2)}`,
        { exit_debit: exitDebit, entry_credit: entryCredit, dte },
      )
      if (tid) {
        await fireExit(supabase, pos, tid, 'profit_take', exitDebit)
        results.push({ pos: pos.id, action: 'profit_take' })
      }
      continue
    }

    // ── Stop loss ───────────────────────────────────────────────
    if (priceAvailable && entryCredit > 0 && exitDebit >= (rules.stop_loss_multiplier ?? 2) * entryCredit) {
      const tid = await insertTrigger(
        supabase, pos,
        KIND_BY_STRATEGY_AND_TRIGGER[strategy].stop,
        `stop ${rules.stop_loss_multiplier}× — close debit $${exitDebit.toFixed(2)} ≥ ${rules.stop_loss_multiplier}× entry $${entryCredit.toFixed(2)}`,
        { exit_debit: exitDebit, entry_credit: entryCredit, dte },
      )
      if (tid) {
        await fireExit(supabase, pos, tid, 'stop_2x', exitDebit)
        results.push({ pos: pos.id, action: 'stop' })
      }
      continue
    }

    // ── Time stops / scheduled close ────────────────────────────
    if (dte <= (rules.time_stop_dte ?? 0)) {
      const tid = await insertTrigger(
        supabase, pos,
        KIND_BY_STRATEGY_AND_TRIGGER[strategy].time,
        `time stop — dte=${dte} ≤ ${rules.time_stop_dte ?? 0}`,
        { exit_debit: exitDebit, dte },
      )
      if (tid) {
        await fireExit(supabase, pos, tid, 'time_stop', exitDebit)
        results.push({ pos: pos.id, action: 'time_stop' })
      }
      continue
    }

    // OPEX EOD close at 15:50 ET
    if (strategy === 'opex_pin' && rules.close_at_minute && nowMin >= rules.close_at_minute && pos.expiration === today) {
      const tid = await insertTrigger(
        supabase, pos,
        KIND_BY_STRATEGY_AND_TRIGGER[strategy].time,
        `opex EOD close — ${nowMin}min ≥ ${rules.close_at_minute}min`,
        { exit_debit: exitDebit, ny_minute: nowMin },
      )
      if (tid) {
        await fireExit(supabase, pos, tid, 'opex_close_eod', exitDebit, true)
        results.push({ pos: pos.id, action: 'opex_close_eod' })
      }
      continue
    }
  }

  return json({ success: true, evaluated: positions.length, actions: results })
})
