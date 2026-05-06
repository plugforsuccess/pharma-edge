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

// Matrix mode constants. Skylit-style 2D heatmap shows ~4 expirations
// across and ~25 strikes deep, all clustered tight to ATM.
const MATRIX_MAX_EXPIRATIONS = 4
const MATRIX_MAX_STRIKES = 30
const MATRIX_STRIKE_WINDOW_PCT = 0.05  // ATM ± 5%

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
  expirationOverride: string | null   // 'YYYY-MM-DD' or null
}

interface ExpirationInfo {
  date: string                         // YYYY-MM-DD
  dte: number
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
  const { ticker, preferredDte, expirationOverride } = args

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

  // Group by expiration_date → pick override if requested, else closest to preferredDte.
  const byExpiry = new Map<string, DxQuoteRow[]>()
  for (const r of optionRows) {
    if (!r.expiration_date) continue
    const arr = byExpiry.get(r.expiration_date) ?? []
    arr.push(r)
    byExpiry.set(r.expiration_date, arr)
  }
  const todayMs = Date.now()
  const dteOf = (exp: string) => {
    const expMs = new Date(exp + 'T00:00:00Z').getTime()
    return Math.max(0, Math.round((expMs - todayMs) / 86_400_000))
  }
  const availableExpirations: ExpirationInfo[] = Array.from(byExpiry.keys())
    .map((date) => ({ date, dte: dteOf(date) }))
    .sort((a, b) => a.dte - b.dte)

  let bestExp: string | null = null
  if (expirationOverride && byExpiry.has(expirationOverride)) {
    bestExp = expirationOverride
  } else {
    let bestDelta = Infinity
    for (const [exp] of byExpiry) {
      const delta = Math.abs(dteOf(exp) - preferredDte)
      if (delta < bestDelta) {
        bestDelta = delta
        bestExp = exp
      }
    }
  }
  if (!bestExp) return { error: 'no expirations in dxlink rows' }
  const chosenRows = byExpiry.get(bestExp)!
  const daysToExpiration = Math.max(1, dteOf(bestExp))

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

  return {
    result: shapeOutput(
      ticker,
      spot,
      bestExp,
      daysToExpiration,
      results,
      'dxlink',
      availableExpirations,
    ),
  }
}

// ─── Fallback: Yahoo (15-min delayed, computes BS gamma here) ───
async function computeFromYahoo(args: ComputeArgs): Promise<{ result?: ComputeOutput; error?: string }> {
  const { ticker, preferredDte, expirationOverride } = args
  let chain
  try {
    chain = await fetchYahooChain(ticker, preferredDte, expirationOverride)
  } catch (err) {
    if (err instanceof YahooError) return { error: err.message }
    throw err
  }
  const { spot, expirationDate, daysToExpiration, strikes, expirations } = chain
  if (!Number.isFinite(spot) || spot <= 0) return { error: `no spot for ${ticker}` }

  // Build available_expirations from the unix-timestamp list Yahoo gave us.
  const todayMs = Date.now()
  const availableExpirations: ExpirationInfo[] = expirations
    .map((u) => {
      const ms = u * 1000
      const d = new Date(ms)
      const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
      const dte = Math.max(0, Math.round((ms - todayMs) / 86_400_000))
      return { date, dte }
    })
    .sort((a, b) => a.dte - b.dte)

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

  return {
    result: shapeOutput(
      ticker,
      spot,
      expirationDate,
      daysToExpiration,
      results,
      'yahoo',
      availableExpirations,
    ),
  }
}

// ─── Matrix mode (strikes × expirations 2D grid) ────────────────
//
// The /markets page renders a Skylit-style heatmap: rows = strikes,
// columns = expirations, cell color = GEX. computeMatrixFromDxLink
// pulls every option row for the ticker in one query (we already have
// it cached) and pivots into a 2D grid. Yahoo path fans out parallel
// chain fetches, one per expiration.

