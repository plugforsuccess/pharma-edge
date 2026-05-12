// bot-execute-multileg-entry — orchestrator for non-whale strategies.
//
// Called by each strategy scanner (bot-scan-iv-meanrev,
// bot-scan-earnings, bot-scan-opex) once they've inserted a
// bot_signals row. This function is the GATE between "we detected a
// qualifying setup" and "we submitted an order":
//
//   1. service-role auth
//   2. Load bot_signals row + user profile + bot_config
//   3. Risk envelope (shared risk_gate.ts):
//        bot enabled, mode set, not halted, strategy enabled,
//        not in kill switch, daily/weekly loss caps not breached,
//        concurrent positions cap not exceeded, max trades/day not
//        exceeded, not in consecutive-loss cooldown
//   4. Size contracts vs per_trade_max_loss_pct cap AND strategy
//      allocation cap (strategy_caps in bot_config)
//   5. Call bot-place-multileg-entry with the sized order
//   6. On success: insert open_positions row, insert auto_triggers
//      "*_entry" row, update bot_signals.status='tailed'
//   7. On failure / skip: update bot_signals accordingly
//
// service-role only. Dry-run mode logs the would-be order to
// auto_triggers (status='dry_run') without calling the broker.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { evaluateRisk, strategyOpenExposure, type Profile } from '../_shared/risk_gate.ts'

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

function todayNyDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

