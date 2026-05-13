// Cash Moves — refresh-play-quote edge function.
//
// Live recompute of a play's risk metrics. Pulls Polygon mids for both
// legs of the spread, recomputes max_profit / max_loss / R/R / POP /
// EV / breakeven from first principles, and returns the numbers along
// with quote age so the UI can flag staleness.
//
// Why this exists: the scanner caches plays at scan time. Spot drifts,
// IV moves, mids compress — but the "at scan" numbers stay frozen.
// A user opening a play detail an hour later was seeing R/R 1.9 when
// the live spread had compressed to R/R 0.21 — same trade, different
// numbers. This endpoint gives the UI the live comparison.
//
// Caching: 30s TTL keyed by (ticker, structure, strikes, expiration).
// Page open + auto-refresh every 30s = 1 Polygon roundtrip per minute
// per active page. Cheap.
//
// Auth: user JWT required.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const POLYGON_API_KEY = Deno.env.get('MASSIVE_API_KEY')!

const CACHE_TTL_MS = 30 * 1000

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

type Structure =
  | 'bull_call_spread'
  | 'bear_call_spread'
  | 'bull_put_spread'
  | 'bear_put_spread'
  | 'bull_call'
  | 'bear_call_credit'
  | 'bull_put_credit'
  | 'bear_put'
  | 'BULL_CALL'
  | 'BEAR_CALL_CREDIT'
  | 'BULL_PUT_CREDIT'
  | 'BEAR_PUT'

// Normalize the various strategy spellings the scanner emits into a
// single canonical (option-type, is-credit) pair.
function classifySpread(s: Structure): { optType: 'C' | 'P'; isCredit: boolean } | null {
  const norm = s.toLowerCase().replace(/_credit$/, '')
  if (norm === 'bull_call_spread' || norm === 'bull_call') return { optType: 'C', isCredit: false }
  if (norm === 'bear_put_spread' || norm === 'bear_put') return { optType: 'P', isCredit: false }
  if (norm === 'bear_call_spread' || norm === 'bear_call' || s === 'BEAR_CALL_CREDIT') {
    return { optType: 'C', isCredit: true }
  }
  if (norm === 'bull_put_spread' || norm === 'bull_put' || s === 'BULL_PUT_CREDIT') {
    return { optType: 'P', isCredit: true }
  }
  return null
}