interface MatrixOutput {
  ticker: string
  spot: number
  source: 'dxlink' | 'yahoo'
  computed_at: string
  expirations: ExpirationInfo[]
  strikes: number[]                      // descending; same length as cells.length
  cells: (number | null)[][]             // [strike_idx][exp_idx] -> gex_net
  largest: {
    strike: number
    expiration: string
    gex_net: number
    strike_index: number
    expiration_index: number
  } | null
}

function todayDateStr(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

async function computeMatrixFromDxLink(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
): Promise<{ matrix?: MatrixOutput; error?: string }> {
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
  if (!spot || spot <= 0) return { error: 'no spot price in dxlink_quotes' }

  const equityAge = Date.now() - new Date(equity.updated_at).getTime()
  if (equityAge > DXLINK_FRESH_MS) {
    return { error: `dxlink stale (${Math.round(equityAge / 1000)}s old)` }
  }

  // Group option rows by (expiration, strike, side).
  type Bucket = { call_oi: number; call_gamma: number; put_oi: number; put_gamma: number }
  const byExp = new Map<string, Map<number, Bucket>>()
  for (const r of (rows as DxQuoteRow[]).filter((r) => r.kind === 'option')) {
    if (!r.expiration_date || r.strike == null) continue
    let strikeMap = byExp.get(r.expiration_date)
    if (!strikeMap) {
      strikeMap = new Map()
      byExp.set(r.expiration_date, strikeMap)
    }
    let bucket = strikeMap.get(r.strike)
    if (!bucket) {
      bucket = { call_oi: 0, call_gamma: 0, put_oi: 0, put_gamma: 0 }
      strikeMap.set(r.strike, bucket)
    }
    if (r.option_type === 'C') {
      bucket.call_oi = r.open_interest ?? 0
      bucket.call_gamma = r.gamma ?? 0
    } else if (r.option_type === 'P') {
      bucket.put_oi = r.open_interest ?? 0
      bucket.put_gamma = r.gamma ?? 0
    }
  }

  // Pick the next N future expirations.
  const today = todayDateStr()
  const futureExps = Array.from(byExp.keys())
    .filter((e) => e >= today)
    .sort()
    .slice(0, MATRIX_MAX_EXPIRATIONS)
  if (futureExps.length === 0) return { error: 'no future expirations in cache' }

  return buildMatrix(ticker, spot, 'dxlink', futureExps, (exp, strike) => {
    const bucket = byExp.get(exp)?.get(strike)
    if (!bucket) return null
    const callContribution = bucket.call_oi * bucket.call_gamma * spot * spot
    const putContribution = bucket.put_oi * bucket.put_gamma * spot * spot
    return callContribution - putContribution
  }, (exp) => {
    return Array.from(byExp.get(exp)?.keys() ?? [])
  })
}

async function computeMatrixFromYahoo(
  ticker: string,
): Promise<{ matrix?: MatrixOutput; error?: string }> {
  // First call gives us the chain for the nearest expiry plus the full
  // expirations list. Then fan out parallel calls for the next N-1.
  let firstChain
  try {
    firstChain = await fetchYahooChain(ticker, 0)
  } catch (err) {
    if (err instanceof YahooError) return { error: err.message }
    throw err
  }
  const { spot, expirations: expiryUnixes } = firstChain
  if (!Number.isFinite(spot) || spot <= 0) return { error: `no spot for ${ticker}` }

  const todayUnix = Math.floor(Date.now() / 1000)
  const futureUnixes = expiryUnixes
    .filter((u) => u >= todayUnix)
    .slice(0, MATRIX_MAX_EXPIRATIONS)
  if (futureUnixes.length === 0) return { error: 'no future expirations from yahoo' }

  // Format unix → YYYY-MM-DD; same as fetchYahooChain's date format.
  const expDate = (u: number): string => {
    const d = new Date(u * 1000)
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }

  // Fetch each expiration's chain in parallel (skip the first — we
  // already have it from the bootstrap call).
  const firstDate = expDate(futureUnixes[0])
  const chains = await Promise.all(
    futureUnixes.map(async (u, i) => {
      if (i === 0 && expDate(firstChain.expirationUnix) === firstDate) {
        return firstChain
      }
      try {
        return await fetchYahooChain(ticker, 0, expDate(u))
      } catch {
        return null
      }
    }),
  )

  // Index gamma + OI per (expDate, strike).
  type YBucket = { callOI: number; callIV: number | null; putOI: number; putIV: number | null }
  const byExp = new Map<string, Map<number, YBucket>>()
  const dteByExp = new Map<string, number>()
  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i]
    if (!chain) continue
    const date = chain.expirationDate
    dteByExp.set(date, chain.daysToExpiration)
    const strikeMap = new Map<number, YBucket>()
    for (const s of chain.strikes) {
      strikeMap.set(s.strike, {
        callOI: s.callOI,
        callIV: s.callIV,
        putOI: s.putOI,
        putIV: s.putIV,
      })
    }
    byExp.set(date, strikeMap)
  }
  const futureExps = Array.from(byExp.keys()).sort().slice(0, MATRIX_MAX_EXPIRATIONS)
  if (futureExps.length === 0) return { error: 'no chains came back from yahoo' }

  return buildMatrix(ticker, spot, 'yahoo', futureExps, (exp, strike) => {
    const bucket = byExp.get(exp)?.get(strike)
    if (!bucket) return null
    const dte = dteByExp.get(exp) ?? 30
    const t = Math.max(dte, 1) / 365
    const sigmaCall = bucket.callIV ?? bucket.putIV ?? 0
    const sigmaPut = bucket.putIV ?? bucket.callIV ?? 0
    const gC = bsGamma(spot, strike, t, sigmaCall)
    const gP = bsGamma(spot, strike, t, sigmaPut)
    const dealerNotional = spot * spot
    const gexCall = +(bucket.callOI * gC * dealerNotional)
    const gexPut = -(bucket.putOI * gP * dealerNotional)
    return gexCall + gexPut
  }, (exp) => {
    return Array.from(byExp.get(exp)?.keys() ?? [])
  }, dteByExp)
}

