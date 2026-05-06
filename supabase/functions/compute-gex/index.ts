// Wiley Edge — compute-gex edge function.
//
// Computes Gamma Exposure (GEX) per strike for a single ticker so the
// /markets page can render a heatmap of where dealer hedging flow is
// concentrated — same idea as SpotGamma / gexstream.com.
//
// Data source: Yahoo Finance v7 options endpoint. We tried Tastytrade
// REST /market-data first but production routes live equity + option
// quotes through DXLink streaming only — REST returns 502 on prod.
// Yahoo's options endpoint gives spot + full chain (OI + IV per
// strike) in a single REST call with no auth, which is exactly what
// we need.
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
// Auth: real user JWT (verify_jwt=true at the platform level + getUser
// here). 5-minute cache via the gex_snapshots table; refresh:true
// bypasses.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchYahooChain, YahooError } from './yahoo.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

// Risk-free rate proxy. Short-Treasury-ish; gamma is largely insensitive
// to r so a hardcoded 0.045 is fine until rates move materially.
const RISK_FREE = 0.045
// Strike window around spot — dealer hedging gamma decays sharply at
// the wings, so we cut off rather than computing the full chain.
const STRIKE_WINDOW_PCT = 0.30
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

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

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

interface ComputeArgs {
  ticker: string
  preferredDte: number
}

async function computeGex(args: ComputeArgs) {
  const { ticker, preferredDte } = args

  const chain = await fetchYahooChain(ticker, preferredDte)
  const { spot, expirationDate, daysToExpiration, strikes } = chain
  if (!Number.isFinite(spot) || spot <= 0) {
    return { error: `no spot price for ${ticker}` }
  }
  if (strikes.length === 0) {
    return { error: `empty option chain for ${ticker}` }
  }

  // Trim to ATM ± window so we don't render bars for far wings that
  // contribute negligibly to gamma anyway.
  const lo = spot * (1 - STRIKE_WINDOW_PCT)
  const hi = spot * (1 + STRIKE_WINDOW_PCT)
  const trimmedStrikes = strikes.filter((s) => s.strike >= lo && s.strike <= hi)
  if (trimmedStrikes.length === 0) {
    return { error: `no strikes within ±${STRIKE_WINDOW_PCT * 100}% of spot` }
  }

  const timeYears = Math.max(daysToExpiration, 1) / 365
  const results: StrikeResult[] = []

  for (const s of trimmedStrikes) {
    if (s.callOI === 0 && s.putOI === 0) continue

    const sigmaCall = s.callIV ?? s.putIV ?? 0
    const sigmaPut = s.putIV ?? s.callIV ?? 0
    const gammaCall = bsGamma(spot, s.strike, timeYears, sigmaCall, RISK_FREE)
    const gammaPut = bsGamma(spot, s.strike, timeYears, sigmaPut, RISK_FREE)

    // 100 = contract multiplier. Final units are dealer dollar gamma
    // (γ · OI · 100 · S²) ÷ 100 to fit on a chart axis as $ / 1% move.
    const dealerNotional = spot * spot
    const gexCall = +(s.callOI * gammaCall * dealerNotional)
    const gexPut = -(s.putOI * gammaPut * dealerNotional)

    results.push({
      strike: s.strike,
      oi_call: s.callOI,
      oi_put: s.putOI,
      iv_call: s.callIV,
      iv_put: s.putIV,
      gex_call: gexCall,
      gex_put: gexPut,
      gex_net: gexCall + gexPut,
    })
  }

  if (results.length === 0) {
    return { error: 'no strikes had open interest' }
  }

  // Zero-gamma flip: where cumulative GEX (from low strike upward)
  // changes sign. Below it dealers are short gamma and amplify
  // volatility; above it they're long gamma and dampen.
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
    expiration: expirationDate,
    days_to_expiration: daysToExpiration,
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

  try {
    const result = await computeGex({ ticker, preferredDte })
    if ('error' in result) {
      return json({ success: false, error: result.error }, 502)
    }
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
  } catch (err) {
    if (err instanceof YahooError) {
      return json(
        { success: false, error: err.message, status: err.status },
        502,
      )
    }
    const msg = err instanceof Error ? err.message : String(err)
    return json({ success: false, error: msg }, 500)
  }
})
