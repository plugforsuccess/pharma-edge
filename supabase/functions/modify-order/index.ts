// Cash Moves — modify-order edge function.
//
// Updates the limit price on a working Tastytrade order. Used by the
// PositionDetail "Edit bracket" modal to nudge a stop trigger or
// adjust a profit-target limit without cancelling + re-placing.
//
// Tastytrade endpoint: PUT /accounts/:n/orders/:id replaces the
// order's mutable fields (price, time_in_force, etc.). The leg array
// is preserved as-is — we only modify the order-level price.
//
// Auth: requires a real user JWT (verify_jwt=true). Caller must
// supply signal_id; we verify the JWT user owns that signal AND that
// the (account_number, order_id) we're about to PUT to belongs to
// the same signal's broker account. Two checks because the order_id
// alone is not user-scoped.
//
// Logged to order_history with order_type='modify' so the admin
// audit trail captures every broker write originating from this app.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tastytradeFetch, TastytradeError } from './tastytrade.ts'

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

// Tastytrade order leg shape we need to echo back on PUT. The broker
// requires the full leg list even when only price changes.
interface OrderLegEcho {
  'instrument-type': string
  symbol: string
  quantity: number | string
  action: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ success: false, error: 'unauthorized' }, 401)

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON body' }, 400) }
  const signalId = String(body.signal_id ?? '').trim()
  const orderId = String(body.order_id ?? '').trim()
  const newPriceRaw = body.new_price
  if (!signalId || !orderId) {
    return json({ success: false, error: 'signal_id and order_id required' }, 400)
  }
  const newPrice = Number(newPriceRaw)
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    return json({ success: false, error: 'new_price must be a positive number' }, 400)
  }

  // Ownership: the JWT user must own the signal, and the signal must
  // be linked to a broker account. Both checks gate the broker write.
  const { data: signal, error: sigErr } = await adminClient
    .from('signals')
    .select('id, user_id, ticker, tastytrade_account_number')
    .eq('id', signalId)
    .maybeSingle()
  if (sigErr) return json({ success: false, error: `signal lookup failed: ${sigErr.message}` }, 500)
  if (!signal || signal.user_id !== user.id) {
    return json({ success: false, error: 'signal not found' }, 404)
  }
  if (!signal.tastytrade_account_number) {
    return json({ success: false, error: 'signal has no broker link' }, 400)
  }
  const accountNumber = signal.tastytrade_account_number

  // Fetch the current order so we can echo its legs + only mutate
  // price. Tastytrade rejects PUTs that omit the leg array.
  let getResp: Response
  try {
    getResp = await tastytradeFetch(
      adminClient,
      `/accounts/${encodeURIComponent(accountNumber)}/orders/${encodeURIComponent(orderId)}`,
      { method: 'GET' },
    )
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    return json({ success: false, error: `order lookup failed: ${reason}` }, 502)
  }
  if (!getResp.ok) {
    const detail = await getResp.text().catch(() => '')
    return json({ success: false, error: `order lookup returned ${getResp.status}`, detail: detail.slice(0, 300) }, 502)
  }
  const orderBody = await getResp.json().catch(() => null) as { data?: Record<string, unknown> } | null
  const order = orderBody?.data
  if (!order) return json({ success: false, error: 'order not found at broker' }, 404)

  // Sanity: the order must touch the signal's ticker. Otherwise
  // we'd be modifying an unrelated working order via a forged
  // signal_id link. (RLS already prevents cross-user signal access,
  // but if a user logs two signals on different tickers and gets
  // the wrong order_id from one of them, this catches it.)
  const orderUnderlying = String(order['underlying-symbol'] ?? '').toUpperCase()
  if (orderUnderlying && orderUnderlying !== signal.ticker.toUpperCase()) {
    return json({ success: false, error: 'order does not match signal ticker' }, 400)
  }

  const orderType = String(order['order-type'] ?? 'Limit')
  const timeInForce = String(order['time-in-force'] ?? 'Day')
  const priceEffect = String(order['price-effect'] ?? 'Debit')
  const legsRaw = (order.legs as Array<Record<string, unknown>> | undefined) ?? []
  if (legsRaw.length === 0) {
    return json({ success: false, error: 'order has no legs to echo' }, 502)
  }
  const legs: OrderLegEcho[] = legsRaw.map((l) => ({
    'instrument-type': String(l['instrument-type'] ?? 'Equity Option'),
    symbol: String(l.symbol ?? ''),
    quantity: (l.quantity as number | string) ?? 0,
    action: String(l.action ?? ''),
  }))

  const putPayload = {
    'order-type': orderType,
    'time-in-force': timeInForce,
    'price-effect': priceEffect,
    price: newPrice.toFixed(2),
    legs,
  }

  let putResp: Response
  try {
    putResp = await tastytradeFetch(
      adminClient,
      `/accounts/${encodeURIComponent(accountNumber)}/orders/${encodeURIComponent(orderId)}`,
      { method: 'PUT', body: JSON.stringify(putPayload) },
    )
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    await adminClient.from('order_history').insert({
      signal_id: signalId,
      user_id: user.id,
      account_number: accountNumber,
      tastytrade_order_id: orderId,
      order_type: 'modify',
      action: 'modify_limit',
      ticker: signal.ticker,
      limit_price: newPrice,
      status: 'rejected',
      api_response: { error: reason, payload: putPayload },
    })
    return json({ success: false, error: reason }, 502)
  }
  const putBodyJson = await putResp.json().catch(() => ({}))

  await adminClient.from('order_history').insert({
    signal_id: signalId,
    user_id: user.id,
    account_number: accountNumber,
    tastytrade_order_id: orderId,
    order_type: 'modify',
    action: 'modify_limit',
    ticker: signal.ticker,
    limit_price: newPrice,
    status: putResp.ok ? 'submitted' : 'rejected',
    api_response: putBodyJson,
  })

  if (!putResp.ok) {
    const detail = JSON.stringify(putBodyJson).slice(0, 400)
    return json({ success: false, error: `tastytrade PUT returned ${putResp.status}`, detail }, 502)
  }

  return json({ success: true, data: { order_id: orderId, new_price: newPrice } })
})