interface PlayRequest {
  ticker: string
  structure: Structure
  long_strike: number
  short_strike: number
  expiration: string  // YYYY-MM-DD
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ success: false, error: 'unauthorized' }, 401)

  if (!POLYGON_API_KEY) return json({ success: false, error: 'polygon api key not configured' }, 500)

  const body = await req.json().catch(() => null) as PlayRequest | null
  if (!body || !body.ticker || !body.structure || !body.expiration) {
    return json({ success: false, error: 'invalid request body' }, 400)
  }
  if (!Number.isFinite(body.long_strike) || !Number.isFinite(body.short_strike)) {
    return json({ success: false, error: 'invalid strikes' }, 400)
  }

  const cls = classifySpread(body.structure)
  if (!cls) {
    return json({ success: false, error: `unsupported structure: ${body.structure}` }, 400)
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const cacheKey = [
    body.ticker.toUpperCase(),
    body.structure,
    body.long_strike,
    body.short_strike,
    body.expiration,
  ].join('|')

  const { data: cached } = await admin
    .from('play_quote_cache')
    .select('payload, computed_at')
    .eq('cache_key', cacheKey)
    .maybeSingle()
  if (cached?.payload && cached.computed_at) {
    const age = Date.now() - new Date(cached.computed_at).getTime()
    if (age < CACHE_TTL_MS) {
      return json({
        success: true,
        data: { ...cached.payload, from_cache: true, cache_age_ms: age },
      })
    }
  }

  // Pull both leg quotes in parallel. Spot comes from the option
  // snapshot's `underlying_asset.price` field — the dedicated
  // /v2/snapshot/locale/us/markets/stocks endpoint returns 403
  // NOT_AUTHORIZED on the Options Advanced plan ("You are not
  // entitled to this data"), so we don't call it.
  const longTicker = buildOccTicker(body.ticker, body.expiration, cls.optType, body.long_strike)
  const shortTicker = buildOccTicker(body.ticker, body.expiration, cls.optType, body.short_strike)
  const [longQuote, shortQuote] = await Promise.all([
    fetchPolygonOptionQuote(longTicker, body.ticker),
    fetchPolygonOptionQuote(shortTicker, body.ticker),
  ])

  if (!longQuote || !shortQuote) {
    return json({
      success: false,
      error: 'Polygon quote unavailable for one or both legs',
      long_quote: longQuote,
      short_quote: shortQuote,
    }, 502)
  }
  const spotPrice = longQuote.underlying_price ?? shortQuote.underlying_price ?? null
  if (!spotPrice) {
    return json({ success: false, error: 'no underlying price on either option snapshot' }, 502)
  }

  const width = Math.abs(body.long_strike - body.short_strike)
  if (width <= 0) return json({ success: false, error: 'zero-width spread' }, 422)

  // Spread mid. For credit spreads the short leg has the higher
  // premium and we collect (short_mid - long_mid). For debit spreads
  // we pay (long_mid - short_mid). Result is always positive when
  // the strikes are oriented correctly for the strategy.
  const spreadPrice = cls.isCredit
    ? shortQuote.mid - longQuote.mid
    : longQuote.mid - shortQuote.mid
  const absPrice = Math.abs(spreadPrice)

  if (!(absPrice > 0) || absPrice >= width) {
    return json({
      success: false,
      error: `degenerate spread pricing: spread mid $${absPrice.toFixed(3)} vs width $${width}`,
      long_mid: longQuote.mid,
      short_mid: shortQuote.mid,
    }, 422)
  }

  let maxProfit: number
  let maxLoss: number
  if (cls.isCredit) {
    maxProfit = absPrice
    maxLoss = width - absPrice
  } else {
    maxProfit = width - absPrice
    maxLoss = absPrice
  }
  const riskReward = maxProfit / maxLoss  // always self-consistent

  // Breakeven from first principles (per-share, then × 100 for dollars).
  let breakeven: number
  if (body.structure === 'bear_call_spread' || body.structure === 'BEAR_CALL_CREDIT' ||
      body.structure === 'bear_call' as Structure) {
    breakeven = body.short_strike + absPrice
  } else if (body.structure === 'bull_call_spread' || body.structure === 'bull_call' ||
             body.structure === 'BULL_CALL') {
    breakeven = body.long_strike + absPrice
  } else if (body.structure === 'bull_put_spread' || body.structure === 'BULL_PUT_CREDIT' ||
             body.structure === 'bull_put' as Structure) {
    breakeven = body.short_strike - absPrice
  } else {
    // bear_put / BEAR_PUT
    breakeven = body.long_strike - absPrice
  }

  // POP via N(d2) at the short strike. Industry-standard approximation.
  // Uses the short leg's IV when available, falls back to long leg's,
  // then to 30%.
  const iv = shortQuote.iv ?? longQuote.iv ?? 0.30
  const dte = daysBetween(body.expiration)
  const popEntry = computePopBp({
    spot: spotPrice,
    strike: body.short_strike,
    iv,
    dte,
    isCallSide: cls.optType === 'C',
    isCredit: cls.isCredit,
  })

  // EV in basis points: signed expected value as a fraction of max-loss.
  const popDecimal = popEntry / 10000
  const evDollars = popDecimal * maxProfit - (1 - popDecimal) * maxLoss
  const evEdgeBp = Math.round((evDollars / maxLoss) * 10000)

  const quoteAgeSec = Math.max(longQuote.age_seconds, shortQuote.age_seconds)

  const payload = {
    ticker: body.ticker.toUpperCase(),
    structure: body.structure,
    long_strike: body.long_strike,
    short_strike: body.short_strike,
    expiration: body.expiration,
    spot: spotPrice,
    long_mid: longQuote.mid,
    short_mid: shortQuote.mid,
    long_bid: longQuote.bid,
    long_ask: longQuote.ask,
    short_bid: shortQuote.bid,
    short_ask: shortQuote.ask,
    is_credit: cls.isCredit,
    credit_mid: cls.isCredit ? absPrice : null,
    debit_mid: cls.isCredit ? null : absPrice,
    width,
    max_profit_per_spread: maxProfit,
    max_loss_per_spread: maxLoss,
    max_profit_dollars: Math.round(maxProfit * 100 * 100) / 100,
    max_loss_dollars: Math.round(maxLoss * 100 * 100) / 100,
    risk_reward: Number(riskReward.toFixed(3)),
    breakeven: Number(breakeven.toFixed(4)),
    entry_pop_bp: popEntry,
    ev_edge_bp: evEdgeBp,
    iv_used: iv,
    quote_age_seconds: quoteAgeSec,
    refreshed_at: new Date().toISOString(),
  }

  admin
    .from('play_quote_cache')
    .upsert(
      { cache_key: cacheKey, payload, computed_at: new Date().toISOString() },
      { onConflict: 'cache_key' },
    )
    .then(() => {})

  return json({ success: true, data: { ...payload, from_cache: false, cache_age_ms: 0 } })
})

