// bot-execute-entry — orchestrator for autonomous whale-tail entries.
//
// Called by bot-tail-scanner (PR #2) when a UW print passes the
// entry filter. This function is the GATE between "we saw a qualifying
// print" and "we submitted an order":
//
//   1. Service-role auth
//   2. Load whale_tail_alerts row + user profile + bot_config
//   3. Evaluate risk envelope (same checks as botRiskEval.js client-side):
//        - bot enabled? mode set? not halted? not in event-block?
//        - daily loss cap not breached?
//        - weekly loss cap not breached?
//        - max concurrent positions / exposure not exceeded?
//        - max daily trade count not exceeded?
//        - not in consecutive-loss cooldown?
//   4. Size contracts: floor(per_trade_max_loss_dollars / (ask * 100))
//      Skip if even 1 contract exceeds the cap.
//   5. Call bot-place-entry with the sized order
//   6. On success:
//      - Insert auto_triggers row (kind=whale_entry, status=executed)
//      - Insert open_positions row with strategy_type=whale_long_call|put
//      - Update whale_tail_alerts status=tailed, link IDs
//      - Increment bot_runs counters
//   7. On any failure or skip:
//      - Update whale_tail_alerts status accordingly
//      - Update bot_runs trades_attempted regardless
//
// service-role-only. The scanner is the only legitimate caller in
// production; we expose it as a separate function so the scanner
// stays focused on data collection and this function stays focused
// on decision + execution.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildOccSymbol, tastytradeFetch } from './tastytrade.ts'
// (buildOccSymbol + tastytradeFetch imported above)

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

function todayNyDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

