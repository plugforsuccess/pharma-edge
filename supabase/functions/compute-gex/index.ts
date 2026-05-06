// Pharma Edge — compute-gex edge function.
//
// Computes Gamma Exposure (GEX) per strike for a single ticker so the
// /markets page can render a heatmap of where dealer hedging flow is
// concentrated — same idea as SpotGamma / gexstream.com, but
// self-computed from Tastytrade option chains so we own the data.
//
// Math:
//   γ(S,K,T,σ,r) = N'(d1) / (S · σ · √T)
//   where N'(x) = (1 / √(2π)) · e^(-x²/2)
//
//   GEX_call_strike = +OI_call · γ_call · 100 · S²
//   GEX_put_strike  = -OI_put  · γ_put  · 100 · S²
//   (Convention: dealers are net short calls / long puts to retail, so
//    call-side OI implies positive dealer gamma at that strike.)
//
// Returned in "$ per 1% underlying move" units (we divide raw γ·OI·S²
// by 100 once on output) so numbers are readable in the UI.
//
// Auth: real user JWT (verify_jwt=true at the platform level + getUser
// here). No rate limiting yet — option-chain calls are cheap on
// Tastytrade and the page only triggers one request per tab click.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  fetchEquityLast,
  fetchNestedChain,
  fetchOptionQuotes,
  TastytradeError,
  type ChainExpiration,
  type OptionQuote,
} from './tastytrade.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

// Risk-free rate proxy. Short-Treasury-ish; gamma is largely insensitive
// to r so a hardcoded 0.045 is fine until rates move materially.
const RISK_FREE = 0.045
// Strike window around spot — dealer hedging gamma decays sharply at
// the wings, so we cut off rather than computing the full chain.
const STRIKE_WINDOW_PCT = 0.30
// gex_snapshots cache TTL — short enough that the heatmap reflects
// real intraday movement, long enough to absorb a tab-mash on the
// /markets ticker picker.
const CACHE_TTL_MS = 5 * 60 * 1000

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

// Standard normal pdf — N'(x) = (1/√(2π)) · e^(-x²/2)
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