// Common builder — picks the strike window centered on spot, applies
// the gex(exp, strike) closure to every cell, and finds the largest.
function buildMatrix(
  ticker: string,
  spot: number,
  source: 'dxlink' | 'yahoo',
  expirations: string[],
  gexFor: (exp: string, strike: number) => number | null,
  strikesIn: (exp: string) => number[],
  dteByExp?: Map<string, number>,
): { matrix?: MatrixOutput; error?: string } {
  // Strike union across all expirations, trimmed to ATM ± window,
  // capped to MATRIX_MAX_STRIKES centered on spot, descending order.
  const lo = spot * (1 - MATRIX_STRIKE_WINDOW_PCT)
  const hi = spot * (1 + MATRIX_STRIKE_WINDOW_PCT)
  const strikeSet = new Set<number>()
  for (const exp of expirations) {
    for (const k of strikesIn(exp)) {
      if (k >= lo && k <= hi) strikeSet.add(k)
    }
  }
  let strikes = Array.from(strikeSet).sort((a, b) => b - a)
  if (strikes.length > MATRIX_MAX_STRIKES) {
    let centerIdx = strikes.findIndex((s) => s <= spot)
    if (centerIdx < 0) centerIdx = strikes.length - 1
    const half = Math.floor(MATRIX_MAX_STRIKES / 2)
    const start = Math.max(0, Math.min(strikes.length - MATRIX_MAX_STRIKES, centerIdx - half))
    strikes = strikes.slice(start, start + MATRIX_MAX_STRIKES)
  }
  if (strikes.length === 0) return { error: 'no strikes within window' }

  const cells: (number | null)[][] = []
  let largest: MatrixOutput['largest'] = null
  for (let i = 0; i < strikes.length; i++) {
    const row: (number | null)[] = []
    for (let j = 0; j < expirations.length; j++) {
      const v = gexFor(expirations[j], strikes[i])
      row.push(v)
      if (v != null && (largest == null || Math.abs(v) > Math.abs(largest.gex_net))) {
        largest = {
          strike: strikes[i],
          expiration: expirations[j],
          gex_net: v,
          strike_index: i,
          expiration_index: j,
        }
      }
    }
    cells.push(row)
  }

  const todayMs = Date.now()
  const expirationInfos: ExpirationInfo[] = expirations.map((date) => {
    const dte = dteByExp?.get(date) ??
      Math.max(0, Math.round((new Date(date + 'T00:00:00Z').getTime() - todayMs) / 86_400_000))
    return { date, dte }
  })

  return {
    matrix: {
      ticker: ticker.toUpperCase(),
      spot,
      source,
      computed_at: new Date().toISOString(),
      expirations: expirationInfos,
      strikes,
      cells,
      largest,
    },
  }
}

