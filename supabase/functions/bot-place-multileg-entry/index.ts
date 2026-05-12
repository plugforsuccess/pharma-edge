// deploy-trigger: 2026-05-12 (manual workflow nudge)
// bot-place-multileg-entry — submit a 2-leg or 4-leg opening order
// to Tastytrade for IV mean-reversion, earnings IV crush, and OPEX
// pin strategies.
//
// Sibling of bot-place-entry (single-leg whale-tail). Separate function
// because the leg array is structure-dependent; centralising the leg
// construction in _shared/multileg.ts keeps strategies thin.
//
// service-role only. Caller is the per-strategy orchestrator
// (bot-execute-multileg-entry).
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, TASTYTRADE_REFRESH_TOKEN

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tastytradeFetch, TastytradeError, type TtEnv } from '../_shared/tastytrade.ts'
import { buildLegs, validatePrice, type StructureKind } from '../_shared/multileg.ts'

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

  const userId = String(body.user_id ?? '')
  const accountNumber = String(body.account_number ?? '')
  // Env defaults to 'live' for back-compat with any caller that still
  // omits the field. New bot orchestrators always pass it explicitly
  // (derived from bot_config.mode).
  const env = (String(body.env ?? 'live') === 'cert' ? 'cert' : 'live') as TtEnv
  const strategy = String(body.strategy ?? '')
  const structureKind = String(body.structure ?? '') as StructureKind
  const ticker = String(body.ticker ?? '').toUpperCase()
  const expiry = String(body.expiry ?? '')
  const contracts = Number(body.contracts)
  const limitPrice = Number(body.limit_price)
  const maxRiskPerLot = Number(body.max_risk_per_lot)
  const signalId = body.signal_id ? String(body.signal_id) : null

  if (!userId || !accountNumber || !strategy || !structureKind) {
    return json({ success: false, error: 'user_id, account_number, strategy, structure required' }, 400)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return json({ success: false, error: 'expiry YYYY-MM-DD' }, 400)
  if (!Number.isFinite(contracts) || contracts < 1) return json({ success: false, error: 'contracts >= 1' }, 400)

  let legSpec
  try {
    legSpec = buildLegs(
      {
        kind: structureKind,
        ticker,
        expiry,
        long_put_strike:   Number(body.long_put_strike)   || undefined,
        short_put_strike:  Number(body.short_put_strike)  || undefined,
        short_call_strike: Number(body.short_call_strike) || undefined,
        long_call_strike:  Number(body.long_call_strike)  || undefined,
        long_strike:       Number(body.long_strike)       || undefined,
        short_strike:      Number(body.short_strike)      || undefined,
      },
      contracts,
      false,
    )
  } catch (err) {
    return json({ success: false, error: `leg build failed: ${(err as Error).message}` }, 400)
  }

  const priceCheck = validatePrice(legSpec.priceEffect, limitPrice, maxRiskPerLot || Number.MAX_SAFE_INTEGER)
  if (!priceCheck.ok) return json({ success: false, error: priceCheck.reason }, 400)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const orderPayload = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    'price': limitPrice.toFixed(2),
    'price-effect': legSpec.priceEffect,
    'legs': legSpec.legs,
  }

  // Map structure → order_history.structure (existing column accepts free text)
  const actionForHistory = legSpec.priceEffect === 'Debit' ? 'buy_to_open' : 'sell_to_open'

  let orderResp: Response
  try {
    orderResp = await tastytradeFetch(
      supabase,
      `/accounts/${encodeURIComponent(accountNumber)}/orders`,
      { method: 'POST', body: JSON.stringify(orderPayload) },
      env,
    )
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    await supabase.from('order_history').insert({
      user_id: userId,
      account_number: accountNumber,
      order_type: 'open',
      action: actionForHistory,
      structure: structureKind,
      ticker,
      buy_strike: null,
      sell_strike: null,
      expiry_date: expiry,
      contracts,
      limit_price: limitPrice,
      status: 'rejected',
      api_response: { error: reason, strategy, signal_id: signalId, legs: legSpec.legs },
      auto_executed: true,
      auto_close_strategy: strategy,
      env,
    })
    return json({ success: false, error: reason }, 502)
  }

  const orderData = await orderResp.json().catch(() => ({}))
  if (!orderResp.ok) {
    await supabase.from('order_history').insert({
      user_id: userId,
      account_number: accountNumber,
      order_type: 'open',
      action: actionForHistory,
      structure: structureKind,
      ticker,
      buy_strike: null,
      sell_strike: null,
      expiry_date: expiry,
      contracts,
      limit_price: limitPrice,
      status: 'rejected',
      api_response: { ...orderData, strategy, signal_id: signalId, legs: legSpec.legs },
      auto_executed: true,
      auto_close_strategy: strategy,
      env,
    })
    return json({ success: false, error: `tastytrade ${orderResp.status}`, detail: orderData }, 502)
  }

  const orderId = orderData?.data?.order?.id ?? null
  const tastytradeStatus = String(orderData?.data?.order?.status ?? 'submitted').toLowerCase()
  const normalisedStatus = ['pending', 'submitted', 'partial_fill', 'filled'].includes(tastytradeStatus)
    ? tastytradeStatus : 'submitted'

  const { data: orderRow } = await supabase
    .from('order_history')
    .insert({
      user_id: userId,
      account_number: accountNumber,
      order_type: 'open',
      action: actionForHistory,
      structure: structureKind,
      ticker,
      buy_strike: null,
      sell_strike: null,
      expiry_date: expiry,
      contracts,
      limit_price: limitPrice,
      status: normalisedStatus,
      tastytrade_order_id: orderId ? String(orderId) : null,
      api_response: { ...orderData, strategy, signal_id: signalId, legs: legSpec.legs },
      auto_executed: true,
      auto_close_strategy: strategy,
      env,
    })
    .select('id')
    .maybeSingle()

  return json({
    success: true,
    order_id: orderId,
    order_history_id: orderRow?.id ?? null,
    status: normalisedStatus,
    price_effect: legSpec.priceEffect,
    legs: legSpec.legs.map((l) => l.symbol),
  })
})
