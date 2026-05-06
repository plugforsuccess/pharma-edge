// Wiley Edge — compute-gex edge function.
//
// Computes Gamma Exposure (GEX) per strike for a single ticker so the
// /markets page can render a heatmap of where dealer hedging flow is
// concentrated.
//
// Data flow:
//   1. dxlink-worker (Fly.io) holds a persistent WS to Tastytrade's
//      DXLink gateway and streams Quote / Greeks / Summary events into
//      public.dxlink_quotes (~750ms cache TTL inside the worker).
//   2. This edge function reads the latest dxlink_quotes rows for the
//      requested ticker, picks the closest expiry to preferredDte, and
//      computes GEX from real-time gamma + OI per strike.
//   3. We don't recompute Black-Scholes — gamma comes straight off the
//      Greeks event from dxFeed. dealer notional = OI × gamma × 100 × S²
//      with calls positive / puts negative.
//
// Fallback: if dxlink_quotes has no rows for the ticker (worker hasn't
// subscribed to it yet, or worker is down), we fall back to Yahoo so
// the user gets *something* instead of an error. The fallback is
// flagged in the response so the UI can warn that data is delayed.
//
// Auth: real user JWT (verify_jwt=true at the platform level + getUser
// here). 5-minute snapshot cache via gex_snapshots; refresh:true bypasses.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchYahooChain, YahooError } from './yahoo.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const RISK_FREE = 0.045
const STRIKE_WINDOW_PCT = 0.30
const CACHE_TTL_MS = 5 * 60 * 1000
// Worker writes are debounced to ~750ms. If the freshest row for a
// ticker is older than this, the worker is asleep / disconnected /
// hasn't subscribed to the ticker — we should fall back to Yahoo
// rather than serve stale data.
const DXLINK_FRESH_MS = 30 * 1000

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

// ─── Black-Scholes gamma (used only by the Yahoo fallback) ──────
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}
function bsGamma(spot: number, strike: number, t: number, sigma: number): number {
  if (!(spot > 0 && strike > 0 && t > 0 && sigma > 0)) return 0
  const sqrtT = Math.sqrt(t)
  const d1 =
    (Math.log(spot / strike) + (RISK_FREE + 0.5 * sigma * sigma) * t) /
    (sigma * sqrtT)
  return normPdf(d1) / (spot * sigma * sqrtT)
}

interface StrikeResult {
  strike: number
  oi_call: number
  oi_put: number
  iv_call: number | null
  iv_put: number | null
  gex_call: number
  gex_put: number
  gex_net: number
}

interface ComputeArgs {
  ticker: string
  preferredDte: number
}

// ─── Primary path: read from dxlink_quotes ──────────────────────
//
// We pick the option-row expiration closest to preferredDte (across
// the rows the worker is currently subscribed to), then aggregate
// Greeks + OI per strike. Spot comes from the equity-row Quote.

interface DxQuoteRow {
  symbol: string
  kind: 'equity' | 'option'
  underlying: string | null
  expiration_date: string | null
  strike: number | null
  option_type: 'C' | 'P' | null
  bid: number | null
  ask: number | null
  mid: number | null
  iv: number | null
  gamma: number | null
  open_interest: number | null
  updated_at: string
}

