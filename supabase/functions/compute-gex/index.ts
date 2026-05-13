// Cash Moves — compute-gex edge function.
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

// Polygon (Massive) integration is loaded LAZILY via dynamic import
// inside the dispatcher. Static `import { ... } from './polygon.ts'`
// was crashing the function at module load on Supabase edge runtime
// (503s with 80-115ms execution time = cold-start failure, not
// handler error). Dynamic import defers any load-time failure to
// invocation, where it can be caught and fall through to DXLink/Yahoo.
//
// SKIP_POLYGON=true env var bypasses the dynamic import entirely.
const POLYGON_ENABLED =
  !!Deno.env.get('MASSIVE_API_KEY') && Deno.env.get('SKIP_POLYGON') !== 'true'

// Lazy holder so we only attempt the import once per cold-start.
let polygonModulePromise: Promise<typeof import('./polygon.ts') | null> | null = null
function loadPolygon(): Promise<typeof import('./polygon.ts') | null> {
  if (!POLYGON_ENABLED) return Promise.resolve(null)
  if (!polygonModulePromise) {
    polygonModulePromise = import('./polygon.ts').catch((err) => {
      console.error('polygon.ts dynamic import failed:', err)
      return null
    })
  }
  return polygonModulePromise
}
import {
  bsCallDelta,
  bsCharm,
  bsVanna,
  expectedMove,
  pinningProbability,
} from './greeks.ts'

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

// Matrix mode defaults. Skylit-style 2D heatmap. Caller can override
// via the `matrix_max_expirations`, `matrix_max_strikes`, and
// `matrix_strike_window_pct` body params (see MatrixOpts below).
const MATRIX_MAX_EXPIRATIONS_DEFAULT = 4
const MATRIX_MAX_STRIKES_DEFAULT = 30
const MATRIX_STRIKE_WINDOW_PCT_DEFAULT = 0.05  // ATM ± 5%
// Hard caps so a buggy/malicious caller can't ask for a 1000-strike
// matrix that pegs the edge function memory.
const MATRIX_MAX_EXPIRATIONS_LIMIT = 12
const MATRIX_MAX_STRIKES_LIMIT = 100
const MATRIX_STRIKE_WINDOW_PCT_LIMIT = 0.25

interface MatrixOpts {
  maxExpirations: number
  maxStrikes: number
  strikeWindowPct: number
}

const DEFAULT_MATRIX_OPTS: MatrixOpts = {
  maxExpirations: MATRIX_MAX_EXPIRATIONS_DEFAULT,
  maxStrikes: MATRIX_MAX_STRIKES_DEFAULT,
  strikeWindowPct: MATRIX_STRIKE_WINDOW_PCT_DEFAULT,
}

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

// Clamp a number into [min, max], falling back to fallback when the
// input is NaN or non-finite. Used to bound caller-controlled matrix
// dimension params.
function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
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

// Median ATM IV across a single expiration's strikes. Used by each
// matrix source path to compute a real `frontIv` so the expected-move
// metric isn't pegged at the 0.20 fallback. ATM band is ±5% of spot
// by default — wide enough to catch ≥3 strikes on most underlyings,
// narrow enough that skew doesn't bias the median. Picks up both call
// IV and put IV when present (so a strike that's missing one side
// still contributes the other); takes the true median across the
// collected values.
//
// Returns `undefined` when no strike in the band has a usable IV, so
// the caller can fall back to the 0.20 last-resort default — but in
// practice this fires correctly on every liquid name where the source
// returned an IV column (Polygon Greeks, dxlink Quote events, Yahoo
// optionChain).
function medianAtmIv(
  spot: number,
  strikes: Array<{ strike: number; callIv: number | null; putIv: number | null }>,
  bandPct = 0.05,
): number | undefined {
  if (!(spot > 0)) return undefined
  const lo = spot * (1 - bandPct)
  const hi = spot * (1 + bandPct)
  const ivs: number[] = []
  for (const s of strikes) {
    if (!Number.isFinite(s.strike) || s.strike < lo || s.strike > hi) continue
    const c = Number(s.callIv)
    const p = Number(s.putIv)
    if (Number.isFinite(c) && c > 0) ivs.push(c)
    if (Number.isFinite(p) && p > 0) ivs.push(p)
  }
  if (ivs.length === 0) return undefined
  ivs.sort((a, b) => a - b)
  const mid = Math.floor(ivs.length / 2)
  return ivs.length % 2 === 0 ? (ivs[mid - 1] + ivs[mid]) / 2 : ivs[mid]
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
  delta: number | null
  open_interest: number | null
  updated_at: string
}

// Per-cell exposures used by the matrix path. GEX = gamma * spot²;
// VEX = vanna * spot²; CEX = charm * spot² (per-day); DEX = delta * spot.
// Calls contribute positive, puts negative — the dealer-hedging
// convention used throughout this file.
interface CellExposures {
  gex: number | null
  vex: number | null
  cex: number | null
  dex: number | null
}

const EMPTY_CELL: CellExposures = { gex: null, vex: null, cex: null, dex: null }

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
        'bid, ask, mid, iv, gamma, delta, open_interest, updated_at',
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