function startOfWeekIso(now: Date): string {
  // Monday 00:00 UTC of the current week (approximation; fine for cap math)
  const d = new Date(now)
  const day = d.getUTCDay()
  const diff = (day === 0 ? -6 : 1 - day)
  d.setUTCDate(d.getUTCDate() + diff)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

interface BotConfig {
  enabled?: boolean
  mode?: 'paper' | 'live'
  max_concurrent_positions?: number
  max_concurrent_exposure_pct?: number
  per_trade_max_loss_pct?: number
  max_trades_per_day?: number
  daily_loss_kill_pct?: number
  weekly_loss_kill_pct?: number
  consecutive_loss_pause_count?: number
  consecutive_loss_pause_minutes?: number
  event_block_days?: string[]
  sandbox_account_number?: string | null
  live_account_number?: string | null
}

// Resolve the user's NLV for risk-cap math.
//
//   1. Call Tastytrade /customers/me/accounts via the existing OAuth
//      helper. tastytradeFetch reads its config from Supabase secrets;
//      pulls the same access token used by place-order / close-order.
//   2. For each account that comes back, fetch /accounts/:id/balances
//      and read net-liquidating-value. Pick the largest.
//   3. If the configured base URL is the cert (sandbox) endpoint,
//      ignore the broker NLV — sandbox returns a fake $100K that would
//      mislead 2%-rule-style sizing. Same guard StrikePriceCalculator
//      uses on the client.
//   4. On any failure or sandbox-only case, fall back to
//      profile.account_size. Surface source in the return value so the
//      caller logs which lane fired.
//
// Same architectural shape as get-account, but in-process so the
// service-role bot doesn't have to invoke a JWT-gated edge function.
const TASTYTRADE_BASE = Deno.env.get('TASTYTRADE_BASE_URL') || 'https://api.cert.tastyworks.com'
const IS_SANDBOX = /cert\.tastyworks/.test(TASTYTRADE_BASE)

async function resolveLiveNlv(
  supabase: ReturnType<typeof createClient>,
  fallbackAccountSize: number | null,
): Promise<{ nlv: number; source: 'broker_live' | 'broker_sandbox_skipped' | 'profile_fallback' | 'none' }> {
  const manual = Number(fallbackAccountSize) || 0
  try {
    const accountsResp = await tastytradeFetch(supabase, '/customers/me/accounts')
    if (!accountsResp.ok) {
      return { nlv: manual, source: manual > 0 ? 'profile_fallback' : 'none' }
    }
    const accountsBody = await accountsResp.json().catch(() => ({}))
    const items = ((accountsBody?.data as Record<string, unknown>)?.items ?? []) as Array<{ account?: Record<string, unknown> }>

    // Fetch balances for each account.
    const nlvs: number[] = []
    for (const item of items) {
      const number = String(item.account?.['account-number'] ?? '')
      if (!number) continue
      try {
        const bResp = await tastytradeFetch(
          supabase,
          `/accounts/${encodeURIComponent(number)}/balances`,
        )
        if (!bResp.ok) continue
        const bBody = await bResp.json()
        const v = Number((bBody?.data as Record<string, unknown>)?.['net-liquidating-value'] ?? 0)
        if (Number.isFinite(v) && v > 0) nlvs.push(v)
      } catch { /* per-account failure, skip */ }
    }
    // Sandbox NLV is fake — never size against it.
    if (IS_SANDBOX) {
      return { nlv: manual, source: manual > 0 ? 'broker_sandbox_skipped' : 'none' }
    }
    if (nlvs.length === 0) {
      return { nlv: manual, source: manual > 0 ? 'profile_fallback' : 'none' }
    }
    const liveNlv = Math.max(...nlvs)
    return { nlv: liveNlv, source: 'broker_live' }
  } catch {
    return { nlv: manual, source: manual > 0 ? 'profile_fallback' : 'none' }
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
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON' }, 400) }
  const alertId = body.alert_id ? String(body.alert_id) : null
  if (!alertId) return json({ success: false, error: 'alert_id required' }, 400)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // ── 1. Load alert + profile ────────────────────────────────────
  const { data: alert, error: alertErr } = await supabase
    .from('whale_tail_alerts')
    .select('*')
    .eq('id', alertId)
    .maybeSingle()
  if (alertErr || !alert) {
    return json({ success: false, error: `alert lookup failed: ${alertErr?.message ?? 'not found'}` }, 404)
  }
  if (alert.status !== 'observed' && alert.status !== 'queued') {
    return json({ success: false, error: `alert already processed (status=${alert.status})` }, 409)
  }
  if (!alert.passes_filter) {
    return json({ success: false, error: 'alert did not pass entry filter' }, 400)
  }

  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('id, account_size, bot_config, bot_paused_until, bot_paused_reason')
    .eq('id', alert.user_id)
    .maybeSingle()
  if (profErr || !profile) {
    return json({ success: false, error: 'profile lookup failed' }, 500)
  }

  const config: BotConfig = profile.bot_config ?? {}
  const today = todayNyDate()

  // ── 2. Risk envelope checks ────────────────────────────────────
  async function skip(reason: string, status: string) {
    await supabase
      .from('whale_tail_alerts')
      .update({
        status,
        filter_failures: [...(alert.filter_failures ?? []), reason],
      })
      .eq('id', alertId)
    return json({ success: false, skipped: true, reason })
  }

  if (!config.enabled) return skip('bot_disabled', 'skipped_caps')

  if (profile.bot_paused_until) {
    const until = new Date(profile.bot_paused_until).getTime()
    if (until > Date.now()) return skip(`halted: ${profile.bot_paused_reason ?? 'paused'}`, 'skipped_caps')
  }

  // Resolve NLV from live broker, falling back to profile.account_size
  // only when broker is unreachable or returns sandbox-only data.
  // Same pattern as src/components/StrikePriceCalculator.jsx — paper
  // mode still sizes against REAL NLV (sandbox fills are simulated;
  // sizing has to reflect the actual capital the strategy is being
  // validated against).
  const nlvResult = await resolveLiveNlv(supabase, profile.account_size)
  const nlv = nlvResult.nlv
  if (nlv <= 0) return skip(`no_nlv (${nlvResult.source})`, 'skipped_caps')

  // Today's run row (create if missing)
  const { data: runRow } = await supabase
    .from('bot_runs')
    .select('*')
    .eq('user_id', alert.user_id)
    .eq('run_date', today)
    .maybeSingle()

  const dailyLossCapDollars = nlv * ((config.daily_loss_kill_pct ?? 20) / 100)
  if ((Number(runRow?.daily_pnl) || 0) <= -dailyLossCapDollars) {
    return skip(`daily_loss_cap_hit`, 'skipped_caps')
  }

  // Weekly P&L (sum of bot_runs daily_pnl since Monday)
  const weekStart = startOfWeekIso(new Date()).slice(0, 10)
  const { data: weekRuns } = await supabase
    .from('bot_runs')
    .select('daily_pnl')
    .eq('user_id', alert.user_id)
    .gte('run_date', weekStart)
  const weekPnl = (weekRuns ?? []).reduce((s, r) => s + (Number(r.daily_pnl) || 0), 0)
  const weeklyLossCapDollars = nlv * ((config.weekly_loss_kill_pct ?? 35) / 100)
  if (weekPnl <= -weeklyLossCapDollars) {
    return skip('weekly_loss_cap_hit', 'skipped_caps')
  }

  // Concurrent positions
  const { count: openCount } = await supabase
    .from('open_positions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', alert.user_id)
    .eq('status', 'open')
  if ((openCount ?? 0) >= (config.max_concurrent_positions ?? 3)) {
    return skip('max_concurrent_positions', 'skipped_caps')
  }

  // Trades attempted today
  if ((runRow?.trades_attempted ?? 0) >= (config.max_trades_per_day ?? 3)) {
    return skip('max_trades_per_day', 'skipped_caps')
  }

  // Consecutive losses cooldown
  const { data: recentClosed } = await supabase
    .from('open_positions')
    .select('realized_pnl, closed_at')
    .eq('user_id', alert.user_id)
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(config.consecutive_loss_pause_count ?? 3)
  const recentOutcomes = (recentClosed ?? []).map((r) => Number(r.realized_pnl) < 0 ? 'loss' : 'win')
  if (
    recentOutcomes.length === (config.consecutive_loss_pause_count ?? 3) &&
    recentOutcomes.every((o) => o === 'loss')
  ) {
    const mostRecent = (recentClosed ?? [])[0]?.closed_at
    if (mostRecent) {
      const ageMs = Date.now() - new Date(mostRecent).getTime()
      const cooldownMs = (config.consecutive_loss_pause_minutes ?? 30) * 60_000
      if (ageMs < cooldownMs) return skip('consecutive_loss_cooldown', 'skipped_caps')
    }
  }

  // ── 3. Size contracts ──────────────────────────────────────────
  const perTradeMaxLossDollars = nlv * ((config.per_trade_max_loss_pct ?? 10) / 100)
  const askPrice = Number(alert.ask) || Number(alert.mid) || 0
  if (askPrice <= 0) return skip('no_ask_price', 'skipped_caps')

  const oneContractCost = askPrice * 100
  if (oneContractCost > perTradeMaxLossDollars) {
    return skip(`option_too_expensive (1c=$${oneContractCost.toFixed(0)} > cap=$${perTradeMaxLossDollars.toFixed(0)})`, 'skipped_caps')
  }
  const contracts = Math.min(10, Math.floor(perTradeMaxLossDollars / oneContractCost))

  // ── 4. Select broker account based on mode ─────────────────────
  const accountNumber = (config.mode === 'live')
    ? config.live_account_number
    : config.sandbox_account_number
  if (!accountNumber) {
    return skip(`no_${config.mode ?? 'paper'}_account_configured`, 'skipped_caps')
  }

  // ── 5. Submit the entry order via bot-place-entry ──────────────
  const entryResp = await fetch(`${SUPABASE_URL}/functions/v1/bot-place-entry`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: alert.user_id,
      account_number: accountNumber,
      ticker: alert.ticker,
      option_type: alert.option_type,
      strike: Number(alert.strike),
      expiry: alert.expiry_date,
      contracts,
      limit_price: askPrice,
      alert_id: alertId,
    }),
  })
  const entryBody = await entryResp.json().catch(() => ({}))

  // Bump trades_attempted regardless of outcome
  await supabase.from('bot_runs').upsert(
    {
      user_id: alert.user_id,
      run_date: today,
      mode: config.mode ?? 'paper',
      starting_nlv: nlv,
      trades_attempted: (runRow?.trades_attempted ?? 0) + 1,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,run_date' },
  )

  if (!entryResp.ok || !entryBody.success) {
    await supabase
      .from('whale_tail_alerts')
      .update({ status: 'rejected_broker', filter_failures: [...(alert.filter_failures ?? []), 'broker_rejected'] })
      .eq('id', alertId)
    return json({ success: false, error: 'broker rejected', detail: entryBody }, 502)
  }

  // ── 6. Create the open_positions row + auto_triggers entry log ─
  const occ = buildOccSymbol(alert.ticker, alert.expiry_date, alert.option_type, Number(alert.strike))
  const { data: position, error: posInsertErr } = await supabase
    .from('open_positions')
    .insert({
      user_id: alert.user_id,
      signal_id: null,
      ticker: alert.ticker,
      strategy_type: alert.option_type === 'C' ? 'whale_long_call' : 'whale_long_put',
      long_strike: Number(alert.strike),
      short_strike: null,
      expiration: alert.expiry_date,
      contracts,
      contracts_remaining: contracts,
      long_occ_symbol: occ,
      short_occ_symbol: null,
      entry_debit_per_spread: askPrice,
      entry_at: new Date().toISOString(),
      status: 'open',
      option_price_peak: askPrice,
      source: 'whale_tail_bot',
      broker_order_id: entryBody.order_id ? String(entryBody.order_id) : null,
      thesis: `Whale-tail: tailed UW print ${alert.uw_trade_id} on ${alert.ticker}.`,
    })
    .select('id')
    .maybeSingle()

  if (posInsertErr || !position) {
    return json({ success: false, error: `position insert failed: ${posInsertErr?.message ?? 'unknown'}` }, 500)
  }

  const { data: triggerRow } = await supabase
    .from('auto_triggers')
    .insert({
      user_id: alert.user_id,
      position_id: position.id,
      signal_id: null,
      kind: 'whale_entry',
      reason: `Tailed UW print: ${alert.ticker} ${alert.strike}${alert.option_type} @ $${askPrice.toFixed(2)} × ${contracts} contracts ($${(oneContractCost * contracts).toFixed(0)} risk)`,
      proposed_action: {
        ticker: alert.ticker,
        option_type: alert.option_type,
        strike: Number(alert.strike),
        expiry: alert.expiry_date,
        contracts,
        limit_price: askPrice,
      },
      observed: {
        alert_id: alertId,
        premium_dollars: Number(alert.premium_dollars),
        otm_pct: Number(alert.otm_pct),
        dte: Number(alert.dte),
        vol_oi_ratio: Number(alert.vol_oi_ratio),
        spot_at_print: Number(alert.spot_at_print),
        nlv_at_entry: nlv,
        nlv_source: nlvResult.source,
        per_trade_cap_dollars: perTradeMaxLossDollars,
      },
      status: 'executed',
      execution_result: { order_id: entryBody.order_id, broker_status: entryBody.status },
      approved_at: new Date().toISOString(),
      executed_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle()

  await supabase
    .from('whale_tail_alerts')
    .update({
      status: 'tailed',
      triggered_position_id: position.id,
      triggered_trigger_id: triggerRow?.id ?? null,
      proposed_action: {
        contracts,
        limit_price: askPrice,
        max_loss_dollars: oneContractCost * contracts,
      },
    })
    .eq('id', alertId)

  return json({
    success: true,
    position_id: position.id,
    trigger_id: triggerRow?.id ?? null,
    contracts,
    limit_price: askPrice,
    order_id: entryBody.order_id,
  })
})