async function computeFromDxLink(
  supabase: ReturnType<typeof createClient>,
  args: ComputeArgs,
): Promise<{ result?: ComputeOutput; error?: string }> {
  const { ticker, preferredDte } = args

  // Pull equity row + every option row for this ticker in one query.
  const { data: rows, error } = await supabase
    .from('dxlink_quotes')
    .select(
      'symbol, kind, underlying, expiration_date, strike, option_type, ' +
        'bid, ask, mid, iv, gamma, open_interest, updated_at',
    )
    .or(`symbol.eq.${ticker},underlying.eq.${ticker}`)
  if (error) return { error: `dxlink_quotes query: ${error.message}` }

  const equity = (rows as DxQuoteRow[] | null)?.find((r) => r.kind === 'equity')
  if (!equity) return { error: 'no dxlink subscription for ticker' }
  const spot = equity.mid ?? equity.bid ?? equity.ask
  if (!spot || spot <= 0) {
    return { error: 'no spot price in dxlink_quotes' }
  }

  // Stale check — worker probably down or this ticker dropped.
  const equityAge = Date.now() - new Date(equity.updated_at).getTime()
  if (equityAge > DXLINK_FRESH_MS) {
    return { error: `dxlink stale (${Math.round(equityAge / 1000)}s old)` }
  }

  const optionRows = (rows as DxQuoteRow[]).filter((r) => r.kind === 'option')
  if (optionRows.length === 0) return { error: 'no dxlink option rows for ticker' }

  // Group by expiration_date → pick closest to preferredDte.
  const byExpiry = new Map<string, DxQuoteRow[]>()
  for (const r of optionRows) {
    if (!r.expiration_date) continue
    const arr = byExpiry.get(r.expiration_date) ?? []
    arr.push(r)
    byExpiry.set(r.expiration_date, arr)
  }
  const todayMs = Date.now()
  let bestExp: string | null = null
  let bestDelta = Infinity
  for (const [exp] of byExpiry) {
    const expMs = new Date(exp + 'T00:00:00Z').getTime()
    const days = Math.max(0, Math.round((expMs - todayMs) / 86_400_000))
    const delta = Math.abs(days - preferredDte)
    if (delta < bestDelta) {
      bestDelta = delta
      bestExp = exp
    }
  }
  if (!bestExp) return { error: 'no expirations in dxlink rows' }
  const chosenRows = byExpiry.get(bestExp)!
  const expMs = new Date(bestExp + 'T00:00:00Z').getTime()
  const daysToExpiration = Math.max(
    1,
    Math.round((expMs - todayMs) / 86_400_000),
  )

  // Aggregate per strike — call + put rows merge into one StrikeResult.
  const lo = spot * (1 - STRIKE_WINDOW_PCT)
  const hi = spot * (1 + STRIKE_WINDOW_PCT)
  const byStrike = new Map<number, StrikeResult>()
  const dealerNotional = spot * spot

  for (const r of chosenRows) {
    if (r.strike == null || r.strike < lo || r.strike > hi) continue
    const oi = r.open_interest ?? 0
    if (oi === 0) continue
    const gamma = r.gamma ?? 0
    if (!Number.isFinite(gamma) || gamma <= 0) continue
    const existing = byStrike.get(r.strike) ?? {
      strike: r.strike,
      oi_call: 0,
      oi_put: 0,
      iv_call: null,
      iv_put: null,
      gex_call: 0,
      gex_put: 0,
      gex_net: 0,
    }
    if (r.option_type === 'C') {
      existing.oi_call = oi
      existing.iv_call = r.iv ?? null
      existing.gex_call = +(oi * gamma * dealerNotional)
    } else if (r.option_type === 'P') {
      existing.oi_put = oi
      existing.iv_put = r.iv ?? null
      existing.gex_put = -(oi * gamma * dealerNotional)
    }
    existing.gex_net = existing.gex_call + existing.gex_put
    byStrike.set(r.strike, existing)
  }

  const results = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike)
  if (results.length === 0) return { error: 'no strikes had OI + gamma in cache' }

  return { result: shapeOutput(ticker, spot, bestExp, daysToExpiration, results, 'dxlink') }
}

// ─── Fallback: Yahoo (15-min delayed, computes BS gamma here) ───
async function computeFromYahoo(args: ComputeArgs): Promise<{ result?: ComputeOutput; error?: string }> {
  const { ticker, preferredDte } = args
  let chain
  try {
    chain = await fetchYahooChain(ticker, preferredDte)
  } catch (err) {
    if (err instanceof YahooError) return { error: err.message }
    throw err
  }
  const { spot, expirationDate, daysToExpiration, strikes } = chain
  if (!Number.isFinite(spot) || spot <= 0) return { error: `no spot for ${ticker}` }

  const lo = spot * (1 - STRIKE_WINDOW_PCT)
  const hi = spot * (1 + STRIKE_WINDOW_PCT)
  const trimmed = strikes.filter((s) => s.strike >= lo && s.strike <= hi)
  if (trimmed.length === 0) return { error: 'no strikes in window' }

  const t = Math.max(daysToExpiration, 1) / 365
  const results: StrikeResult[] = []
  const dealerNotional = spot * spot

  for (const s of trimmed) {
    if (s.callOI === 0 && s.putOI === 0) continue
    const sigmaCall = s.callIV ?? s.putIV ?? 0
    const sigmaPut = s.putIV ?? s.callIV ?? 0
    const gC = bsGamma(spot, s.strike, t, sigmaCall)
    const gP = bsGamma(spot, s.strike, t, sigmaPut)
    results.push({
      strike: s.strike,
      oi_call: s.callOI,
      oi_put: s.putOI,
      iv_call: s.callIV,
      iv_put: s.putIV,
      gex_call: +(s.callOI * gC * dealerNotional),
      gex_put: -(s.putOI * gP * dealerNotional),
      gex_net: 0,
    })
    const r = results[results.length - 1]
    r.gex_net = r.gex_call + r.gex_put
  }
  if (results.length === 0) return { error: 'no strikes had OI' }
  results.sort((a, b) => a.strike - b.strike)

  return { result: shapeOutput(ticker, spot, expirationDate, daysToExpiration, results, 'yahoo') }
}

