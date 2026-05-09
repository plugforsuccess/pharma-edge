// Cash Moves — get-working-orders edge function.
//
// Returns working (live) Tastytrade orders for the signal's underlying
// + expiration so the PositionDetail page can render bracket status.
// Read-only — never modifies broker state.
//
// Auth: requires a real user JWT (verify_jwt=true). Caller passes a
// signal_id; the function derives ticker / expiration / account from
// the signal row and refuses if the signal isn't owned by the JWT user.
//
// Tastytrade endpoint: GET /accounts/:n/orders/live returns every
// non-terminal order on the account. We filter client-side in the
// edge to (a) those whose underlying-symbol matches the signal's
// ticker AND (b) whose option leg expirations match the signal's
// expiry_date. Both filters together prevent returning a user's
// unrelated working orders on the same ticker.
//
// OTOCO grouping: Tastytrade returns each leg of a One-Triggers-OCO
// bracket as a separate order with a shared `complex-order-tag`. We
// pass the tag through so the frontend can group target/stop pairs.

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

interface NormalizedOrder {
  tastytrade_order_id: string
  account_number: string
  order_type: string | null
  status: string | null
  price: number | null
  price_effect: string | null
  time_in_force: string | null
  complex_order_tag: string | null
  // 'target' (limit-credit close), 'stop' (stop-trigger close), or
  // 'unknown' if the heuristic can't tell. The frontend uses this to
  // pick the right card label.
  intent: 'target' | 'stop' | 'unknown'
  legs: Array<{
    symbol: string
    action: string
    quantity: number | string
    expiration: string | null
    strike: number | null
    option_type: string | null
  }>
}

// Decode an OCC-style symbol (e.g. "SPY   260516P00580000") into its
// expiration / strike / type components. Tastytrade returns OCC in
// the underlying-symbol field for option legs. Format: 6 char root +
// YYMMDD + C/P + 8 digit strike (× 1000). Returns nulls if the
// symbol doesn't match the format (equity legs, etc.).
function parseOccSymbol(sym: string): {
  expiration: string | null
  strike: number | null
  option_type: string | null
} {
  if (!sym || sym.length < 21) return { expiration: null, strike: null, option_type: null }
  // Last 15 chars: YYMMDDC/P + 8-digit strike
  const dateChunk = sym.slice(-15, -9)
  const optionType = sym.slice(-9, -8)
  const strikeChunk = sym.slice(-8)
  if (!/^\d{6}$/.test(dateChunk) || !/^\d{8}$/.test(strikeChunk)) {
    return { expiration: null, strike: null, option_type: null }
  }
  if (optionType !== 'C' && optionType !== 'P') {
    return { expiration: null, strike: null, option_type: null }
  }
  const yy = dateChunk.slice(0, 2)
  const mm = dateChunk.slice(2, 4)
  const dd = dateChunk.slice(4, 6)
  // Two-digit year — OCC convention is 20YY for now (rolls over in
  // ~75 years; we'll worry about 2099 later).
  const expiration = `20${yy}-${mm}-${dd}`
  const strike = Number(strikeChunk) / 1000
  return { expiration, strike, option_type: optionType }
}