// Black-Scholes gamma. Returns 0 if any input is degenerate (zero σ,
// non-positive T, etc.) — we want to skip the strike, not crash.
function bsGamma(
  spot: number,
  strike: number,
  timeYears: number,
  sigma: number,
  rate: number,
): number {
  if (!(spot > 0 && strike > 0 && timeYears > 0 && sigma > 0)) return 0
  const sqrtT = Math.sqrt(timeYears)
  const d1 =
    (Math.log(spot / strike) + (rate + 0.5 * sigma * sigma) * timeYears) /
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

function pickExpiration(
  chain: ChainExpiration[],
  preferredDte = 30,
): ChainExpiration | null {
  if (chain.length === 0) return null
  // Standard expirations only (skip weeklies on >2 DTE); in practice
  // the chain comes back with the right ones near the front month, so
  // just rank by |dte - preferred|.
  const valid = chain.filter((e) => e.daysToExpiration > 0)
  if (valid.length === 0) return null
  valid.sort(
    (a, b) =>
      Math.abs(a.daysToExpiration - preferredDte) -
      Math.abs(b.daysToExpiration - preferredDte),
  )
  return valid[0]
}

interface ComputeArgs {
  ticker: string
  preferredDte: number
  expirationOverride: string | null
}

async function computeGex(
  supabase: ReturnType<typeof createClient>,
  args: ComputeArgs,
) {
  const { ticker, preferredDte, expirationOverride } = args

  const spot = await fetchEquityLast(supabase, ticker)
  if (spot == null || spot <= 0) {
    return { error: `no live quote for ${ticker}` }
  }

  const chain = await fetchNestedChain(supabase, ticker)
  if (chain.length === 0) {
    return { error: `no option chain returned for ${ticker}` }
  }

  const expiration = expirationOverride
    ? chain.find((e) => e.expirationDate === expirationOverride) ?? null
    : pickExpiration(chain, preferredDte)
  if (!expiration) {
    return { error: `no usable expiration for ${ticker}` }
  }

  // Trim to ATM ± window so we don't pay quote-fetch latency on far
  // wings that contribute negligibly to gamma anyway.
  const lo = spot * (1 - STRIKE_WINDOW_PCT)
  const hi = spot * (1 + STRIKE_WINDOW_PCT)
  const trimmedStrikes = expiration.strikes.filter(
    (s) => s.strike >= lo && s.strike <= hi,
  )
  if (trimmedStrikes.length === 0) {
    return { error: `no strikes within ±${STRIKE_WINDOW_PCT * 100}% of spot` }
  }

  // One batched market-data call — call symbols + put symbols in the
  // same request.
  const allSymbols = trimmedStrikes.flatMap((s) => [s.callSymbol, s.putSymbol])
  let quotes: Map<string, OptionQuote>
  try {
    quotes = await fetchOptionQuotes(supabase, allSymbols)
  } catch (err) {
    const msg = err instanceof TastytradeError ? err.message : 'quote fetch failed'
    return { error: msg }
  }

  const timeYears = Math.max(expiration.daysToExpiration, 1) / 365
  const results: StrikeResult[] = []

  for (const s of trimmedStrikes) {
    const callQ = quotes.get(s.callSymbol)
    const putQ = quotes.get(s.putSymbol)
    const oiCall = callQ?.openInterest ?? 0
    const oiPut = putQ?.openInterest ?? 0
    if (oiCall === 0 && oiPut === 0) continue

    const ivCall = callQ?.impliedVolatility ?? null
    const ivPut = putQ?.impliedVolatility ?? null
    const sigmaCall = ivCall ?? ivPut ?? 0
    const sigmaPut = ivPut ?? ivCall ?? 0

    const gammaCall = bsGamma(spot, s.strike, timeYears, sigmaCall, RISK_FREE)
    const gammaPut = bsGamma(spot, s.strike, timeYears, sigmaPut, RISK_FREE)

    // 100 = contract multiplier. Dividing by 100 again converts the
    // per-1$-move dollar gamma into per-1%-move dollar gamma so the
    // numbers fit on a chart axis: γ · OI · 100 · S² · 0.01 = γ · OI · S²
    const dealerNotional = spot * spot
    const gexCall = +(oiCall * gammaCall * dealerNotional)
    const gexPut = -(oiPut * gammaPut * dealerNotional)

    results.push({
      strike: s.strike,
      oi_call: oiCall,
      oi_put: oiPut,
      iv_call: ivCall,
      iv_put: ivPut,
      gex_call: gexCall,
      gex_put: gexPut,
      gex_net: gexCall + gexPut,
    })
  }

  results.sort((a, b) => a.strike - b.strike)
  if (results.length === 0) {
    return { error: 'no strikes had open interest' }
  }

  // Zero-gamma flip: where cumulative GEX (from low strike upward)
  // changes sign. SpotGamma's "flip" interpretation — below it dealers
  // are short gamma and amplify volatility, above it they're long
  // gamma and dampen.
  let cumulative = 0
  let zeroGammaStrike: number | null = null
  for (let i = 0; i < results.length; i++) {
    const prev = cumulative
    cumulative += results[i].gex_net
    if (prev <= 0 && cumulative > 0) {
      zeroGammaStrike = results[i].strike
      break
    }
    if (prev >= 0 && cumulative < 0) {
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
    expiration: expiration.expirationDate,
    days_to_expiration: expiration.daysToExpiration,
    strikes: results,
    total_gex: totalGex,
    zero_gamma_strike: zeroGammaStrike,
    largest_positive_strike: largestPositive.strike,
    largest_negative_strike: largestNegative.strike,
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
  const expirationOverride = body.expiration ? String(body.expiration) : null
  const forceRefresh = body.refresh === true

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Cache key: ticker + expiry override (so callers asking for a
  // specific expiration don't get a stale front-month payload back).
  const cacheKey = expirationOverride ? `${ticker}|${expirationOverride}` : ticker

  if (!forceRefresh) {
    const { data: cached } = await adminClient
      .from('gex_snapshots')
      .select('payload, computed_at')
      .eq('ticker', cacheKey)
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

  try {
    const result = await computeGex(adminClient, {
      ticker,
      preferredDte,
      expirationOverride,
    })
    if ('error' in result) {
      return json({ success: false, error: result.error }, 502)
    }
    // Fire-and-forget cache write — failure here shouldn't block the
    // response. Worst case, next hit recomputes.
    adminClient
      .from('gex_snapshots')
      .upsert(
        {
          ticker: cacheKey,
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
  } catch (err) {
    if (err instanceof TastytradeError) {
      return json({ success: false, error: err.message, status: err.status }, 502)
    }
    const msg = err instanceof Error ? err.message : String(err)
    return json({ success: false, error: msg }, 500)
  }
})
