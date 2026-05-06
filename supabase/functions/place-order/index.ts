// Cash Moves — place-order edge function.
//
// Verifies the caller's JWT, derives user_id from the verified token (NOT
// from the request body), validates that the signal belongs to the user,
// checks idempotency on the open-order side, then submits a multi-leg
// limit order to Tastytrade. Logs to order_history via service role and
// reflects the latest order on the signal row.
//
// Required Supabase secrets:
//   TASTYTRADE_USERNAME, TASTYTRADE_PASSWORD
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

const ALLOWED_STRUCTURES = new Set(['bear_put_spread', 'bull_call_spread'])

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  // Auth: derive user_id from a real validated JWT, never from the body.
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

  const signalId = body.signal_id ? String(body.signal_id) : null
  const accountNumber = body.account_number ? String(body.account_number) : null
  const structure = String(body.structure ?? '')
  const buyStrike = Number(body.buy_strike)
  const sellStrike = Number(body.sell_strike)
  const expiryDate = String(body.expiry_date ?? '')
  const contracts = Number(body.contracts)
  const limitPrice = Number(body.limit_price)
  const actionType = body.action_type === 'close' ? 'close' : 'open'
  const ticker = body.ticker ? String(body.ticker).toUpperCase() : null

  if (!signalId || !accountNumber || !ticker) {
    return json({ success: false, error: 'signal_id, account_number, ticker required' }, 400)
  }
  if (!ALLOWED_STRUCTURES.has(structure)) {
    return json({ success: false, error: `unsupported structure: ${structure}` }, 400)
  }
  if (!Number.isFinite(buyStrike) || !Number.isFinite(sellStrike) || buyStrike <= 0 || sellStrike <= 0) {
    return json({ success: false, error: 'invalid strikes' }, 400)
  }
  if (!Number.isFinite(contracts) || contracts < 1) {
    return json({ success: false, error: 'contracts must be >= 1' }, 400)
  }
  if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
    return json({ success: false, error: 'limit_price must be > 0' }, 400)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
    return json({ success: false, error: 'expiry_date must be YYYY-MM-DD' }, 400)
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Validate signal ownership + that it's still open.
  const { data: signal, error: signalError } = await adminClient
    .from('signals')
    .select('id, user_id, ticker, status, order_status')
    .eq('id', signalId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (signalError) {
    return json({ success: false, error: `signal lookup failed: ${signalError.message}` }, 500)
  }
  if (!signal) {
    return json({ success: false, error: 'signal not found for user' }, 404)
  }
  if (signal.status !== 'active') {
    return json({ success: false, error: `signal is not active (status=${signal.status})` }, 400)
  }
  if (signal.ticker.toUpperCase() !== ticker) {
    return json({ success: false, error: 'ticker does not match signal' }, 400)
  }

  // Idempotency: refuse a second OPEN order while one is already in flight.
  if (actionType === 'open') {
    const { data: existing } = await adminClient
      .from('order_history')
      .select('id, status, tastytrade_order_id')
      .eq('signal_id', signalId)
      .eq('order_type', 'open')
      .in('status', ['pending', 'submitted', 'filled', 'partial_fill'])
      .limit(1)
    if ((existing?.length ?? 0) > 0) {
      return json(
        {
          success: false,
          error: 'an open order already exists for this signal',
          existing_order: existing?.[0],
        },
        409,
      )
    }
  }

  // Build legs.
  const optionType = structure === 'bear_put_spread' ? 'P' : 'C'
  const buySymbol = buildOccSymbol(ticker, expiryDate, optionType, buyStrike)
  const sellSymbol = buildOccSymbol(ticker, expiryDate, optionType, sellStrike)

  const buyAction = actionType === 'open' ? 'Buy to Open' : 'Sell to Close'
  const sellAction = actionType === 'open' ? 'Sell to Open' : 'Buy to Close'

  // Tastytrade expects positive `price` paired with `price-effect: Debit`.
  const orderPayload = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    'price': limitPrice.toFixed(2),
    'price-effect': 'Debit',
    'legs': [
      {
        'instrument-type': 'Equity Option',
        'symbol': buySymbol,
        'quantity': contracts,
        'action': buyAction,
      },
      {
        'instrument-type': 'Equity Option',
        'symbol': sellSymbol,
        'quantity': contracts,
        'action': sellAction,
      },
    ],
  }

  let orderResp: Response
  try {
    orderResp = await tastytradeFetch(
      adminClient,
      `/accounts/${encodeURIComponent(accountNumber)}/orders`,
      {
        method: 'POST',
        body: JSON.stringify(orderPayload),
      },
    )
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    await adminClient.from('order_history').insert({
      signal_id: signalId,
      user_id: user.id,
      account_number: accountNumber,
      order_type: actionType,
      action: actionType === 'open' ? 'buy_to_open' : 'sell_to_close',
      structure,
      ticker,
      buy_strike: buyStrike,
      sell_strike: sellStrike,
      expiry_date: expiryDate,
      contracts,
      limit_price: limitPrice,
      status: 'rejected',
      api_response: { error: reason },
    })
    return json({ success: false, error: reason }, 502)
  }

  const orderData = await orderResp.json().catch(() => ({}))

  if (!orderResp.ok) {
    await adminClient.from('order_history').insert({
      signal_id: signalId,
      user_id: user.id,
      account_number: accountNumber,
      order_type: actionType,
      action: actionType === 'open' ? 'buy_to_open' : 'sell_to_close',
      structure,
      ticker,
      buy_strike: buyStrike,
      sell_strike: sellStrike,
      expiry_date: expiryDate,
      contracts,
      limit_price: limitPrice,
      status: 'rejected',
      api_response: orderData,
    })
    return json(
      { success: false, error: `tastytrade ${orderResp.status}`, detail: orderData },
      502,
    )
  }

  const orderId = orderData?.data?.order?.id ?? null
  const tastytradeStatus = String(
    orderData?.data?.order?.status ?? 'submitted',
  ).toLowerCase()
  const normalisedStatus = [
    'pending',
    'submitted',
    'filled',
    'cancelled',
    'rejected',
    'partial_fill',
  ].includes(tastytradeStatus)
    ? tastytradeStatus
    : 'submitted'

  await adminClient.from('order_history').insert({
    signal_id: signalId,
    user_id: user.id,
    tastytrade_order_id: orderId,
    account_number: accountNumber,
    order_type: actionType,
    action: actionType === 'open' ? 'buy_to_open' : 'sell_to_close',
    structure,
    ticker,
    buy_strike: buyStrike,
    sell_strike: sellStrike,
    expiry_date: expiryDate,
    contracts,
    limit_price: limitPrice,
    status: normalisedStatus,
    api_response: orderData,
  })

  if (actionType === 'open') {
    await adminClient
      .from('signals')
      .update({
        tastytrade_order_id: orderId,
        tastytrade_account_number: accountNumber,
        order_status: normalisedStatus,
        order_submitted_at: new Date().toISOString(),
      })
      .eq('id', signalId)
  }

  return json({
    success: true,
    order_id: orderId,
    status: normalisedStatus,
  })
})