// ─── Common output shaping ──────────────────────────────────────
interface ComputeOutput {
  ticker: string
  spot: number
  expiration: string
  days_to_expiration: number
  strikes: StrikeResult[]
  total_gex: number
  zero_gamma_strike: number | null
  largest_positive_strike: number
  largest_negative_strike: number
  source: 'dxlink' | 'yahoo'
  computed_at: string
}

function shapeOutput(
  ticker: string,
  spot: number,
  expiration: string,
  daysToExpiration: number,
  results: StrikeResult[],
  source: 'dxlink' | 'yahoo',
): ComputeOutput {
  let cumulative = 0
  let zeroGammaStrike: number | null = null
  for (let i = 0; i < results.length; i++) {
    const prev = cumulative
    cumulative += results[i].gex_net
    if ((prev <= 0 && cumulative > 0) || (prev >= 0 && cumulative < 0)) {
      zeroGammaStrike = results[i].strike
      break
    }
  }
  let largestPositive = results[0]
  let largestNegative = results[0]
  let totalGex = 0
  for (const r of results) {
    totalGex += r.gex_net
    if (r.gex_net > largestPositive.gex_net) largestPositive = r
    if (r.gex_net < largestNegative.gex_net) largestNegative = r
  }
  return {
    ticker: ticker.toUpperCase(),
    spot,
    expiration,
    days_to_expiration: daysToExpiration,
    strikes: results,
    total_gex: totalGex,
    zero_gamma_strike: zeroGammaStrike,
    largest_positive_strike: largestPositive.strike,
    largest_negative_strike: largestNegative.strike,
    source,
    computed_at: new Date().toISOString(),
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ success: false, error: 'unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const ticker = String(body.ticker ?? '').trim().toUpperCase()
  if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return json({ success: false, error: 'invalid ticker' }, 400)
  }

  const preferredDte = Number.isFinite(Number(body.preferred_dte))
    ? Math.max(1, Math.min(365, Number(body.preferred_dte)))
    : 30
  const forceRefresh = body.refresh === true

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  if (!forceRefresh) {
    const { data: cached } = await adminClient
      .from('gex_snapshots')
      .select('payload, computed_at')
      .eq('ticker', ticker)
      .maybeSingle()
    if (cached?.payload && cached.computed_at) {
      const age = Date.now() - new Date(cached.computed_at).getTime()
      if (age >= 0 && age < CACHE_TTL_MS) {
        return json({
          success: true,
          data: { ...cached.payload, from_cache: true, cache_age_ms: age },
        })
      }
    }
  }

  // Try DXLink cache first; fall back to Yahoo on any failure.
  let result: ComputeOutput | null = null
  let dxLinkError: string | null = null
  try {
    const dx = await computeFromDxLink(adminClient, { ticker, preferredDte })
    if (dx.result) result = dx.result
    else dxLinkError = dx.error ?? 'dxlink unknown error'
  } catch (e) {
    dxLinkError = e instanceof Error ? e.message : 'dxlink threw'
  }

  if (!result) {
    try {
      const y = await computeFromYahoo({ ticker, preferredDte })
      if (y.result) result = y.result
      else {
        return json(
          {
            success: false,
            error: `dxlink: ${dxLinkError}; yahoo: ${y.error}`,
          },
          502,
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return json(
        { success: false, error: `dxlink: ${dxLinkError}; yahoo: ${msg}` },
        502,
      )
    }
  }

  // Snapshot the response so repeated tab-clicks don't re-query.
  adminClient
    .from('gex_snapshots')
    .upsert(
      {
        ticker,
        payload: result,
        computed_at: new Date().toISOString(),
      },
      { onConflict: 'ticker' },
    )
    .then(() => {})

  return json({
    success: true,
    data: { ...result, from_cache: false, cache_age_ms: 0 },
  })
})
