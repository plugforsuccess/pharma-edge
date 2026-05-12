// deploy-trigger: 2026-05-12 (manual workflow nudge)
// bot-place-multileg-exit — submit a 2-leg or 4-leg CLOSING order.
//
// Reads the open_positions row, reconstructs the legs (with Sell to
// Close / Buy to Close actions), submits at the requested net price.
//
// service-role only. Caller is the per-strategy exit evaluator.
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, TASTYTRADE_REFRESH_TOKEN

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tastytradeFetch, TastytradeError, envFromMode, type TtEnv } from '../_shared/tastytrade.ts'
import { buildLegs, type StructureKind } from '../_shared/multileg.ts'

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

  const positionId = String(body.position_id ?? '')
  const limitPrice = Number(body.limit_price)
  const market = body.market === true
  const reason = body.reason ? String(body.reason) : 'auto_exit'
  const closeContracts = Number(body.contracts)  // optional; defaults to remaining

  if (!positionId) return json({ success: false, error: 'position_id required' }, 400)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const { data: pos } = await supabase
    .from('open_positions')
    .select('*')
    .eq('id', positionId)
    .maybeSingle()
  if (!pos) return json({ success: false, error: 'position not found' }, 404)
  if (pos.status !== 'open') return json({ success: false, error: `position ${pos.status}` }, 409)

  const { data: profile } = await supabase
    .from('profiles')
    .select('bot_config')
    .eq('id', pos.user_id)
    .maybeSingle()
  const cfg = (profile?.bot_config ?? {}) as Record<string, unknown>
  const mode = String(cfg.mode ?? 'paper')
  const accountNumber = String(
    (mode === 'live' ? cfg.live_account_number : cfg.sandbox_account_number) ?? '',
  )
  if (!accountNumber) return json({ success: false, error: `no ${mode} account configured` }, 400)
  // Position carries its open env on the row; trust that over the
  // current bot_config.mode so exits route to wherever the open
  // happened, even if the user has since flipped mode.
  const env: TtEnv = (pos.env === 'cert' || pos.env === 'live')
    ? (pos.env as TtEnv)
    : envFromMode(mode)

  const remaining = Number(pos.contracts_remaining ?? pos.contracts ?? 0)
  const q = Math.min(remaining, closeContracts > 0 ? Math.floor(closeContracts) : remaining)
  if (q < 1) return json({ success: false, error: 'nothing to close' }, 400)

  let legSpec
  try {
    legSpec = buildLegs(
      {
        kind: pos.strategy_type as StructureKind,
        ticker: pos.ticker,
        expiry: pos.expiration,
        long_put_strike:   Number(pos.long_strike)        || undefined,  // legacy: long_strike held the long put
        short_put_strike:  Number(pos.short_strike)       || undefined,
        short_call_strike: Number(pos.short_call_strike)  || undefined,
        long_call_strike:  Number(pos.long_call_strike)   || undefined,
        long_strike:       Number(pos.long_strike)        || undefined,
        short_strike:      Number(pos.short_strike)       || undefined,
      },
      q,
      true, // closing
    )
  } catch (err) {
    return json({ success: false, error: `leg build failed: ${(err as Error).message}` }, 400)
  }

  // Market exit: use a price 3x worse than entry to guarantee fill in
  // fast tape. Default behaviour is a limit at the requested price.
  const price = market
    ? Math.max(0.05, Math.abs(Number(pos.entry_debit_per_spread) || 1) * 3)
    : limitPrice
  if (!Number.isFinite(price) || price <= 0) {
    return json({ success: false, error: 'invalid exit price' }, 400)
  }

  const orderPayload = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    'price': price.toFixed(2),
    'price-effect': legSpec.priceEffect,
    'legs': legSpec.legs,
  }

  let orderResp: Response
  try {
    orderResp = await tastytradeFetch(
      supabase,
      `/accounts/${encodeURIComponent(accountNumber)}/orders`,
      { method: 'POST', body: JSON.stringify(orderPayload) },
      env,
    )
  } catch (err) {
    return json({ success: false, error: err instanceof TastytradeError ? err.message : String(err) }, 502)
  }

  const orderData = await orderResp.json().catch(() => ({}))
  if (!orderResp.ok) {
    return json({ success: false, error: `tastytrade ${orderResp.status}`, detail: orderData }, 502)
  }

  const orderId = orderData?.data?.order?.id ?? null
  const actionForHistory = legSpec.priceEffect === 'Credit' ? 'sell_to_close' : 'buy_to_close'

  await supabase.from('order_history').insert({
    user_id: pos.user_id,
    account_number: accountNumber,
    order_type: 'close',
    action: actionForHistory,
    structure: pos.strategy_type,
    ticker: pos.ticker,
    buy_strike: pos.long_strike,
    sell_strike: pos.short_strike,
    expiry_date: pos.expiration,
    contracts: q,
    limit_price: price,
    status: 'submitted',
    tastytrade_order_id: orderId ? String(orderId) : null,
    api_response: { ...orderData, reason, position_id: positionId, market, legs: legSpec.legs },
    auto_executed: true,
    auto_close_strategy: pos.strategy ?? 'multileg',
    env,
    position_id: positionId,
  })

  return json({
    success: true,
    order_id: orderId,
    contracts_requested: q,
    price_effect: legSpec.priceEffect,
    price: Number(price.toFixed(2)),
  })
})