// ─── Common output shaping ──────────────────────────────────────
interface ComputeOutput {
  ticker: string
  spot: number
  expiration: string
  days_to_expiration: number
  available_expirations: ExpirationInfo[]
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
  availableExpirations: ExpirationInfo[],
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
    available_expirations: availableExpirations,
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
  const expirationOverride =
    typeof body.expiration === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.expiration)
      ? body.expiration
      : null
  const forceRefresh = body.refresh === true
  const matrixMode = body.matrix === true
  // archive=true (used only by the 5-min snapshot cron) tells us to
  // INSERT the result into gex_history after computing, building the
  // time-series the /markets replay slider scrubs through. Implies
  // matrix=true since replay is matrix-only.
  const archive = body.archive === true

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  // Cache key includes mode + expiration override so different views
  // of the same ticker don't trample each other in the snapshot.
  const cacheKey = matrixMode
    ? `${ticker}|matrix`
    : (expirationOverride ? `${ticker}|${expirationOverride}` : ticker)

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

  // Matrix mode short-circuits — different output shape, different
  // pipeline. DXLink first, Yahoo fallback like the single-exp path.
  if (matrixMode) {
    let matrix: MatrixOutput | null = null
    let dxErr: string | null = null
    try {
      const dx = await computeMatrixFromDxLink(adminClient, ticker)
      if (dx.matrix) matrix = dx.matrix
      else dxErr = dx.error ?? 'dxlink unknown error'
    } catch (e) {
      dxErr = e instanceof Error ? e.message : 'dxlink threw'
    }
    if (!matrix) {
      try {
        const y = await computeMatrixFromYahoo(ticker)
        if (y.matrix) matrix = y.matrix
        else {
          return json(
            { success: false, error: `dxlink: ${dxErr}; yahoo: ${y.error}` },
            502,
          )
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return json(
          { success: false, error: `dxlink: ${dxErr}; yahoo: ${msg}` },
          502,
        )
      }
    }
    adminClient
      .from('gex_snapshots')
      .upsert(
        { ticker: cacheKey, payload: matrix, computed_at: new Date().toISOString() },
        { onConflict: 'ticker' },
      )
      .then(() => {})
    // Archive mode: also insert into gex_history so the replay slider
    // can scrub through the day's snapshots. We don't await this — the
    // response shouldn't block on the archive write, and an
    // ON CONFLICT DO NOTHING means a racing cron is harmless.
    if (archive) {
      adminClient
        .from('gex_history')
        .insert({
          ticker,
          snapshot_at: new Date().toISOString(),
          payload: matrix,
        })
        .then(({ error: insertError }) => {
          if (insertError && insertError.code !== '23505') {
            // 23505 = unique-violation; ignore (race with another cron run)
            console.error('[archive] gex_history insert failed:', insertError)
          }
        })
    }
    return json({
      success: true,
      data: { ...matrix, from_cache: false, cache_age_ms: 0 },
    })
  }

  // Try DXLink cache first; fall back to Yahoo on any failure.
  let result: ComputeOutput | null = null
  let dxLinkError: string | null = null
  try {
    const dx = await computeFromDxLink(adminClient, {
      ticker,
      preferredDte,
      expirationOverride,
    })
    if (dx.result) result = dx.result
    else dxLinkError = dx.error ?? 'dxlink unknown error'
  } catch (e) {
    dxLinkError = e instanceof Error ? e.message : 'dxlink threw'
  }

  if (!result) {
    try {
      const y = await computeFromYahoo({ ticker, preferredDte, expirationOverride })
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
})