// Map strategy → auto_triggers entry kind + open_positions source.
const STRATEGY_META: Record<string, { entryKind: string; positionSource: string }> = {
  iv_meanrev:     { entryKind: 'meanrev_entry', positionSource: 'iv_meanrev_bot' },
  earnings_crush: { entryKind: 'earnings_entry', positionSource: 'earnings_crush_bot' },
  opex_pin:       { entryKind: 'opex_entry', positionSource: 'opex_pin_bot' },
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

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON' }, 400) }
  const signalId = body.signal_id ? String(body.signal_id) : null
  if (!signalId) return json({ success: false, error: 'signal_id required' }, 400)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // ── 1. Load signal + profile ──────────────────────────────────
  const { data: signal } = await supabase
    .from('bot_signals')
    .select('*')
    .eq('id', signalId)
    .maybeSingle()
  if (!signal) return json({ success: false, error: 'signal not found' }, 404)
  if (signal.status !== 'observed' && signal.status !== 'queued') {
    return json({ success: false, error: `signal already processed (${signal.status})` }, 409)
  }
  if (!signal.passes_filter) return json({ success: false, error: 'signal did not pass filter' }, 400)

  const strategy = signal.strategy as string
  const meta = STRATEGY_META[strategy]
  if (!meta) return json({ success: false, error: `unknown strategy ${strategy}` }, 400)

  const { data: profileData } = await supabase
    .from('profiles')
    .select('id, account_size, bot_config, bot_paused_until, bot_paused_reason')
    .eq('id', signal.user_id)
    .maybeSingle()
  if (!profileData) return json({ success: false, error: 'profile not found' }, 500)
  const profile = profileData as Profile

  // ── 2. Risk envelope ──────────────────────────────────────────
  async function skip(reason: string, status: 'skipped_caps' | 'skipped_filter' = 'skipped_caps') {
    await supabase
      .from('bot_signals')
      .update({
        status,
        filter_failures: [...(signal.filter_failures ?? []), reason],
      })
      .eq('id', signalId)
    return json({ success: false, skipped: true, reason })
  }

  const risk = await evaluateRisk(supabase, profile, strategy)
  if (!risk.allowed) return skip(risk.skipReason ?? 'risk_denied', risk.status ?? 'skipped_caps')

  // Strategy-level allocation cap
  const stratExposureNow = await strategyOpenExposure(supabase, profile.id, strategy)
  if (stratExposureNow >= risk.strategy_cap_dollars) {
    return skip(`strategy_cap_hit (${strategy}: $${stratExposureNow.toFixed(0)} >= $${risk.strategy_cap_dollars.toFixed(0)})`)
  }

  // ── 3. Size contracts ─────────────────────────────────────────
  const maxLossPerLot = Number(signal.max_loss_per_lot) || 0
  if (maxLossPerLot <= 0) return skip('signal missing max_loss_per_lot')
  const perLotDollars = maxLossPerLot * 100

  const headroomDollars = Math.min(
    risk.per_trade_cap_dollars,
    risk.strategy_cap_dollars - stratExposureNow,
  )
  if (perLotDollars > headroomDollars) {
    return skip(`structure_too_expensive (1lot=$${perLotDollars.toFixed(0)} > headroom=$${headroomDollars.toFixed(0)})`)
  }
  const contracts = Math.min(10, Math.max(1, Math.floor(headroomDollars / perLotDollars)))

  // ── 4. Dry-run short-circuit ──────────────────────────────────
  if (profile.bot_config.dry_run === true) {
    const { data: tr } = await supabase
      .from('auto_triggers')
      .insert({
        user_id: profile.id,
        position_id: null,
        signal_id: null,
        kind: meta.entryKind,
        reason: `DRY-RUN ${strategy}: would have entered ${signal.structure} ${signal.ticker} ${signal.expiry_date} × ${contracts}`,
        proposed_action: {
          strategy,
          structure: signal.structure,
          ticker: signal.ticker,
          expiry: signal.expiry_date,
          long_put_strike: signal.long_put_strike,
          short_put_strike: signal.short_put_strike,
          short_call_strike: signal.short_call_strike,
          long_call_strike: signal.long_call_strike,
          contracts,
          limit_price: signal.net_credit_per_lot,
          max_risk_per_lot: maxLossPerLot,
        },
        observed: {
          signal_id: signalId,
          dry_run: true,
          regime: signal.regime,
          iv_percentile: signal.iv_percentile,
          ev_edge: signal.ev_edge,
          reward_risk_ratio: signal.reward_risk_ratio,
          nlv_at_entry: risk.nlv,
          nlv_source: risk.nlv_source,
        },
        status: 'dry_run',
        approved_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
      })
      .select('id')
      .maybeSingle()
    await supabase
      .from('bot_signals')
      .update({ status: 'tailed', triggered_trigger_id: tr?.id ?? null })
      .eq('id', signalId)
    return json({ success: true, dry_run: true, trigger_id: tr?.id ?? null, contracts })
  }

  // ── 5. Submit via bot-place-multileg-entry ────────────────────
  const isCreditStructure = signal.structure !== 'BULL_CALL' && signal.structure !== 'BEAR_PUT'
  const limitPrice = isCreditStructure ? Number(signal.net_credit_per_lot) : Number(signal.max_loss_per_lot)

  const placeResp = await fetch(`${SUPABASE_URL}/functions/v1/bot-place-multileg-entry`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: profile.id,
      account_number: risk.account_number,
      strategy,
      structure: signal.structure,
      ticker: signal.ticker,
      expiry: signal.expiry_date,
      long_put_strike: signal.long_put_strike,
      short_put_strike: signal.short_put_strike,
      short_call_strike: signal.short_call_strike,
      long_call_strike: signal.long_call_strike,
      contracts,
      limit_price: limitPrice,
      max_risk_per_lot: maxLossPerLot,
      signal_id: signalId,
    }),
  })
  const placeBody = await placeResp.json().catch(() => ({}))

  // Always bump trades_attempted with strategy breakdown
  const today = todayNyDate()
  const { data: prevRun } = await supabase
    .from('bot_runs')
    .select('strategy_breakdown, trades_attempted')
    .eq('user_id', profile.id)
    .eq('run_date', today)
    .maybeSingle()
  const prevBreakdown = (prevRun?.strategy_breakdown ?? {}) as Record<string, Record<string, number>>
  const stratRow = prevBreakdown[strategy] ?? { attempted: 0, filled: 0, wins: 0, losses: 0, pnl: 0 }
  stratRow.attempted = (Number(stratRow.attempted) || 0) + 1
  prevBreakdown[strategy] = stratRow
  await supabase.from('bot_runs').upsert(
    {
      user_id: profile.id,
      run_date: today,
      mode: profile.bot_config.mode ?? 'paper',
      starting_nlv: risk.nlv,
      trades_attempted: (prevRun?.trades_attempted ?? 0) + 1,
      strategy_breakdown: prevBreakdown,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,run_date' },
  )

  if (!placeResp.ok || !placeBody.success) {
    await supabase
      .from('bot_signals')
      .update({ status: 'rejected_broker', filter_failures: [...(signal.filter_failures ?? []), 'broker_rejected'] })
      .eq('id', signalId)
    return json({ success: false, error: 'broker rejected', detail: placeBody }, 502)
  }

  // ── 6. Insert open_positions + auto_triggers ──────────────────
  const { data: position } = await supabase
    .from('open_positions')
    .insert({
      user_id: profile.id,
      signal_id: null,
      ticker: signal.ticker,
      strategy: strategy,
      strategy_type: signal.structure,
      long_strike: signal.long_put_strike,
      short_strike: signal.short_put_strike,
      short_call_strike: signal.short_call_strike,
      long_call_strike: signal.long_call_strike,
      expiration: signal.expiry_date,
      contracts,
      contracts_remaining: contracts,
      entry_debit_per_spread: limitPrice,
      entry_at: new Date().toISOString(),
      status: 'open',
      source: meta.positionSource,
      broker_order_id: placeBody.order_id ? String(placeBody.order_id) : null,
      thesis: `${strategy}: ${signal.structure} ${signal.ticker} ${signal.expiry_date} (regime ${signal.regime ?? '?'}, IV%ile ${signal.iv_percentile ?? '?'})`,
    })
    .select('id')
    .maybeSingle()

  if (!position) {
    return json({ success: false, error: 'position insert failed' }, 500)
  }

  const { data: triggerRow } = await supabase
    .from('auto_triggers')
    .insert({
      user_id: profile.id,
      position_id: position.id,
      signal_id: null,
      kind: meta.entryKind,
      reason: `Strategy ${strategy}: ${signal.structure} ${signal.ticker} @ $${limitPrice.toFixed(2)} × ${contracts}`,
      proposed_action: {
        strategy, structure: signal.structure,
        contracts, limit_price: limitPrice,
        long_put_strike: signal.long_put_strike,
        short_put_strike: signal.short_put_strike,
        short_call_strike: signal.short_call_strike,
        long_call_strike: signal.long_call_strike,
      },
      observed: {
        signal_id: signalId,
        regime: signal.regime,
        iv_percentile: signal.iv_percentile,
        ev_edge: signal.ev_edge,
        reward_risk_ratio: signal.reward_risk_ratio,
        nlv_at_entry: risk.nlv,
        nlv_source: risk.nlv_source,
        per_trade_cap_dollars: risk.per_trade_cap_dollars,
        strategy_cap_dollars: risk.strategy_cap_dollars,
        strategy_exposure_pre: stratExposureNow,
      },
      status: 'executed',
      execution_result: { order_id: placeBody.order_id, broker_status: placeBody.status },
      approved_at: new Date().toISOString(),
      executed_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle()

  await supabase
    .from('bot_signals')
    .update({
      status: 'tailed',
      triggered_position_id: position.id,
      triggered_trigger_id: triggerRow?.id ?? null,
    })
    .eq('id', signalId)

  return json({
    success: true,
    position_id: position.id,
    trigger_id: triggerRow?.id ?? null,
    contracts,
    limit_price: limitPrice,
    order_id: placeBody.order_id,
  })
})
