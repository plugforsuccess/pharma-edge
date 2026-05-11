// Cash Moves — close-order edge function.
//
// Closes an OPEN position via Tastytrade. Sister to place-order:
// validates the caller's JWT, derives user_id from the verified
// token, validates that the position belongs to the user and is
// still open, refuses a second close while one is in flight, then
// submits a multi-leg LIMIT order with `price-effect: Credit`.
//
// Logs to order_history with action='sell_to_close'. If the request
// references an auto_triggers row (trigger_id in the body), marks
// that trigger as executed/failed when the broker call resolves.
//
// Required Supabase secrets:
//   TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, TASTYTRADE_REFRESH_TOKEN
//   (optionally TASTYTRADE_BASE_URL — defaults to api.cert.tastyworks.com)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildOccSymbol, tastytradeFetch, TastytradeError } from './tastytrade.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
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

// Map our strategy_type values to option-side + price-effect. For
// debit spreads (bull_call / bear_put) we received nothing at entry
// and paid a debit; closing returns a credit. For credit spreads
// (bull_put_credit / bear_call_credit) we received credit at entry;
// closing pays a debit (positive cost) — flip the price-effect.
function strategyMeta(strategy: string) {
  const s = strategy.toLowerCase()
  if (s === 'bull_call_spread') return { optionType: 'C', closeEffect: 'Credit', isDebit: true }
  if (s === 'bear_put_spread')  return { optionType: 'P', closeEffect: 'Credit', isDebit: true }
  if (s === 'bull_put_credit')  return { optionType: 'P', closeEffect: 'Debit',  isDebit: false }
  if (s === 'bear_call_credit') return { optionType: 'C', closeEffect: 'Debit',  isDebit: false }
  return null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  // Auth: validated JWT only, never trust the body.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const positionId = body.position_id ? String(body.position_id) : null
  const accountNumber = body.account_number ? String(body.account_number) : null
  const contracts = Number(body.contracts)
  const limitPrice = Number(body.limit_price)
  const triggerId = body.trigger_id ? String(body.trigger_id) : null

  if (!positionId || !accountNumber) {
    return json({ success: false, error: 'position_id and account_number required' }, 400)
  }
  if (!Number.isFinite(contracts) || contracts < 1) {
    return json({ success: false, error: 'contracts must be >= 1' }, 400)
  }
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
    return json({ success: false, error: 'limit_price must be > 0' }, 400)
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Validate ownership + that it's still open.
  const { data: pos, error: posErr } = await adminClient
    .from('open_positions')
    .select('id, user_id, signal_id, ticker, strategy_type, long_strike, short_strike, expiration, contracts, status, long_occ_symbol, short_occ_symbol')
    .eq('id', positionId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (posErr) {
    return json({ success: false, error: `position lookup failed: ${posErr.message}` }, 500)
  }
  if (!pos) {
    return json({ success: false, error: 'position not found for user' }, 404)
  }
  if (pos.status !== 'open') {
    return json({ success: false, error: `position is not open (status=${pos.status})` }, 400)
  }
  if (contracts > pos.contracts) {
    return json({ success: false, error: `contracts (${contracts}) exceeds position size (${pos.contracts})` }, 400)
  }

  const meta = strategyMeta(pos.strategy_type)
  if (!meta) {
    return json({ success: false, error: `unsupported strategy_type: ${pos.strategy_type}` }, 400)
  }

  // Idempotency: refuse a second close while one is already in flight.
  const { data: existingClose } = await adminClient
    .from('order_history')
    .select('id, status')
    .eq('position_id', positionId)
    .eq('order_type', 'close')
    .in('status', ['pending', 'submitted', 'partial_fill'])
    .limit(1)
  if ((existingClose?.length ?? 0) > 0) {
    return json(
      { success: false, error: 'a close order is already in flight for this position', existing: existingClose?.[0] },
      409,
    )
  }

  // Build the close legs. For a debit spread the long leg becomes
  // Sell to Close and the short leg becomes Buy to Close. For a
  // credit spread the directions invert (we were short the long
  // leg's strike, etc.) — handled via the optionType + leg actions
  // below. price-effect is set per strategyMeta.
  //
  // long_strike / short_strike fields on open_positions are
  // canonical: "long" = the strike we are NET LONG on, "short" = NET
  // SHORT, regardless of debit/credit direction. So closing always
  // means selling our long leg + buying back our short leg.
  const longSym = pos.long_occ_symbol
    || buildOccSymbol(pos.ticker, pos.expiration, meta.optionType, Number(pos.long_strike))
  const shortSym = pos.short_occ_symbol
    || buildOccSymbol(pos.ticker, pos.expiration, meta.optionType, Number(pos.short_strike))

  const orderPayload = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    'price': limitPrice.toFixed(2),
    'price-effect': meta.closeEffect,
    'legs': [
      { 'instrument-type': 'Equity Option', 'symbol': longSym,  'quantity': contracts, 'action': 'Sell to Close' },
      { 'instrument-type': 'Equity Option', 'symbol': shortSym, 'quantity': contracts, 'action': 'Buy to Close'  },
    ],
  }

  // Helper to mark the trigger row when one is in play. Best-effort —
  // a failure to update the trigger should not fail the order call.
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
    await adminClient.from('auto_triggers')
      .update(update)
      .eq('id', triggerId)
      .eq('user_id', user.id)
  }

  let orderResp: Response
  try {
    await markTrigger('approved', { stage: 'submitting' })
    orderResp = await tastytradeFetch(
      adminClient,
      `/accounts/${encodeURIComponent(accountNumber)}/orders`,
      { method: 'POST', body: JSON.stringify(orderPayload) },
    )
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    await adminClient.from('order_history').insert({
      position_id: positionId,
      signal_id: pos.signal_id,
      user_id: user.id,
      account_number: accountNumber,
      order_type: 'close',
      action: 'sell_to_close',
      structure: pos.strategy_type,
      ticker: pos.ticker,
      buy_strike: Number(pos.short_strike),
      sell_strike: Number(pos.long_strike),
      expiry_date: pos.expiration,
      contracts,
      limit_price: limitPrice,
      status: 'rejected',
      api_response: { error: reason },
    })
    await markTrigger('failed', { error: reason })
    return json({ success: false, error: reason }, 502)
  }

  const orderData = await orderResp.json().catch(() => ({}))

  if (!orderResp.ok) {
    await adminClient.from('order_history').insert({
      position_id: positionId,
      signal_id: pos.signal_id,
      user_id: user.id,
      account_number: accountNumber,
      order_type: 'close',
      action: 'sell_to_close',
      structure: pos.strategy_type,
      ticker: pos.ticker,
      buy_strike: Number(pos.short_strike),
      sell_strike: Number(pos.long_strike),
      expiry_date: pos.expiration,
      contracts,
      limit_price: limitPrice,
      status: 'rejected',
      api_response: orderData,
    })
    await markTrigger('failed', { tastytrade_status: orderResp.status, detail: orderData })
    return json(
      { success: false, error: `tastytrade ${orderResp.status}`, detail: orderData },
      502,
    )
  }

  const orderId = orderData?.data?.order?.id ?? null
  const tastytradeStatus = String(
    orderData?.data?.order?.status ?? 'submitted',
  ).toLowerCase()
  const normalisedStatus = ['pending', 'submitted', 'partial_fill', 'filled'].includes(tastytradeStatus)
    ? tastytradeStatus
    : 'submitted'

  await adminClient.from('order_history').insert({
    position_id: positionId,
    signal_id: pos.signal_id,
    user_id: user.id,
    account_number: accountNumber,
    order_type: 'close',
    action: 'sell_to_close',
    structure: pos.strategy_type,
    ticker: pos.ticker,
    buy_strike: Number(pos.short_strike),
    sell_strike: Number(pos.long_strike),
    expiry_date: pos.expiration,
    contracts,
    limit_price: limitPrice,
    status: normalisedStatus,
    tastytrade_order_id: orderId ? String(orderId) : null,
    api_response: orderData,
  })

  await markTrigger('executed', { order_id: orderId, status: normalisedStatus })

  return json({
    success: true,
    order_id: orderId,
    status: normalisedStatus,
    trigger_id: triggerId,
  })
})