// ─── Helpers ────────────────────────────────────────────────────

function buildOccTicker(
  ticker: string,
  expiration: string,
  type: 'C' | 'P',
  strike: number,
): string {
  // Polygon contract format: O:TICKERYYMMDDC00012345
  const exp = new Date(expiration + 'T00:00:00Z')
  const yy = String(exp.getUTCFullYear()).slice(-2)
  const mm = String(exp.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(exp.getUTCDate()).padStart(2, '0')
  const strikeInt = Math.round(strike * 1000)
  const strikeStr = String(strikeInt).padStart(8, '0')
  return `O:${ticker.toUpperCase()}${yy}${mm}${dd}${type}${strikeStr}`
}

interface OptionQuote {
  mid: number
  bid: number
  ask: number
  iv: number | null
  age_seconds: number
  underlying_price: number | null
}

async function fetchPolygonOptionQuote(occTicker: string, underlying: string): Promise<OptionQuote | null> {
  // /v3/snapshot/options/{underlying}/{contract}
  // Response carries last_quote (bid/ask/midpoint), implied_volatility,
  // AND underlying_asset.price — we extract spot from there to avoid a
  // separate /v2/snapshot/locale/us/markets/stocks call that 403s on
  // the Options Advanced plan.
  const url = `https://api.polygon.io/v3/snapshot/options/${underlying.toUpperCase()}/${occTicker}?apiKey=${POLYGON_API_KEY}`
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) {
      console.warn('[refresh-play-quote] polygon option', occTicker, resp.status)
      return null
    }
    const body = await resp.json()
    const r = body?.results
    if (!r) return null
    const bid = Number(r.last_quote?.bid)
    const ask = Number(r.last_quote?.ask)
    const midpoint = Number(r.last_quote?.midpoint)
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask <= 0 || ask < bid) {
      return null
    }
    // Prefer Polygon's own midpoint when available; fall back to (bid+ask)/2.
    const mid = Number.isFinite(midpoint) && midpoint > 0 ? midpoint : (bid + ask) / 2
    const iv = Number(r.implied_volatility)
    const underlying_price = Number(r.underlying_asset?.price)
    // last_quote.last_updated is nanoseconds since epoch
    const tsNs = Number(r.last_quote?.last_updated)
    const ageSeconds = Number.isFinite(tsNs) && tsNs > 0
      ? Math.max(0, Math.floor((Date.now() - tsNs / 1e6) / 1000))
      : 0
    return {
      mid,
      bid,
      ask,
      iv: Number.isFinite(iv) && iv > 0 ? iv : null,
      age_seconds: ageSeconds,
      underlying_price: Number.isFinite(underlying_price) && underlying_price > 0 ? underlying_price : null,
    }
  } catch (err) {
    console.warn('[refresh-play-quote] polygon option threw', occTicker, err)
    return null
  }
}

function daysBetween(expiration: string): number {
  const exp = new Date(expiration + 'T16:00:00-04:00')
  const days = (exp.getTime() - Date.now()) / 86_400_000
  return Math.max(0.01, days)  // never zero — avoids div-by-zero in BS
}

function computePopBp(args: {
  spot: number
  strike: number
  iv: number
  dte: number
  isCallSide: boolean
  isCredit: boolean
}): number {
  const r = 0.045
  const t = args.dte / 365
  if (!(args.iv > 0 && t > 0 && args.spot > 0 && args.strike > 0)) return 5000

  const sqrtT = Math.sqrt(t)
  const d2 = (Math.log(args.spot / args.strike) + (r - 0.5 * args.iv * args.iv) * t) / (args.iv * sqrtT)

  // Map (isCallSide, isCredit) to which tail of the lognormal we want.
  // Credit Bear Call: profit if spot < short_call_strike → P(S<K) = N(-d2)
  // Credit Bull Put:  profit if spot > short_put_strike  → P(S>K) = N(d2)
  // Debit Bull Call:  profit if spot > long_call_strike  → N(d2)
  // Debit Bear Put:   profit if spot < long_put_strike   → N(-d2)
  let p: number
  if (args.isCredit) {
    p = args.isCallSide ? normCdf(-d2) : normCdf(d2)
  } else {
    p = args.isCallSide ? normCdf(d2) : normCdf(-d2)
  }
  return Math.round(clampProb(p) * 10000)
}

function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5
  return Math.max(0.01, Math.min(0.99, p))
}

function normCdf(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + p * ax)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + sign * y)
}