// ─── Primary: Polygon (Massive) Options Advanced ─────────────────
//
// Real-time chain snapshot with Greeks pre-computed by Polygon. Used
// in front of the DXLink cache since Polygon covers every listed
// underlying (DXLink is limited to the ~15 streamed by the Fly
// worker). DXLink remains the secondary path for resiliency.
//
// Module is loaded lazily — see loadPolygon() above. The caller has
// already verified the module is non-null before invoking this.
async function computeFromPolygon(
  args: ComputeArgs,
  pgModule: typeof import('./polygon.ts'),
): Promise<{ result?: ComputeOutput; error?: string }> {
  const { ticker, preferredDte, expirationOverride } = args
  let chain
  try {
    chain = await pgModule.fetchPolygonChain(ticker, preferredDte, expirationOverride)
  } catch (err) {
    if (err instanceof pgModule.PolygonError) return { error: err.message }
    throw err
  }
  const { spot, expirationDate, daysToExpiration, strikes, expirations } = chain
  if (!Number.isFinite(spot) || spot <= 0) return { error: `no spot for ${ticker}` }

  // Available expirations list — same shape as Yahoo path.
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

  // Trim to ATM window
  const lo = spot * (1 - STRIKE_WINDOW_PCT)
  const hi = spot * (1 + STRIKE_WINDOW_PCT)
  const trimmed = strikes.filter((s) => s.strike >= lo && s.strike <= hi)
  if (trimmed.length === 0) return { error: 'no strikes in window' }

  const t = Math.max(daysToExpiration, 1) / 365
  const results: StrikeResult[] = []
  const dealerNotional = spot * spot

  for (const s of trimmed) {
    if (s.callOI === 0 && s.putOI === 0) continue
    // Prefer Polygon-supplied gamma; fall back to BS inversion if missing.
    const gC = s.callGamma ?? bsGamma(spot, s.strike, t, s.callIV ?? s.putIV ?? 0)
    const gP = s.putGamma ?? bsGamma(spot, s.strike, t, s.putIV ?? s.callIV ?? 0)
    const gexCall = +(s.callOI * gC * dealerNotional)
    const gexPut = -(s.putOI * gP * dealerNotional)
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
  if (results.length === 0) return { error: 'no strikes had OI' }
  results.sort((a, b) => a.strike - b.strike)

  return {
    result: shapeOutput(
      ticker,
      spot,
      expirationDate,
      daysToExpiration,
      results,
      'polygon',
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
  // 'eod' = served from gex_history when both live paths failed (or
  // returned sparse data); UI renders a yellow EOD CLOSE badge with
  // eod_snapshot_at as the timestamp.
  source: 'polygon' | 'dxlink' | 'yahoo' | 'eod'
  computed_at: string
  expirations: ExpirationInfo[]
  strikes: number[]                      // descending; same length as cells.length
  // Primary GEX matrix. Kept as `cells` (not `gex_cells`) for
  // back-compat with consumers that pre-date the multi-exposure layer.
  cells: (number | null)[][]             // [strike_idx][exp_idx] -> gex_net
  // Vanna / Charm / Delta exposures, same indexing as `cells`. Each
  // matrix is computed in the same pass so callers can switch view
  // without a second round-trip.
  vex_cells: (number | null)[][]
  cex_cells: (number | null)[][]
  dex_cells: (number | null)[][]
  // ∆GEX vs the most recent prior snapshot in gex_history (Velocity
  // Mode). Only populated when `include_velocity` is set on the
  // request body; null otherwise.
  velocity_cells?: (number | null)[][] | null
  velocity_window_minutes?: number | null
  largest: {
    strike: number
    expiration: string
    gex_net: number
    strike_index: number
    expiration_index: number
  } | null
  // Aggregate metrics surfaced for the /reasoning page header and the
  // pinning-probability badge. All summed over the strike-window slice
  // we returned (not the full chain).
  net_gex: number
  net_vex: number                // dollar net vanna across the matrix slice
  net_cex: number                // dollar net charm across the matrix slice
  net_dex: number                // dollar net delta across the matrix slice
  total_abs_gex: number
  expected_move: number          // 1-stddev underlying $ move at front-expiry IV
  expected_move_pct: number      // expected_move / spot
  pinning_probability: number    // 0..1 heuristic — see greeks.ts
  // 1-day expected move + previous close + intraday-realized so the
  // /position page can show "today realized X% of expected" context
  // and let the client compute trade-DTE-tailored expected move from
  // iv_used. All optional for back-compat with cached payloads.
  iv_used?: number               // the IV that drove expected_move
  prev_close?: number | null     // last regular-session close
  expected_move_today?: number   // 1-stddev $ move over a single day
  expected_move_today_pct?: number
  realized_move_today?: number   // signed: spot - prev_close
  realized_move_today_pct?: number
  realized_pct_of_today?: number // |realized| / expected_move_today, 0..1+
  // Sum of velocity_cells when set; null otherwise. Used by the
  // metrics strip on the Velocity tab so it has a tab-specific
  // headline number instead of falling back to net_gex.
  net_velocity?: number | null
  // Only set when source='eod' — when this snapshot was originally
  // captured. Used by the UI to label the badge ("EOD · Tue 4:00 PM").
  eod_snapshot_at?: string
}

function todayDateStr(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

// ─── Primary matrix source: Polygon ─────────────────────────────
//
// Pulls the chain snapshot with Greeks pre-computed by Polygon. Same
// 2D pivot as the DXLink path but covers every listed ticker (not
// just the curated DXLink universe).
async function computeMatrixFromPolygon(
  ticker: string,
  opts: MatrixOpts = DEFAULT_MATRIX_OPTS,
  pgModule: typeof import('./polygon.ts'),
): Promise<{ matrix?: MatrixOutput; error?: string }> {
  let chain
  try {
    chain = await pgModule.fetchPolygonMatrixChain(ticker, opts.maxExpirations, opts.strikeWindowPct)
  } catch (err) {
    if (err instanceof pgModule.PolygonError) return { error: err.message }
    throw err
  }
  const { spot, previousClose, expiries } = chain
  if (!Number.isFinite(spot) || spot <= 0) return { error: `no spot for ${ticker}` }
  if (expiries.length === 0) return { error: 'no expirations in window' }

  // Build per-expiry strike lookup. Type is the module's exported
  // PolygonStrike; we use a loose type here since dynamic import
  // doesn't give us a static type for the dictionary value.
  type PgStrike = import('./polygon.ts').PolygonStrike
  const byExp = new Map<string, Map<number, PgStrike>>()
  for (const e of expiries) {
    const m = new Map<number, PgStrike>()
    for (const s of e.strikes) m.set(s.strike, s)
    byExp.set(e.date, m)
  }

  const futureExps = expiries.map((e) => e.date)

  // Front-expiry median ATM IV — drives `expected_move` / `iv_used`
  // in the matrix output. Falls back to 0.20 inside buildMatrix when
  // no strike in the ATM band carries a usable IV.
  const polygonFrontIv = expiries.length > 0
    ? medianAtmIv(spot, expiries[0].strikes.map((s) => ({
        strike: s.strike,
        callIv: s.callIV,
        putIv: s.putIV,
      })))
    : undefined

  return buildMatrix(ticker, spot, 'polygon', futureExps, (exp, strike) => {
    const cell = byExp.get(exp)?.get(strike)
    if (!cell) return EMPTY_CELL
    const dte = expiries.find((e) => e.date === exp)?.dte ?? 1
    const t = Math.max(dte, 1) / 365
    const dN = spot * spot
    const gC = cell.callGamma ?? bsGamma(spot, strike, t, cell.callIV ?? cell.putIV ?? 0)
    const gP = cell.putGamma ?? bsGamma(spot, strike, t, cell.putIV ?? cell.callIV ?? 0)
    const gex = (cell.callOI * gC - cell.putOI * gP) * dN
    // Second-order Greeks: vanna and charm aren't in Polygon's snapshot
    // by default. Compute from BS using the IV polygon DID return.
    const sigC = cell.callIV ?? cell.putIV ?? 0
    const sigP = cell.putIV ?? cell.callIV ?? 0
    const vC = bsVanna(spot, strike, t, sigC)
    const vP = bsVanna(spot, strike, t, sigP)
    const vex = (cell.callOI * vC - cell.putOI * vP) * dN
    const chC = bsCharm(spot, strike, t, sigC) / 365
    const chP = bsCharm(spot, strike, t, sigP) / 365
    const cex = (cell.callOI * chC - cell.putOI * chP) * dN
    // Delta — prefer Polygon's value; fall back to BS.
    const dC = cell.callDelta ?? bsCallDelta(spot, strike, t, sigC)
    const dP = cell.putDelta ?? (bsCallDelta(spot, strike, t, sigP) - 1)
    const dex = (cell.callOI * dC + cell.putOI * dP) * spot
    return { gex, vex, cex, dex }
  }, (exp) => {
    return Array.from(byExp.get(exp)?.keys() ?? [])
  }, opts, undefined, polygonFrontIv, previousClose)
}

async function computeMatrixFromDxLink(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
  opts: MatrixOpts = DEFAULT_MATRIX_OPTS,
): Promise<{ matrix?: MatrixOutput; error?: string }> {
  const { data: rows, error } = await supabase
    .from('dxlink_quotes')
    .select(
      'symbol, kind, underlying, expiration_date, strike, option_type, ' +
        'bid, ask, mid, iv, gamma, delta, open_interest, updated_at, prev_close',
    )
    .or(`symbol.eq.${ticker},underlying.eq.${ticker}`)
  if (error) return { error: `dxlink_quotes query: ${error.message}` }

  const equity = (rows as Array<DxQuoteRow & { prev_close?: number | null }> | null)?.find((r) => r.kind === 'equity')
  if (!equity) return { error: 'no dxlink subscription for ticker' }
  const spot = equity.mid ?? equity.bid ?? equity.ask
  if (!spot || spot <= 0) return { error: 'no spot price in dxlink_quotes' }
  const prevClose = (equity as { prev_close?: number | null }).prev_close ?? null

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
    .slice(0, opts.maxExpirations)
  if (futureExps.length === 0) return { error: 'no future expirations in cache' }

  // Re-bucket so we can compute vanna/charm/delta from BS using the
  // dxFeed IV per option side. The original `byExp` only retained
  // gamma + OI; we need IV too for second-order Greeks.
  type DxBucket = {
    call_oi: number; call_gamma: number; call_iv: number | null; call_delta: number | null
    put_oi:  number; put_gamma:  number; put_iv:  number | null; put_delta:  number | null
  }
  const byExpFull = new Map<string, Map<number, DxBucket>>()
  for (const r of (rows as DxQuoteRow[]).filter((r) => r.kind === 'option')) {
    if (!r.expiration_date || r.strike == null) continue
    let strikeMap = byExpFull.get(r.expiration_date)
    if (!strikeMap) {
      strikeMap = new Map()
      byExpFull.set(r.expiration_date, strikeMap)
    }
    let bucket = strikeMap.get(r.strike)
    if (!bucket) {
      bucket = {
        call_oi: 0, call_gamma: 0, call_iv: null, call_delta: null,
        put_oi: 0, put_gamma: 0, put_iv: null, put_delta: null,
      }
      strikeMap.set(r.strike, bucket)
    }
    if (r.option_type === 'C') {
      bucket.call_oi = r.open_interest ?? 0
      bucket.call_gamma = r.gamma ?? 0
      bucket.call_iv = r.iv
      bucket.call_delta = r.delta
    } else if (r.option_type === 'P') {
      bucket.put_oi = r.open_interest ?? 0
      bucket.put_gamma = r.gamma ?? 0
      bucket.put_iv = r.iv
      bucket.put_delta = r.delta
    }
  }

  const dteOf = (exp: string): number => {
    const expMs = new Date(exp + 'T00:00:00Z').getTime()
    return Math.max(1, Math.round((expMs - Date.now()) / 86_400_000))
  }

  // Front-expiry median ATM IV — see Polygon path for rationale.
  const dxlinkFrontExp = futureExps[0]
  const dxlinkFrontIv = dxlinkFrontExp
    ? medianAtmIv(spot, Array.from(byExpFull.get(dxlinkFrontExp)?.entries() ?? []).map(
        ([strike, b]) => ({ strike, callIv: b.call_iv, putIv: b.put_iv }),
      ))
    : undefined

  return buildMatrix(ticker, spot, 'dxlink', futureExps, (exp, strike) => {
    const bucket = byExpFull.get(exp)?.get(strike)
    if (!bucket) return EMPTY_CELL
    const dte = dteOf(exp)
    const t = dte / 365
    const sigC = bucket.call_iv ?? bucket.put_iv ?? 0
    const sigP = bucket.put_iv ?? bucket.call_iv ?? 0
    const dN = spot * spot
    const gex = (bucket.call_oi * bucket.call_gamma - bucket.put_oi * bucket.put_gamma) * dN
    // Vanna / charm — compute from BS since dxFeed doesn't deliver them.
    const vC = bsVanna(spot, strike, t, sigC)
    const vP = bsVanna(spot, strike, t, sigP)
    const vex = (bucket.call_oi * vC - bucket.put_oi * vP) * dN
    const chC = bsCharm(spot, strike, t, sigC) / 365 // per-day
    const chP = bsCharm(spot, strike, t, sigP) / 365
    const cex = (bucket.call_oi * chC - bucket.put_oi * chP) * dN
    // Delta — prefer dxFeed's value; fall back to BS.
    const dC = bucket.call_delta ?? bsCallDelta(spot, strike, t, sigC)
    // Put delta = call delta - 1 (per put-call parity).
    const dP = bucket.put_delta ?? (bsCallDelta(spot, strike, t, sigP) - 1)
    const dex = (bucket.call_oi * dC + bucket.put_oi * dP) * spot
    return { gex, vex, cex, dex }
  }, (exp) => {
    return Array.from(byExpFull.get(exp)?.keys() ?? [])
  }, opts, undefined, dxlinkFrontIv, prevClose)
}

async function computeMatrixFromYahoo(
  ticker: string,
  opts: MatrixOpts = DEFAULT_MATRIX_OPTS,
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
  const { spot, expirations: expiryUnixes, previousClose: yahooPrevClose } = firstChain
  if (!Number.isFinite(spot) || spot <= 0) return { error: `no spot for ${ticker}` }

  // Use start-of-today-UTC instead of "right now" — Yahoo encodes
  // option expirations as the unix timestamp at 00:00 UTC of the
  // expiration date. Comparing against `Math.floor(Date.now() / 1000)`
  // would filter out today's 0DTE expiration any time the request
  // arrives after 00:00 UTC (which is always, in practice). We want
  // every expiration whose CALENDAR DAY is today or later.
  const now = new Date()
  const todayMidnightUnix = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  )
  const futureUnixes = expiryUnixes
    .filter((u) => u >= todayMidnightUnix)
    .slice(0, opts.maxExpirations)
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
  const futureExps = Array.from(byExp.keys()).sort().slice(0, opts.maxExpirations)
  if (futureExps.length === 0) return { error: 'no chains came back from yahoo' }

  // Front-expiry median ATM IV — see Polygon path for rationale.
  const yahooFrontExp = futureExps[0]
  const yahooFrontIv = yahooFrontExp
    ? medianAtmIv(spot, Array.from(byExp.get(yahooFrontExp)?.entries() ?? []).map(
        ([strike, b]) => ({ strike, callIv: b.callIV, putIv: b.putIV }),
      ))
    : undefined

  return buildMatrix(ticker, spot, 'yahoo', futureExps, (exp, strike) => {
    const bucket = byExp.get(exp)?.get(strike)
    if (!bucket) return EMPTY_CELL
    const dte = dteByExp.get(exp) ?? 30
    const t = Math.max(dte, 1) / 365
    const sigmaCall = bucket.callIV ?? bucket.putIV ?? 0
    const sigmaPut = bucket.putIV ?? bucket.callIV ?? 0
    const gC = bsGamma(spot, strike, t, sigmaCall)
    const gP = bsGamma(spot, strike, t, sigmaPut)
    const dN = spot * spot
    const gex = bucket.callOI * gC * dN - bucket.putOI * gP * dN
    const vC = bsVanna(spot, strike, t, sigmaCall)
    const vP = bsVanna(spot, strike, t, sigmaPut)
    const vex = (bucket.callOI * vC - bucket.putOI * vP) * dN
    const chC = bsCharm(spot, strike, t, sigmaCall) / 365
    const chP = bsCharm(spot, strike, t, sigmaPut) / 365
    const cex = (bucket.callOI * chC - bucket.putOI * chP) * dN
    const dC = bsCallDelta(spot, strike, t, sigmaCall)
    const dP = bsCallDelta(spot, strike, t, sigmaPut) - 1
    const dex = (bucket.callOI * dC + bucket.putOI * dP) * spot
    return { gex, vex, cex, dex }
  }, (exp) => {
    return Array.from(byExp.get(exp)?.keys() ?? [])
  }, opts, dteByExp, yahooFrontIv, yahooPrevClose ?? null)
}

// Velocity Mode — diff the live matrix against the most recent
// historical snapshot for the same ticker, returning per-cell ∆GEX.
//
// We pick the most recent gex_history row that's at least 5 minutes
// older than `now` (so we're comparing against a meaningfully different
// point in time, not a stale cache write from 30 seconds ago) but no
// more than 4 hours old (older than that and the diff is dominated by
// OI/IV churn rather than intraday positioning shifts). When no
// suitable prior snapshot exists, velocity_cells stays null and the
// UI renders an "insufficient history" empty state.
//
// Cell-pairing rule: for each (strike, expiration) in the live matrix,
// find the same (strike, expiration) in the prior snapshot. If absent
// (e.g. a strike rolled into the window since), velocity is null. We
// don't try to interpolate.
async function attachVelocity(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
  matrix: MatrixOutput,
): Promise<MatrixOutput> {
  const now = Date.now()
  const minAgeMs = 5 * 60 * 1000
  const maxAgeMs = 4 * 60 * 60 * 1000
  const upperBound = new Date(now - minAgeMs).toISOString()
  const lowerBound = new Date(now - maxAgeMs).toISOString()
  const { data, error } = await supabase
    .from('gex_history')
    .select('snapshot_at, payload')
    .eq('ticker', ticker)
    .gte('snapshot_at', lowerBound)
    .lte('snapshot_at', upperBound)
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data?.payload) {
    return { ...matrix, velocity_cells: null, velocity_window_minutes: null }
  }
  const prior = data.payload as MatrixOutput
  const priorAt = new Date(data.snapshot_at).getTime()
  const windowMin = Math.round((now - priorAt) / 60_000)

  // Build (strike → exp → gex) lookup over the prior snapshot.
  const priorByStrike = new Map<number, Map<string, number>>()
  for (let i = 0; i < prior.strikes.length; i++) {
    const strikeMap = new Map<string, number>()
    for (let j = 0; j < prior.expirations.length; j++) {
      const v = prior.cells[i]?.[j]
      if (v != null) strikeMap.set(prior.expirations[j].date, v)
    }
    priorByStrike.set(prior.strikes[i], strikeMap)
  }

  const velCells: (number | null)[][] = []
  for (let i = 0; i < matrix.strikes.length; i++) {
    const row: (number | null)[] = []
    const priorRow = priorByStrike.get(matrix.strikes[i])
    for (let j = 0; j < matrix.expirations.length; j++) {
      const liveVal = matrix.cells[i]?.[j]
      const priorVal = priorRow?.get(matrix.expirations[j].date)
      if (liveVal == null || priorVal == null) {
        row.push(null)
      } else {
        row.push(liveVal - priorVal)
      }
    }
    velCells.push(row)
  }

  let netVelocity = 0
  let velocitySeen = false
  for (const row of velCells) {
    for (const v of row) {
      if (v != null) {
        netVelocity += v
        velocitySeen = true
      }
    }
  }

  return {
    ...matrix,
    velocity_cells: velCells,
    velocity_window_minutes: windowMin,
    net_velocity: velocitySeen ? netVelocity : null,
  }
}

// Common builder — picks the strike window centered on spot, applies
// the exposureFor(exp, strike) closure to every cell (returning all
// four exposures at once), and finds the largest |gex|.
function buildMatrix(
  ticker: string,
  spot: number,
  source: 'polygon' | 'dxlink' | 'yahoo',
  expirations: string[],
  exposureFor: (exp: string, strike: number) => CellExposures,
  strikesIn: (exp: string) => number[],
  opts: MatrixOpts,
  dteByExp?: Map<string, number>,
  frontIv?: number,
  prevClose?: number | null,
): { matrix?: MatrixOutput; error?: string } {
  // Strike union across all expirations, trimmed to ATM ± window,
  // capped to opts.maxStrikes centered on spot, descending order.
  const lo = spot * (1 - opts.strikeWindowPct)
  const hi = spot * (1 + opts.strikeWindowPct)
  const strikeSet = new Set<number>()
  for (const exp of expirations) {
    for (const k of strikesIn(exp)) {
      if (k >= lo && k <= hi) strikeSet.add(k)
    }
  }
  let strikes = Array.from(strikeSet).sort((a, b) => b - a)
  if (strikes.length > opts.maxStrikes) {
    let centerIdx = strikes.findIndex((s) => s <= spot)
    if (centerIdx < 0) centerIdx = strikes.length - 1
    const half = Math.floor(opts.maxStrikes / 2)
    const start = Math.max(0, Math.min(strikes.length - opts.maxStrikes, centerIdx - half))
    strikes = strikes.slice(start, start + opts.maxStrikes)
  }
  if (strikes.length === 0) return { error: 'no strikes within window' }

  const cells: (number | null)[][] = []
  const vexCells: (number | null)[][] = []
  const cexCells: (number | null)[][] = []
  const dexCells: (number | null)[][] = []
  let largest: MatrixOutput['largest'] = null
  let netGex = 0
  let netVex = 0
  let netCex = 0
  let netDex = 0
  let totalAbsGex = 0
  for (let i = 0; i < strikes.length; i++) {
    const gexRow: (number | null)[] = []
    const vexRow: (number | null)[] = []
    const cexRow: (number | null)[] = []
    const dexRow: (number | null)[] = []
    for (let j = 0; j < expirations.length; j++) {
      const e = exposureFor(expirations[j], strikes[i])
      gexRow.push(e.gex)
      vexRow.push(e.vex)
      cexRow.push(e.cex)
      dexRow.push(e.dex)
      if (e.vex != null) netVex += e.vex
      if (e.cex != null) netCex += e.cex
      if (e.dex != null) netDex += e.dex
      if (e.gex != null) {
        netGex += e.gex
        totalAbsGex += Math.abs(e.gex)
        if (largest == null || Math.abs(e.gex) > Math.abs(largest.gex_net)) {
          largest = {
            strike: strikes[i],
            expiration: expirations[j],
            gex_net: e.gex,
            strike_index: i,
            expiration_index: j,
          }
        }
      }
    }
    cells.push(gexRow)
    vexCells.push(vexRow)
    cexCells.push(cexRow)
    dexCells.push(dexRow)
  }

  const todayMs = Date.now()
  const expirationInfos: ExpirationInfo[] = expirations.map((date) => {
    const dte = dteByExp?.get(date) ??
      Math.max(0, Math.round((new Date(date + 'T00:00:00Z').getTime() - todayMs) / 86_400_000))
    return { date, dte }
  })

  // Expected move uses the front-expiry IV. Each source path now
  // computes a real `frontIv` via medianAtmIv() and passes it in;
  // the 0.20 default below is a last-resort fallback that only fires
  // when no strike in the ATM band carried a usable IV (illiquid
  // names, mid-frame dxFeed glitch, or a Yahoo response with the
  // IV column stripped). Front IV is the right answer when we have
  // it; the fallback keeps the metric defined.
  const frontDte = expirationInfos[0]?.dte ?? 7
  const ivForExpectedMove = frontIv && frontIv > 0 ? frontIv : 0.20
  const em = expectedMove(spot, ivForExpectedMove, frontDte)
  const emPct = spot > 0 ? em / spot : 0

  // Pinning probability needs the largest |GEX| (we already track it),
  // total |GEX|, spot, the largest strike, and the expected move.
  const pin = largest && em > 0
    ? pinningProbability(
        netGex,
        Math.abs(largest.gex_net),
        totalAbsGex || 1,
        spot,
        largest.strike,
        em,
      )
    : 0

  // Move context: 1-day expected move + today's realized move (vs
  // prev_close). Lets the /position page render "today realized X%
  // of expected" without a second compute. Also exposes iv_used so
  // the client can scale to a user-specific trade DTE without us
  // having to cache per-DTE responses.
  const ivUsed = ivForExpectedMove
  const expectedMoveToday = expectedMove(spot, ivUsed, 1)
  const expectedMoveTodayPct = spot > 0 ? expectedMoveToday / spot : 0
  let realizedMoveToday: number | undefined
  let realizedMoveTodayPct: number | undefined
  let realizedPctOfToday: number | undefined
  if (prevClose != null && prevClose > 0) {
    realizedMoveToday = spot - prevClose
    realizedMoveTodayPct = realizedMoveToday / prevClose
    realizedPctOfToday = expectedMoveToday > 0
      ? Math.abs(realizedMoveToday) / expectedMoveToday
      : 0
  }

  return {
    matrix: {
      ticker: ticker.toUpperCase(),
      spot,
      source,
      computed_at: new Date().toISOString(),
      expirations: expirationInfos,
      strikes,
      cells,
      vex_cells: vexCells,
      cex_cells: cexCells,
      dex_cells: dexCells,
      velocity_cells: null,
      velocity_window_minutes: null,
      largest,
      net_gex: netGex,
      net_vex: netVex,
      net_cex: netCex,
      net_dex: netDex,
      total_abs_gex: totalAbsGex,
      expected_move: em,
      expected_move_pct: emPct,
      pinning_probability: pin,
      iv_used: ivUsed,
      prev_close: prevClose ?? null,
      expected_move_today: expectedMoveToday,
      expected_move_today_pct: expectedMoveTodayPct,
      realized_move_today: realizedMoveToday,
      realized_move_today_pct: realizedMoveTodayPct,
      realized_pct_of_today: realizedPctOfToday,
      net_velocity: null,
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
  source: 'polygon' | 'dxlink' | 'yahoo'
  computed_at: string
}

function shapeOutput(
  ticker: string,
  spot: number,
  expiration: string,
  daysToExpiration: number,
  results: StrikeResult[],
  source: 'polygon' | 'dxlink' | 'yahoo',
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
  const bearer = authHeader.slice('Bearer '.length).trim()
  // Service-role bypass for internal calls from other edge functions
  // (scan-universe-plays, post-scan analytics). The platform's gateway
  // rejects service-role JWTs as UNAUTHORIZED_INVALID_JWT_FORMAT for
  // some internal call paths; this lets the function recognize the
  // role directly and skip the user-JWT validation that would
  // otherwise 401 a system-driven request.
  // NOTE: verify_jwt=false in config.toml — this function self-validates.
  const isServiceRole = SUPABASE_SERVICE_ROLE_KEY && bearer === SUPABASE_SERVICE_ROLE_KEY
  if (!isServiceRole) {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return json({ success: false, error: 'unauthorized' }, 401)
  }

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
  // include_velocity=true asks for ∆GEX cells vs the most recent
  // prior gex_history row. Powers the /markets Velocity Mode tab.
  const includeVelocity = body.include_velocity === true

  // Matrix dimensions can be widened/narrowed by the caller. Each
  // is bounded by the corresponding _LIMIT constant so a malicious
  // body can't OOM the function. Falls back to the default when the
  // body field is missing or invalid.
  const matrixOpts: MatrixOpts = {
    maxExpirations: clamp(
      Number(body.matrix_max_expirations),
      1,
      MATRIX_MAX_EXPIRATIONS_LIMIT,
      MATRIX_MAX_EXPIRATIONS_DEFAULT,
    ),
    maxStrikes: clamp(
      Number(body.matrix_max_strikes),
      5,
      MATRIX_MAX_STRIKES_LIMIT,
      MATRIX_MAX_STRIKES_DEFAULT,
    ),
    strikeWindowPct: clamp(
      Number(body.matrix_strike_window_pct),
      0.01,
      MATRIX_STRIKE_WINDOW_PCT_LIMIT,
      MATRIX_STRIKE_WINDOW_PCT_DEFAULT,
    ),
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  // Cache key includes mode + matrix dimensions + expiration override
  // so different views of the same ticker don't trample each other.
  const matrixDimsKey = matrixMode
    ? `e${matrixOpts.maxExpirations}s${matrixOpts.maxStrikes}w${Math.round(matrixOpts.strikeWindowPct * 1000)}`
    : ''
  const cacheKey = matrixMode
    ? `${ticker}|matrix|${matrixDimsKey}`
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
        let payload = cached.payload as MatrixOutput
        if (includeVelocity && matrixMode) {
          payload = await attachVelocity(adminClient, ticker, payload)
        }
        return json({
          success: true,
          data: { ...payload, from_cache: true, cache_age_ms: age },
        })
      }
    }
  }

  // Matrix mode short-circuits — different output shape, different
  // pipeline. Polygon first (real-time + every ticker), DXLink fallback,
  // Yahoo fallback, then EOD-snapshot fallback from gex_history so the
  // matrix never goes blank overnight.
  if (matrixMode) {
    let matrix: MatrixOutput | null = null
    let pgErr: string | null = null
    let dxErr: string | null = null
    let yhErr: string | null = null
    if (POLYGON_ENABLED) {
      try {
        const pgModule = await loadPolygon()
        if (pgModule) {
          const pg = await computeMatrixFromPolygon(ticker, matrixOpts, pgModule)
          if (pg.matrix) matrix = pg.matrix
          else pgErr = pg.error ?? 'polygon unknown error'
        } else {
          pgErr = 'polygon module load failed'
        }
      } catch (e) {
        pgErr = e instanceof Error ? e.message : 'polygon threw'
      }
    } else {
      pgErr = 'polygon disabled (no MASSIVE_API_KEY)'
    }
    if (!matrix) {
      try {
        const dx = await computeMatrixFromDxLink(adminClient, ticker, matrixOpts)
        if (dx.matrix) matrix = dx.matrix
        else dxErr = dx.error ?? 'dxlink unknown error'
      } catch (e) {
        dxErr = e instanceof Error ? e.message : 'dxlink threw'
      }
    }
    if (!matrix) {
      try {
        const y = await computeMatrixFromYahoo(ticker, matrixOpts)
        if (y.matrix) matrix = y.matrix
        else yhErr = y.error ?? 'yahoo unknown error'
      } catch (e) {
        yhErr = e instanceof Error ? e.message : String(e)
      }
    }
    // Sparse-result detection — Yahoo sometimes returns a chain where
    // only the bootstrap expiration has cells (crumb rotates, follow-up
    // fetches silently fail). If <20% of cells are populated AND we
    // have an EOD snapshot to fall back to, prefer the snapshot. This
    // also handles the overnight case (both live paths empty).
    const cellCount = matrix
      ? matrix.cells.reduce((s, row) => s + row.length, 0)
      : 0
    const nonNullCells = matrix
      ? matrix.cells.reduce(
        (s, row) => s + row.filter((v) => v != null && v !== 0).length,
        0,
      )
      : 0
    const sparse = matrix != null && cellCount > 0 && nonNullCells / cellCount < 0.2

    if (!matrix || sparse) {
      // Pull the most recent gex_history row for this ticker. Older
      // snapshots are still useful overnight: GEX is a structural
      // metric (OI updates once per day, gamma barely moves), so
      // serving yesterday's 4pm close is correct, not a hack.
      const { data: eodRow } = await adminClient
        .from('gex_history')
        .select('snapshot_at, payload')
        .eq('ticker', ticker)
        .order('snapshot_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (eodRow?.payload) {
        const eodMatrix = eodRow.payload as MatrixOutput
        // Tag the source so the UI can render an EOD badge.
        matrix = {
          ...eodMatrix,
          source: 'eod' as MatrixOutput['source'],
          eod_snapshot_at: eodRow.snapshot_at,
        } as MatrixOutput
      } else if (!matrix) {
        return json(
          { success: false, error: `dxlink: ${dxErr ?? 'n/a'}; yahoo: ${yhErr ?? 'n/a'}; eod: no snapshot` },
          502,
        )
      }
      // If we had a sparse live result and no EOD snapshot, keep the
      // sparse one rather than 502'ing — partial data is better than
      // no data when the user is just trying to look at the matrix.
    }
    adminClient
      .from('gex_snapshots')
      .upsert(
        { ticker: cacheKey, payload: matrix, computed_at: new Date().toISOString() },
        { onConflict: 'ticker' },
      )
      .then(() => {})
    // Archive every fresh matrix compute into gex_history, deduped to
    // a 5-minute bucket via the table's (ticker, snapshot_at) PRIMARY
    // KEY. Conflicts in the same bucket get the latest payload via
    // UPSERT — that's the desired behaviour (rolling latest per slot).
    //
    // Why no longer gated on `archive=true`: the snapshot-gex cron has
    // been silently 401'ing for days, leaving gex_history empty and
    // breaking /markets replay + the EOD fallback. Letting any
    // user-driven matrix compute populate the table makes the time
    // series self-healing — cron is now just a top-up for tickers
    // nobody looked at, not the only writer.
    //
    // Skipped when source==='eod' (it's served FROM gex_history, no
    // point re-archiving) or when the matrix is empty.
    if (matrix && matrix.source !== 'eod') {
      const bucketMs = 5 * 60 * 1000
      const bucketedAt = new Date(
        Math.floor(Date.now() / bucketMs) * bucketMs,
      ).toISOString()
      const archivePromise = adminClient
        .from('gex_history')
        .upsert(
          { ticker, snapshot_at: bucketedAt, payload: matrix },
          { onConflict: 'ticker,snapshot_at' },
        )
        .then(({ error }: { error: { code?: string; message: string } | null }) => {
          if (error && error.code !== '23505') {
            console.error('[archive] gex_history upsert failed:', error.message)
          }
        })
      // Cron callers (archive=true) AWAIT the write so a failed insert
      // becomes a 5xx the workflow can see. User calls fire-and-forget
      // via EdgeRuntime.waitUntil so they don't pay the latency but
      // the write still completes after the response returns.
      if (archive) {
        await archivePromise
      } else {
        // deno-lint-ignore no-explicit-any
        const er = (globalThis as any).EdgeRuntime
        if (er && typeof er.waitUntil === 'function') {
          er.waitUntil(archivePromise)
        } else {
          // Local-dev fallback: just don't await. Better than nothing.
          archivePromise.catch(() => {})
        }
      }
    }
    if (includeVelocity && matrix) {
      matrix = await attachVelocity(adminClient, ticker, matrix)
    }
    return json({
      success: true,
      data: { ...matrix, from_cache: false, cache_age_ms: 0 },
    })
  }

  // Try Polygon (Massive) first — real-time chain with every ticker.
  // Fall back to DXLink cache, then Yahoo on any failure. Polygon is
  // gated behind MASSIVE_API_KEY presence so a missing secret won't
  // 503 the endpoint.
  let result: ComputeOutput | null = null
  let polygonError: string | null = null
  let dxLinkError: string | null = null
  if (POLYGON_ENABLED) {
    try {
      const pgModule = await loadPolygon()
      if (pgModule) {
        const pg = await computeFromPolygon({ ticker, preferredDte, expirationOverride }, pgModule)
        if (pg.result) result = pg.result
        else polygonError = pg.error ?? 'polygon unknown error'
      } else {
        polygonError = 'polygon module load failed'
      }
    } catch (e) {
      polygonError = e instanceof Error ? e.message : 'polygon threw'
    }
  } else {
    polygonError = 'polygon disabled (no MASSIVE_API_KEY)'
  }

  if (!result) {
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
  }

  if (!result) {
    try {
      const y = await computeFromYahoo({ ticker, preferredDte, expirationOverride })
      if (y.result) result = y.result
      else {
        return json(
          {
            success: false,
            error: `polygon: ${polygonError}; dxlink: ${dxLinkError}; yahoo: ${y.error}`,
          },
          502,
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return json(
        { success: false, error: `polygon: ${polygonError}; dxlink: ${dxLinkError}; yahoo: ${msg}` },
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

// redeploy-trigger: 2026-05-08 — pick up 0DTE Yahoo unix-cutoff fix from PR #73
