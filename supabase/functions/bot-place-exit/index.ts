// bot-place-exit — submits a single-leg Sell to Close order for a
// whale-tail bot position.
//
// Sibling of close-order (which handles vertical spreads). Same
// service-role-only pattern as bot-place-entry. Called by
// bot-evaluate-exits when a whale_* trigger fires (profit-take,
// stop, time-stop, trailing-stop, kill-switch).
//
// Closing logic:
//   * Reads the position from open_positions
//   * Builds OCC symbol from ticker + expiration + option type + strike
//   * Action = Sell to Close, price-effect = Credit (we receive proceeds)
//   * Logs to order_history as order_type='close'
//   * Marks the auto_triggers row 'executed' if trigger_id supplied
//
// monitor-positions handles the fill reconciliation + contracts_remaining
// decrement when the broker confirms the fill (same pattern as the
// spread-close flow).

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

function strategyToOptionType(strategy: string): 'C' | 'P' | null {
  const s = strategy.toLowerCase()
  if (s === 'whale_long_call') return 'C'
  if (s === 'whale_long_put') return 'P'
  return null
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

  const positionId = String(body.position_id ?? '')
  const accountNumber = String(body.account_number ?? '')
  const contracts = Number(body.contracts)
  const limitPrice = Number(body.limit_price)
  const triggerId = body.trigger_id ? String(body.trigger_id) : null
  const useMarket = body.market === true

  if (!positionId || !accountNumber) {
    return json({ success: false, error: 'position_id and account_number required' }, 400)
  }
  if (!Number.isFinite(contracts) || contracts < 1) {
    return json({ success: false, error: 'contracts must be >= 1' }, 400)
  }
  if (!useMarket && (!Number.isFinite(limitPrice) || limitPrice <= 0)) {
    return json({ success: false, error: 'limit_price required for non-market orders' }, 400)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const { data: pos, error: posErr } = await supabase
    .from('open_positions')
    .select('id, user_id, ticker, strategy_type, long_strike, expiration, contracts_remaining, status, long_occ_symbol')
    .eq('id', positionId)
    .maybeSingle()
  if (posErr) {
    return json({ success: false, error: `position lookup failed: ${posErr.message}` }, 500)
  }
  if (!pos) {
    return json({ success: false, error: 'position not found' }, 404)
  }
  if (pos.status !== 'open') {
    return json({ success: false, error: `position is not open (status=${pos.status})` }, 400)
  }
  if (contracts > pos.contracts_remaining) {
    return json(
      { success: false, error: `contracts (${contracts}) exceeds remaining (${pos.contracts_remaining})` },
      400,
    )
  }

  const optionType = strategyToOptionType(pos.strategy_type)
  if (!optionType) {
    return json({ success: false, error: `not a whale-tail position (strategy=${pos.strategy_type})` }, 400)
  }

  // Refuse a second close while one is in flight
  const { data: existingClose } = await supabase
    .from('order_history')
    .select('id, status')
    .eq('position_id', positionId)
    .eq('order_type', 'close')
    .in('status', ['pending', 'submitted', 'partial_fill'])
    .limit(1)
  if ((existingClose?.length ?? 0) > 0) {
    return json(
      { success: false, error: 'a close order is already in flight', existing: existingClose?.[0] },
      409,
    )
  }

  const occ = pos.long_occ_symbol
    || buildOccSymbol(pos.ticker, pos.expiration, optionType, Number(pos.long_strike))

  const orderPayload: Record<string, unknown> = {
    'order-type': useMarket ? 'Market' : 'Limit',
    'time-in-force': 'Day',
    'price-effect': 'Credit',
    'legs': [
      {
        'instrument-type': 'Equity Option',
        'symbol': occ,
        'quantity': contracts,
        'action': 'Sell to Close',
      },
    ],
  }
  if (!useMarket) orderPayload.price = limitPrice.toFixed(2)

  async function markTrigger(status: 'approved' | 'executed' | 'failed', result: unknown) {
    if (!triggerId) return
    const now = new Date().toISOString()
    const update: Record<string, unknown> = { status, execution_result: result }
    if (status === 'approved') update.approved_at = now
    if (status === 'executed') {
      update.executed_at = now
      update.resolved_at = now
    }
    if (status === 'failed') update.resolved_at = now
    await supabase.from('auto_triggers').update(update).eq('id', triggerId)
  }

  let orderResp: Response
  try {
    await markTrigger('approved', { stage: 'submitting' })
    orderResp = await tastytradeFetch(
      supabase,
      `/accounts/${encodeURIComponent(accountNumber)}/orders`,
      { method: 'POST', body: JSON.stringify(orderPayload) },
    )
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    await supabase.from('order_history').insert({
      position_id: positionId,
      user_id: pos.user_id,
      account_number: accountNumber,
      order_type: 'close',
      action: 'sell_to_close',
      structure: pos.strategy_type,
      ticker: pos.ticker,
      buy_strike: null,
      sell_strike: Number(pos.long_strike),
      expiry_date: pos.expiration,
      contracts,
      limit_price: useMarket ? null : limitPrice,
      status: 'rejected',
      api_response: { error: reason },
      auto_executed: true,
      auto_close_strategy: 'whale_tail',
    })
    await markTrigger('failed', { error: reason })
    return json({ success: false, error: reason }, 502)
  }

  const orderData = await orderResp.json().catch(() => ({}))
  if (!orderResp.ok) {
    await supabase.from('order_history').insert({
      position_id: positionId,
      user_id: pos.user_id,
      account_number: accountNumber,
      order_type: 'close',
      action: 'sell_to_close',
      structure: pos.strategy_type,
      ticker: pos.ticker,
      buy_strike: null,
      sell_strike: Number(pos.long_strike),
      expiry_date: pos.expiration,
      contracts,
      limit_price: useMarket ? null : limitPrice,
      status: 'rejected',
      api_response: orderData,
      auto_executed: true,
      auto_close_strategy: 'whale_tail',
    })
    await markTrigger('failed', { tastytrade_status: orderResp.status, detail: orderData })
    return json({ success: false, error: `tastytrade ${orderResp.status}`, detail: orderData }, 502)
  }

  const orderId = orderData?.data?.order?.id ?? null
  const tastytradeStatus = String(orderData?.data?.order?.status ?? 'submitted').toLowerCase()
  const normalisedStatus = ['pending', 'submitted', 'partial_fill', 'filled'].includes(tastytradeStatus)
    ? tastytradeStatus
    : 'submitted'

  await supabase.from('order_history').insert({
    position_id: positionId,
    user_id: pos.user_id,
    account_number: accountNumber,
    order_type: 'close',
    action: 'sell_to_close',
    structure: pos.strategy_type,
    ticker: pos.ticker,
    buy_strike: null,
    sell_strike: Number(pos.long_strike),
    expiry_date: pos.expiration,
    contracts,
    limit_price: useMarket ? null : limitPrice,
    status: normalisedStatus,
    tastytrade_order_id: orderId ? String(orderId) : null,
    api_response: orderData,
    auto_executed: true,
    auto_close_strategy: 'whale_tail',
  })

  await markTrigger('executed', { order_id: orderId, status: normalisedStatus })

  return json({
    success: true,
    order_id: orderId,
    status: normalisedStatus,
    trigger_id: triggerId,
  })
})