// Heuristic: Tastytrade returns close-side bracket orders without an
// explicit "target" / "stop" tag. We infer from the order type +
// price effect: a "Limit" with price-effect=Credit on a buy-to-close
// flow is the profit target; a "Stop" / "Stop Limit" is the stop loss.
// Falls back to 'unknown' so the UI labels honestly.
function inferIntent(orderType: string | null, priceEffect: string | null): 'target' | 'stop' | 'unknown' {
  if (!orderType) return 'unknown'
  const t = orderType.toLowerCase()
  if (t.includes('stop')) return 'stop'
  if (t === 'limit' && priceEffect && priceEffect.toLowerCase() === 'credit') return 'target'
  if (t === 'limit') return 'target'
  return 'unknown'
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
  if (!signalId) return json({ success: false, error: 'signal_id required' }, 400)

  // Pull the signal so we can (a) verify ownership and (b) extract
  // ticker / expiration / account-number to filter the broker
  // response. Service-role read so we don't depend on RLS visibility
  // of the calling user.
  const { data: signal, error: sigErr } = await adminClient
    .from('signals')
    .select('id, user_id, ticker, expiry_date, tastytrade_account_number')
    .eq('id', signalId)
    .maybeSingle()
  if (sigErr) return json({ success: false, error: `signal lookup failed: ${sigErr.message}` }, 500)
  if (!signal) return json({ success: false, error: 'signal not found' }, 404)
  if (signal.user_id !== user.id) {
    // Signal exists but isn't this user's. Return 404 (not 403) so
    // we don't leak existence to a probing caller.
    return json({ success: false, error: 'signal not found' }, 404)
  }
  if (!signal.tastytrade_account_number) {
    // Manual log without a broker handoff — no working orders to
    // surface. Return empty list rather than erroring.
    return json({ success: true, data: { working_orders: [], reason: 'no_broker_link' } })
  }

  let resp: Response
  try {
    resp = await tastytradeFetch(
      adminClient,
      `/accounts/${encodeURIComponent(signal.tastytrade_account_number)}/orders/live`,
      { method: 'GET' },
    )
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    return json({ success: false, error: `tastytrade fetch failed: ${reason}` }, 502)
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    return json({ success: false, error: `tastytrade returned ${resp.status}`, detail: detail.slice(0, 300) }, 502)
  }
  const ttBody = await resp.json().catch(() => null) as { data?: { items?: Array<Record<string, unknown>> } } | null
  const items = ttBody?.data?.items ?? []

  // Filter to orders that touch this signal's ticker + expiration.
  // We only inspect the FIRST option leg per order (multi-leg
  // brackets always share a single underlying + expiration in our
  // flow — Cash Moves only logs single-spread positions today).
  const target = signal.ticker.toUpperCase()
  const targetExpiry = signal.expiry_date as string | null
  const normalized: NormalizedOrder[] = []
  for (const raw of items) {
    const status = String(raw.status ?? '').toLowerCase()
    // Only "live" / "received" / "routed" / "in flight" type states.
    // Tastytrade /orders/live already filters terminal states, but
    // belt-and-suspenders.
    if (['filled', 'cancelled', 'expired', 'replaced', 'rejected'].includes(status)) continue

    const legsRaw = (raw.legs as Array<Record<string, unknown>> | undefined) ?? []
    const legs = legsRaw.map((l) => {
      const sym = String(l.symbol ?? '')
      const parsed = parseOccSymbol(sym)
      return {
        symbol: sym,
        action: String(l.action ?? ''),
        quantity: (l.quantity as number | string) ?? 0,
        ...parsed,
      }
    })
    // Underlying ticker filter: at least one leg must match. Tastytrade
    // also exposes `underlying-symbol` on the order itself; we cross-
    // check both because manual fat-finger orders sometimes leave it
    // null.
    const matchesTicker =
      String(raw['underlying-symbol'] ?? '').toUpperCase() === target ||
      legs.some((leg) => leg.symbol.toUpperCase().startsWith(target))
    if (!matchesTicker) continue
    if (targetExpiry) {
      const matchesExpiry = legs.some((leg) => leg.expiration === targetExpiry)
      if (!matchesExpiry) continue
    }

    const orderType = (raw['order-type'] as string | null) ?? null
    const priceEffect = (raw['price-effect'] as string | null) ?? null
    const priceRaw = raw.price as number | string | null | undefined
    const price = priceRaw == null ? null : Number(priceRaw)
    normalized.push({
      tastytrade_order_id: String(raw.id ?? ''),
      account_number: signal.tastytrade_account_number,
      order_type: orderType,
      status: status || null,
      price: Number.isFinite(price) ? (price as number) : null,
      price_effect: priceEffect,
      time_in_force: (raw['time-in-force'] as string | null) ?? null,
      complex_order_tag: (raw['complex-order-tag'] as string | null) ?? null,
      intent: inferIntent(orderType, priceEffect),
      legs,
    })
  }

  return json({
    success: true,
    data: {
      working_orders: normalized,
      account_number: signal.tastytrade_account_number,
      ticker: signal.ticker,
      expiration: targetExpiry,
    },
  })
})
