// bot-place-entry — submits a single-leg Buy to Open option order
// to Tastytrade for the autonomous whale-tail bot.
//
// Sibling of place-order (which handles vertical spreads). Separate
// function because the request shape is fundamentally different:
//   * No signal_id (whale-tail entries don't have a parent signal)
//   * Single OCC symbol, single leg, single action
//   * service-role only (no user JWT — bot is autonomous)
//
// Caller: bot-execute-entry orchestrator. This function is the
// thin Tastytrade wrapper; risk-eval and audit logging happen in
// the orchestrator before/after calling here.
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, TASTYTRADE_REFRESH_TOKEN

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildOccSymbol, tastytradeFetch, TastytradeError } from './tastytrade.ts'

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
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const userId = String(body.user_id ?? '')
  const accountNumber = String(body.account_number ?? '')
  const ticker = String(body.ticker ?? '').toUpperCase()
  const optionType = String(body.option_type ?? '') as 'C' | 'P'
  const strike = Number(body.strike)
  const expiry = String(body.expiry ?? '')
  const contracts = Number(body.contracts)
  const limitPrice = Number(body.limit_price)
  const alertId = body.alert_id ? String(body.alert_id) : null

  if (!userId || !accountNumber || !ticker) {
    return json({ success: false, error: 'user_id, account_number, ticker required' }, 400)
  }
  if (optionType !== 'C' && optionType !== 'P') {
    return json({ success: false, error: 'option_type must be C or P' }, 400)
  }
  if (!Number.isFinite(strike) || strike <= 0) {
    return json({ success: false, error: 'invalid strike' }, 400)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return json({ success: false, error: 'expiry must be YYYY-MM-DD' }, 400)
  }
  if (!Number.isFinite(contracts) || contracts < 1) {
    return json({ success: false, error: 'contracts must be >= 1' }, 400)
  }
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
    return json({ success: false, error: 'limit_price must be > 0' }, 400)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const occ = buildOccSymbol(ticker, expiry, optionType, strike)

  const orderPayload = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    'price': limitPrice.toFixed(2),
    'price-effect': 'Debit',
    'legs': [
      {
        'instrument-type': 'Equity Option',
        'symbol': occ,
        'quantity': contracts,
        'action': 'Buy to Open',
      },
    ],
  }

  let orderResp: Response
  try {
    orderResp = await tastytradeFetch(
      supabase,
      `/accounts/${encodeURIComponent(accountNumber)}/orders`,
      { method: 'POST', body: JSON.stringify(orderPayload) },
    )
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    await supabase.from('order_history').insert({
      user_id: userId,
      account_number: accountNumber,
      order_type: 'open',
      action: 'buy_to_open',
      structure: optionType === 'C' ? 'whale_long_call' : 'whale_long_put',
      ticker,
      buy_strike: strike,
      sell_strike: null,
      expiry_date: expiry,
      contracts,
      limit_price: limitPrice,
      status: 'rejected',
      api_response: { error: reason, alert_id: alertId },
      auto_executed: true,
      auto_close_strategy: 'whale_tail',
    })
    return json({ success: false, error: reason }, 502)
  }

  const orderData = await orderResp.json().catch(() => ({}))
  if (!orderResp.ok) {
    await supabase.from('order_history').insert({
      user_id: userId,
      account_number: accountNumber,
      order_type: 'open',
      action: 'buy_to_open',
      structure: optionType === 'C' ? 'whale_long_call' : 'whale_long_put',
      ticker,
      buy_strike: strike,
      sell_strike: null,
      expiry_date: expiry,
      contracts,
      limit_price: limitPrice,
      status: 'rejected',
      api_response: { ...orderData, alert_id: alertId },
      auto_executed: true,
      auto_close_strategy: 'whale_tail',
    })
    return json({ success: false, error: `tastytrade ${orderResp.status}`, detail: orderData }, 502)
  }

  const orderId = orderData?.data?.order?.id ?? null
  const tastytradeStatus = String(orderData?.data?.order?.status ?? 'submitted').toLowerCase()
  const normalisedStatus = ['pending', 'submitted', 'partial_fill', 'filled'].includes(tastytradeStatus)
    ? tastytradeStatus
    : 'submitted'

  const { data: orderRow } = await supabase
    .from('order_history')
    .insert({
      user_id: userId,
      account_number: accountNumber,
      order_type: 'open',
      action: 'buy_to_open',
      structure: optionType === 'C' ? 'whale_long_call' : 'whale_long_put',
      ticker,
      buy_strike: strike,
      sell_strike: null,
      expiry_date: expiry,
      contracts,
      limit_price: limitPrice,
      status: normalisedStatus,
      tastytrade_order_id: orderId ? String(orderId) : null,
      api_response: { ...orderData, alert_id: alertId },
      auto_executed: true,
      auto_close_strategy: 'whale_tail',
    })
    .select('id')
    .maybeSingle()

  return json({
    success: true,
    order_id: orderId,
    order_history_id: orderRow?.id ?? null,
    status: normalisedStatus,
    occ_symbol: occ,
  })
})
