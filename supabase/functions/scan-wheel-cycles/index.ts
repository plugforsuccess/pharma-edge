// scan-wheel-cycles — deterministic wheel-strategy scanner.
//
// Walks the curated streamed universe (∪ user watchlist ∪ open
// positions), and for each ticker evaluates the seven REQUIRED entry
// conditions against the live GEX matrix + gex_history + opex_dates,
// then constructs a cash-secured-put candidate (~0.30Δ put at/below
// the put wall, monthly DTE) and keeps it only if it clears a minimum
// annualized yield. One row per scan into wheel_suggestions.
//
// DESIGN: pure deterministic math, NO Claude call. The seven
// conditions are all computable from data we already have, so the
// wheel gate is cheap, fully auditable, and reproducible — which is
// what you want gating real capital, not an LLM's judgement.
//
// Mirrors scan-universe-plays for infra: verify_jwt=false (set in
// supabase/config.toml), the same 3-way auth triad (SCAN_AUTH_TOKEN /
// service-role / cron vault token via get_cron_scan_auth_token),
// inlined CORS, per-ticker try/catch isolation, bounded concurrency,
// one service-role feed insert.
//
// The seven conditions (spec, in order). Every rejection is recorded
// in gate_rejections so an empty feed is ALWAYS explainable:
//   1 net_gex_positive   net GEX > 0 (dealers long gamma / pinning)
//   2 pin_prob_ok        pinning_probability >= 0.35
//   3 spot_between_walls spot inside the channel AND >= 2% above the
//                        put wall (downside-only; CSP is asymmetric)
//   4 expected_move_ok   spot-to-put-wall cushion >= 1 expected move
//                        (downside standoff; no delta double-count)
//   5 iv_rank_ok         IV rank (from gex_history iv_used) >= 30
//   6 walls_stable       put wall has not migrated 2+ strikes; thin
//                        history → low-confidence PASS (not a reject)
//   7 catalyst_clear     no INTERVENING OPEX before expiry (hard).
//                        earnings + macro have NO feed in this
//                        project, so they are stamped UNVERIFIED (not
//                        silently passed) and surfaced loudly in the
//                        UI — the locked decision. This auto-tightens
//                        to a hard gate the moment earnings_calendar
//                        is seeded.
//
// IV-rank honesty: a true IV rank is a 252-day percentile; gex_history
// currently spans only days. We still compute it from what exists and
// gate on >= 30, but stamp iv_rank_confidence='low' + the lookback so
// the UI warns. It auto-promotes to 'high' as history accrues — no
// code change. Insufficient IV history is treated as a REJECT
// (iv_history_insufficient), never a silent pass. Wall stability uses
// the SAME confidence label (wall_stable_confidence) but is softer:
// thin history → low-confidence PASS (you can't prove instability
// from missing data); only measured migration hard-rejects.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const SCAN_AUTH_TOKEN = Deno.env.get('SCAN_AUTH_TOKEN')
const POLYGON_API_KEY = Deno.env.get('MASSIVE_API_KEY')

// The streamed universe is where wheel data actually lives (gex_history
// depth + dxlink_quotes option chains). Scanning these guarantees the
// feature can produce output; watchlist/position names are added for
// coverage and simply get explained rejections if they lack data.
const WHEEL_BASE_UNIVERSE = [
  'SPY', 'QQQ', 'IWM', 'DIA',
  'NVDA', 'TSLA', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'NFLX',
  'AMD', 'INTC', 'COIN', 'PLTR',
]

const CONCURRENCY = 3
const STALE_MATRIX_MS = 12 * 60 * 1000
const PUT_WALL_BUFFER_PCT = 0.02    // spot must sit >= 2% above the put wall
const EM_PUT_WALL_MULT = 1.0        // ...and >= 1 expected move above it
const PIN_MIN = 0.35
const IV_RANK_MIN = 30
const IV_RANK_MIN_SAMPLES = 12      // below this → iv_history_insufficient
const IV_RANK_HI_CONF_DAYS = 20     // span < this → confidence 'low'
const WALL_MIGRATION_STRIKES = 2    // 2+ strike move = migrating
const WALL_STABLE_DAYS = 3
const DTE_MIN = 25
const DTE_MAX = 45
const DTE_TARGET = 35
const DELTA_LO = 0.20               // |delta| band around 0.30
const DELTA_HI = 0.40
const DELTA_TARGET = 0.30
const MIN_ANNUALIZED_PCT = 15
const ACCOUNT_SIZE_REFERENCE = 25_000
const PER_TICKER_COLLATERAL_CAP = 0.25  // locked: 25% per ticker
const ONDEMAND_RATE_LIMIT_PER_HOUR = 60 // per-user cap on single-ticker calls

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

// ─── GEX matrix types (subset of compute-gex MatrixOutput) ──────────
interface MatrixData {
  ticker: string
  spot: number
  live_spot?: number | null
  source: string
  session?: string
  computed_at: string
  expirations: { date: string; dte: number }[]
  strikes: number[]
  cells: (number | null)[][]
  net_gex: number
  expected_move: number
  pinning_probability: number
  iv_used?: number
  opex?: { next_date?: string | null; days_until?: number | null } | null
}

function isWithinRth(): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  })
  const parts = fmt.formatToParts(new Date())
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? ''
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  if (['Sat', 'Sun'].includes(wd)) return false
  const mins = hh * 60 + mm
  return mins >= 10 * 60 && mins < 16 * 60
}

// Per-strike net GEX = sum across expirations. Walls = the strikes with
// the largest positive (call wall) and most negative (put wall) net
// gamma. Flip = first ascending strike where the running cumulative
// crosses zero (compute-gex matrix mode does not return it directly).
function deriveWalls(strikes: number[], cells: (number | null)[][]) {
  const perStrike = strikes.map((_, i) =>
    (cells[i] || []).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0),
  )
  let callWall = null as number | null
  let putWall = null as number | null
  let maxPos = -Infinity
  let minNeg = Infinity
  for (let i = 0; i < strikes.length; i++) {
    if (perStrike[i] > maxPos) { maxPos = perStrike[i]; callWall = strikes[i] }
    if (perStrike[i] < minNeg) { minNeg = perStrike[i]; putWall = strikes[i] }
  }
  // Flip: walk strikes ascending, cumulative sign change.
  const asc = strikes.map((s, i) => ({ s, g: perStrike[i] })).sort((a, b) => a.s - b.s)
  let cum = 0
  let prevCum = 0
  let flip = null as number | null
  for (let i = 0; i < asc.length; i++) {
    prevCum = cum
    cum += asc[i].g
    if (i > 0 && Math.sign(cum) !== Math.sign(prevCum) && prevCum !== 0) {
      flip = asc[i].s
      break
    }
  }
  // Median strike increment — used to express migration in "strikes".
  const sortedS = [...strikes].sort((a, b) => a - b)
  const diffs: number[] = []
  for (let i = 1; i < sortedS.length; i++) {
    const d = sortedS[i] - sortedS[i - 1]
    if (d > 0) diffs.push(d)
  }
  diffs.sort((a, b) => a - b)
  const strikeStep = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 1
  return { callWall, putWall, flip, strikeStep }
}

// Black-Scholes put delta — used ONLY to pick the ~0.30Δ strike from
// the matrix strike grid. The premium itself is never modelled; it is
// Polygon-verified below (price by market, not by formula).
function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + p * ax)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + sign * y)
}
function bsPutDelta(spot: number, strike: number, iv: number, dteDays: number): number {
  const t = dteDays / 365
  if (!(iv > 0 && t > 0 && spot > 0 && strike > 0)) return NaN
  const d1 = (Math.log(spot / strike) + (0.045 + 0.5 * iv * iv) * t) / (iv * Math.sqrt(t))
  return normCdf(d1) - 1 // put delta ∈ (-1, 0)
}

// OCC option symbol, identical to _shared/optionPricing.ts so the
// Polygon snapshot endpoint resolves the same contract the spread
// scanner would: O:{TICKER}{YYMMDD}{C|P}{strike*1000 padded 8}.
function occTicker(ticker: string, expiration: string, type: 'C' | 'P', strike: number): string {
  const e = new Date(expiration + 'T00:00:00Z')
  const yy = String(e.getUTCFullYear()).slice(-2)
  const mm = String(e.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(e.getUTCDate()).padStart(2, '0')
  const k = String(Math.round(strike * 1000)).padStart(8, '0')
  return `O:${ticker.toUpperCase()}${yy}${mm}${dd}${type}${k}`
}

// Single-strike Polygon mid. Mirrors _shared/optionPricing.ts'
// fetchPolygonOptionQuote (12s budget, one retry, never synthesizes a
// mid — null → honest rejection). dxlink_quotes only streams near
// weeklies, so the 25–45 DTE wheel leg has to be priced here.
async function polygonPutMid(
  ticker: string, expiration: string, strike: number,
): Promise<{ mid: number; bid: number; ask: number } | null> {
  if (!POLYGON_API_KEY) return null
  const occ = occTicker(ticker, expiration, 'P', strike)
  const url = `https://api.polygon.io/v3/snapshot/options/${ticker.toUpperCase()}/${occ}?apiKey=${POLYGON_API_KEY}`
  const TIMEOUT_MS = 12_000
  const MAX_ATTEMPTS = 2
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!resp.ok) {
        if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 500 * attempt))
          continue
        }
        return null
      }
      const r = (await resp.json())?.results
      if (!r) return null
      const bid = Number(r.last_quote?.bid)
      const ask = Number(r.last_quote?.ask)
      const midpoint = Number(r.last_quote?.midpoint)
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask <= 0 || ask < bid) return null
      const mid = Number.isFinite(midpoint) && midpoint > 0 ? midpoint : (bid + ask) / 2
      return { mid, bid, ask }
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * attempt))
        continue
      }
      return null
    }
  }
  return null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } })
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'edge function misconfigured' }, 500)
  }

  const startedAt = Date.now()
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body ok */ }
  const oneTicker = typeof body.ticker === 'string' && body.ticker.trim()
    ? body.ticker.trim().toUpperCase().slice(0, 12)
    : null
  if (oneTicker && !/^[A-Z0-9.\-]{1,12}$/.test(oneTicker)) {
    return json({ error: 'invalid ticker' }, 400)
  }
  const force = body.force === true

  // ── Auth ──
  // Triad (cron token / service-role / vault token) may run anything.
  // A logged-in end user may run ONLY the single-ticker on-demand
  // analysis (oneTicker set) — never a full universe scan.
  const authHeader = req.headers.get('Authorization') || ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const isCron = !!SCAN_AUTH_TOKEN && bearer === SCAN_AUTH_TOKEN
  const isServiceRole = !!SUPABASE_SERVICE_ROLE_KEY && bearer === SUPABASE_SERVICE_ROLE_KEY
  let isVaultCron = false
  if (!isCron && !isServiceRole && bearer) {
    const { data: vaultToken } = await admin.rpc('get_cron_scan_auth_token')
    isVaultCron = typeof vaultToken === 'string' && vaultToken.length > 0 && bearer === vaultToken
  }
  const isTriad = isCron || isServiceRole || isVaultCron

  let userId: string | null = null
  if (!isTriad) {
    // Only the single-ticker on-demand path is open to end users.
    if (!oneTicker) return json({ error: 'unauthorized' }, 401)
    if (!bearer || !SUPABASE_ANON_KEY) return json({ error: 'unauthorized' }, 401)
    // verify_jwt=false on this function (cron uses opaque tokens), so
    // validate the end-user JWT ourselves via the anon client.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    })
    const { data: u } = await userClient.auth.getUser()
    userId = u?.user?.id ?? null
    if (!userId) return json({ error: 'unauthorized' }, 401)
    const sinceIso = new Date(Date.now() - 3_600_000).toISOString()
    const { count } = await admin
      .from('wheel_suggestions')
      .select('*', { count: 'exact', head: true })
      .eq('requested_by', userId)
      .eq('scan_kind', 'ondemand')
      .gte('computed_at', sinceIso)
    if ((count ?? 0) >= ONDEMAND_RATE_LIMIT_PER_HOUR) {
      return json({ error: 'rate limit: too many on-demand analyses this hour' }, 429)
    }
  }

  const scanKind = oneTicker
    ? 'ondemand'
    : (body.scan_kind === 'manual' || body.scan_kind === 'eod' ? body.scan_kind : 'rth')

  if (!oneTicker && !force && scanKind === 'rth' && !isWithinRth()) {
    return json({ skipped: true, reason: 'outside RTH' }, 200)
  }

  // ── On-demand single-ticker analysis (button on the matrix view) ──
  // Reuses the exact deterministic evaluateTicker() — one engine, no
  // logic fork — and persists the result as a scan_kind='ondemand'
  // row (attributed to requested_by) so it is auditable but kept out
  // of the batch surfaces.
  if (oneTicker) {
    let r: { suggestion: Record<string, unknown> | null; rejections: string[]; constructable: boolean }
    try {
      r = await evaluateTicker(admin, oneTicker)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await admin.from('wheel_suggestions').insert({
        scan_kind: 'ondemand', universe: [oneTicker],
        tickers_scanned: 1, tickers_succeeded: 0, tickers_failed: 1,
        candidates_generated: 0, candidates_after_gate: 0,
        duration_ms: Date.now() - startedAt,
        ranked_suggestions: [], gate_rejections: null,
        errors: { [oneTicker]: msg }, requested_by: userId,
      })
      return json({
        success: true, scan_kind: 'ondemand', ticker: oneTicker,
        suggestion: null, rejections: [], constructable: false, error: msg,
      }, 200)
    }
    const sug = r.suggestion ? [r.suggestion] : []
    await admin.from('wheel_suggestions').insert({
      scan_kind: 'ondemand', universe: [oneTicker],
      tickers_scanned: 1, tickers_succeeded: 1, tickers_failed: 0,
      candidates_generated: r.constructable ? 1 : 0,
      candidates_after_gate: sug.length,
      duration_ms: Date.now() - startedAt,
      ranked_suggestions: sug,
      gate_rejections: r.rejections.length ? { [oneTicker]: r.rejections } : null,
      errors: null, requested_by: userId,
    })
    return json({
      success: true,
      scan_kind: 'ondemand',
      ticker: oneTicker,
      suggestion: r.suggestion,
      rejections: r.rejections,
      constructable: r.constructable,
      computed_at: new Date().toISOString(),
    }, 200)
  }

  // Universe = curated streamed names ∪ watchlist ∪ open positions.
  const { data: wl } = await admin.from('watchlist').select('ticker')
  const { data: op } = await admin.from('open_positions').select('ticker').eq('status', 'open')
  const universe = Array.from(new Set([
    ...WHEEL_BASE_UNIVERSE,
    ...(wl ?? []).map((r: { ticker: string }) => String(r.ticker).toUpperCase()),
    ...(op ?? []).map((r: { ticker: string }) => String(r.ticker).toUpperCase()),
  ])).filter(Boolean)

  const results: {
    ticker: string
    ok: boolean
    suggestion: Record<string, unknown> | null
    rejections: string[]
    constructable: boolean
    error?: string
  }[] = []

  const queue = [...universe]
  const inflight = new Set<Promise<void>>()
  while (queue.length > 0 || inflight.size > 0) {
    while (inflight.size < CONCURRENCY && queue.length > 0) {
      const ticker = queue.shift() as string
      const task = (async () => {
        try {
          const r = await evaluateTicker(admin, ticker)
          results.push({ ticker, ok: true, ...r })
        } catch (err) {
          results.push({
            ticker, ok: false, suggestion: null, rejections: [],
            constructable: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
      inflight.add(task)
      task.finally(() => inflight.delete(task))
    }
    if (inflight.size > 0) await Promise.race(inflight)
  }

  const errors: Record<string, string> = {}
  const gateRejections: Record<string, string[]> = {}
  const suggestions: Record<string, unknown>[] = []
  let constructable = 0
  for (const r of results) {
    if (!r.ok) { errors[r.ticker] = r.error || 'unknown error'; continue }
    if (r.constructable) constructable += 1
    if (r.suggestion) suggestions.push(r.suggestion)
    else if (r.rejections.length) gateRejections[r.ticker] = r.rejections
  }
  suggestions.sort(
    (a, b) => Number(b.annualized_pct ?? 0) - Number(a.annualized_pct ?? 0),
  )

  const tickersFailed = results.filter((r) => !r.ok).length
  const { error: insertErr } = await admin.from('wheel_suggestions').insert({
    scan_kind: scanKind,
    universe,
    tickers_scanned: universe.length,
    tickers_succeeded: results.filter((r) => r.ok).length,
    tickers_failed: tickersFailed,
    candidates_generated: constructable,
    candidates_after_gate: suggestions.length,
    duration_ms: Date.now() - startedAt,
    ranked_suggestions: suggestions,
    gate_rejections: Object.keys(gateRejections).length ? gateRejections : null,
    errors: Object.keys(errors).length ? errors : null,
  })
  if (insertErr) {
    console.error('[scan-wheel] feed insert failed:', insertErr.message)
    return json({ success: false, error: insertErr.message }, 500)
  }

  return json({
    success: true,
    scan_kind: scanKind,
    duration_ms: Date.now() - startedAt,
    tickers_scanned: universe.length,
    candidates_after_gate: suggestions.length,
    errors: Object.keys(errors).length ? errors : null,
  }, 200)
})

// ────────────────────────────────────────────────────────────────────
// Per-ticker evaluation: the seven conditions + CSP construction.
// Returns { suggestion, rejections, constructable }. suggestion is
// non-null ONLY when all seven conditions pass AND a CSP clears the
// minimum yield. Every failure path pushes a reason code.
// ────────────────────────────────────────────────────────────────────
async function evaluateTicker(
  admin: ReturnType<typeof createClient>,
  ticker: string,
): Promise<{ suggestion: Record<string, unknown> | null; rejections: string[]; constructable: boolean }> {
  const rej: string[] = []

  // 1. Live GEX matrix (wide strike window so walls aren't clipped).
  const gexResp = await fetch(`${SUPABASE_URL}/functions/v1/compute-gex`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_ANON_KEY as string,
      'Content-Type': 'application/json',
    },
    // matrix_max_expirations: 12 (the max) so the chain reaches far
    // enough to include the 25–45 DTE monthly the wheel targets —
    // compute-gex's default of 4 only returns short front weeklies.
    body: JSON.stringify({ ticker, matrix: true, matrix_strike_window_pct: 0.15, matrix_max_expirations: 12 }),
  })
  if (!gexResp.ok) {
    return { suggestion: null, rejections: ['no_gex'], constructable: false }
  }
  const gexBody = await gexResp.json()
  if (!gexBody?.success || !gexBody?.data) {
    return { suggestion: null, rejections: ['no_gex'], constructable: false }
  }
  const m = gexBody.data as MatrixData

  // Freshness: never act on stale / overnight snapshots.
  if (m.source === 'eod') {
    return { suggestion: null, rejections: ['stale_eod_data'], constructable: false }
  }
  if (m.computed_at && Date.now() - new Date(m.computed_at).getTime() > STALE_MATRIX_MS) {
    return { suggestion: null, rejections: ['stale_matrix'], constructable: false }
  }

  const spot = Number(m.spot)
  if (!Number.isFinite(spot) || spot <= 0) {
    return { suggestion: null, rejections: ['no_spot'], constructable: false }
  }
  const { callWall, putWall, flip, strikeStep } = deriveWalls(m.strikes || [], m.cells || [])
  if (callWall == null || putWall == null) {
    return { suggestion: null, rejections: ['no_walls'], constructable: false }
  }

  // ── Condition 1: net GEX positive (Regime A / pinning) ──
  const c1 = Number(m.net_gex) > 0
  if (!c1) rej.push('net_gex_negative')

  // ── Condition 2: pin probability >= 0.35 ──
  const pin = Number(m.pinning_probability)
  const c2 = Number.isFinite(pin) && pin >= PIN_MIN
  if (!c2) rej.push('pin_prob_low')

  // ── Condition 3: spot clear of the support it sells against ──
  // Downside-only — a CSP is asymmetric. Spot must be inside the
  // channel AND at least PUT_WALL_BUFFER_PCT above the put wall.
  // Proximity to the CALL wall is irrelevant to a put seller, so the
  // old symmetric extreme test (which deleted profitable CSPs) is
  // gone.
  const insideChannel = spot > putWall && spot < callWall
  const putBufferOk = (spot - putWall) / spot >= PUT_WALL_BUFFER_PCT
  const c3 = insideChannel && putBufferOk
  if (!c3) rej.push('spot_at_extreme')

  // ── Condition 4: volatility-aware downside standoff ──
  // The genuine kernel of the old EM gate, made downside-only and
  // free of the delta double-count: the cushion from spot down to the
  // put wall (the support being sold against) must cover at least one
  // expected move. Replaces the old symmetric "EM < 80% of nearest
  // wall", which over-rejected whenever the CALL wall was nearer (the
  // common Regime-A pin). Note this gates spot-vs-wall geometry, NOT
  // strike placement — a literal "strike >= 1 EM below spot" would
  // contradict the ~0.30Δ strike (which is only ~0.5 EM OTM) and
  // re-introduce over-restriction.
  const em = Number(m.expected_move)
  const c4 = Number.isFinite(em) && em > 0 && (spot - putWall) >= EM_PUT_WALL_MULT * em
  if (!c4) rej.push('expected_move_high')

  // ── Condition 5: IV rank (from gex_history iv_used) >= 30 ──
  const ivNow = Number(m.iv_used)
  let ivRank: number | null = null
  let ivRankConfidence: 'high' | 'low' = 'low'
  let ivWindowDays = 0
  {
    const { data: hist } = await admin
      .from('gex_history')
      .select('snapshot_at, payload')
      .eq('ticker', ticker)
      .order('snapshot_at', { ascending: false })
      .limit(800)
    const series: number[] = []
    let minT = Infinity
    let maxT = -Infinity
    for (const row of hist ?? []) {
      const p = (row as { payload?: { iv_used?: number } }).payload
      const iv = Number(p?.iv_used)
      if (Number.isFinite(iv) && iv > 0) {
        series.push(iv)
        const t = new Date((row as { snapshot_at: string }).snapshot_at).getTime()
        if (t < minT) minT = t
        if (t > maxT) maxT = t
      }
    }
    if (series.length < IV_RANK_MIN_SAMPLES || !Number.isFinite(ivNow)) {
      rej.push('iv_history_insufficient')
    } else {
      const below = series.filter((v) => v <= ivNow).length
      ivRank = (below / series.length) * 100
      ivWindowDays = Math.max(1, Math.round((maxT - minT) / 86_400_000))
      ivRankConfidence = ivWindowDays >= IV_RANK_HI_CONF_DAYS ? 'high' : 'low'
      if (ivRank < IV_RANK_MIN) rej.push('iv_rank_low')
    }
  }
  const c5 = ivRank != null && ivRank >= IV_RANK_MIN

  // ── Condition 6: put wall stable (no 2+ strike migration) ──
  // Softened to the iv-rank pattern: thin history is NOT a hard
  // reject. With >= 2 daily wall points we measure migration; with
  // fewer we cannot, so we PASS the gate but stamp
  // wall_stable_confidence='low' (window < WALL_STABLE_DAYS) so the
  // UI warns loudly — absence of evidence is not evidence of
  // instability. Active migration stays a HARD reject: that is
  // positive evidence against, not missing evidence.
  let wallStableDays = 0
  let wallStableConfidence: 'high' | 'low' = 'low'
  let c6 = false
  {
    const { data: hist } = await admin
      .from('gex_history')
      .select('snapshot_at, payload')
      .eq('ticker', ticker)
      .gte('snapshot_at', new Date(Date.now() - 6 * 86_400_000).toISOString())
      .order('snapshot_at', { ascending: false })
      .limit(2000)
    // Last snapshot per UTC day → derive that day's put wall.
    const byDay = new Map<string, { strike: number | null }>()
    for (const row of hist ?? []) {
      const at = (row as { snapshot_at: string }).snapshot_at
      const day = at.slice(0, 10)
      if (byDay.has(day)) continue // rows are desc → first seen = latest
      const p = (row as { payload?: { strikes?: number[]; cells?: (number | null)[][] } }).payload
      const dw = p?.strikes && p?.cells ? deriveWalls(p.strikes, p.cells) : { putWall: null }
      byDay.set(day, { strike: dw.putWall })
    }
    const recentDays = Array.from(byDay.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, WALL_STABLE_DAYS)
    const wallStrikes = recentDays
      .map(([, v]) => v.strike)
      .filter((s): s is number => typeof s === 'number')
    wallStableDays = wallStrikes.length
    if (wallStrikes.length >= 2) {
      const movedStrikes = (Math.max(...wallStrikes) - Math.min(...wallStrikes)) / (strikeStep || 1)
      c6 = movedStrikes < WALL_MIGRATION_STRIKES
      wallStableConfidence = wallStrikes.length >= WALL_STABLE_DAYS ? 'high' : 'low'
      if (!c6) rej.push('walls_migrating')
    } else {
      c6 = true
      wallStableConfidence = 'low'
    }
  }

  // ── Choose expiration: PREFER the monthly (OPEX-aligned). ──
  // The wheel is canonically a monthly-put strategy. A monthly expires
  // ON OPEX, so it has no INTERVENING OPEX during the hold — that is
  // what lets condition 7 be satisfiable at all. Picking the nearest-
  // DTE weekly instead routinely lands AFTER the monthly OPEX, which
  // then (correctly) trips the intervening-OPEX gate, making the wheel
  // structurally near-unable to fire. So: among in-band expirations,
  // prefer ones whose date IS an OPEX date; only fall back to the
  // closest-DTE weekly if no monthly is in band.
  const todayStr = new Date().toISOString().slice(0, 10)
  const horizon = new Date(Date.now() + 75 * 86_400_000).toISOString().slice(0, 10)
  const { data: opexUpcoming } = await admin
    .from('opex_dates')
    .select('opex_date')
    .gte('opex_date', todayStr)
    .lte('opex_date', horizon)
    .order('opex_date', { ascending: true })
  const opexDates = (opexUpcoming ?? []).map((r) => (r as { opex_date: string }).opex_date)
  const opexSet = new Set(opexDates)

  const inBand = (m.expirations || []).filter((e) => e.dte >= DTE_MIN && e.dte <= DTE_MAX)
  const monthly = inBand.filter((e) => opexSet.has(e.date))
  const pool = (monthly.length ? monthly : inBand)
    .slice()
    .sort((a, b) => Math.abs(a.dte - DTE_TARGET) - Math.abs(b.dte - DTE_TARGET))
  if (pool.length === 0) {
    if (!rej.includes('no_target_expiration')) rej.push('no_target_expiration')
    return { suggestion: null, rejections: rej, constructable: false }
  }
  const exp = pool[0]

  // ── Condition 7: catalyst. OPEX hard-gates; earnings + macro have
  //    no feed → UNVERIFIED (loud in UI, not a silent pass). ──
  const catalystCheck: Record<string, string> = { opex: 'clear', earnings: 'UNVERIFIED', macro: 'UNVERIFIED' }
  // OPEX is disqualifying only when one falls STRICTLY BEFORE the
  // expiration — an intervening monthly-OPEX gamma event during the
  // hold. The expiration's own OPEX (a monthly expiring on OPEX) is
  // the structure's natural exit, not a mid-hold shock.
  const opexNext = m.opex?.next_date ?? null
  const intervening =
    (opexNext != null && opexNext >= todayStr && opexNext < exp.date) ||
    opexDates.some((d) => d >= todayStr && d < exp.date)
  if (intervening) catalystCheck.opex = 'blocked'
  // Earnings / macro: if a feed ever lands rows, this hard-gates
  // automatically. Empty today → stays UNVERIFIED.
  const { data: earn } = await admin
    .from('earnings_calendar')
    .select('earnings_date')
    .eq('ticker', ticker)
    .gte('earnings_date', todayStr)
    .lte('earnings_date', exp.date)
    .limit(1)
  if ((earn ?? []).length > 0) catalystCheck.earnings = 'blocked'
  else {
    const { count: earnCount } = await admin
      .from('earnings_calendar')
      .select('*', { count: 'exact', head: true })
    if ((earnCount ?? 0) > 0) catalystCheck.earnings = 'clear'
  }
  const { data: macro } = await admin
    .from('market_events')
    .select('event_date')
    .is('ticker', null)
    .gte('event_date', todayStr)
    .lte('event_date', exp.date)
    .limit(1)
  if ((macro ?? []).length > 0) catalystCheck.macro = 'blocked'
  else {
    const { count: macroCount } = await admin
      .from('market_events')
      .select('*', { count: 'exact', head: true })
    if ((macroCount ?? 0) > 0) catalystCheck.macro = 'clear'
  }
  // The hard part of condition 7 is OPEX + any feed that DOES exist.
  const c7 = catalystCheck.opex === 'clear'
    && catalystCheck.earnings !== 'blocked'
    && catalystCheck.macro !== 'blocked'
  if (catalystCheck.opex === 'blocked') rej.push('opex_within_dte')
  if (catalystCheck.earnings === 'blocked') rej.push('earnings_within_dte')
  if (catalystCheck.macro === 'blocked') rej.push('macro_within_dte')

  // ── CSP construction: ~0.30Δ put at/below the put wall ──
  // Strike chosen from the matrix grid by Black-Scholes delta (iv =
  // front ATM IV — fine for picking the strike; the premium is NOT
  // modelled). Then the chosen single strike is Polygon-verified for
  // a real market mid. dxlink_quotes can't be used here — it only
  // streams near weeklies, never the 25–45 DTE monthly.
  const ivForDelta = Number(m.iv_used)
  let bestStrike: number | null = null
  let bestDelta = NaN
  if (Number.isFinite(ivForDelta) && ivForDelta > 0) {
    for (const k of m.strikes || []) {
      if (k > (putWall as number) || k >= spot) continue // at/below put wall
      const d = bsPutDelta(spot, k, ivForDelta, exp.dte)
      const ad = Math.abs(d)
      if (!Number.isFinite(ad) || ad < DELTA_LO || ad > DELTA_HI) continue
      if (bestStrike == null || Math.abs(ad - DELTA_TARGET) < Math.abs(Math.abs(bestDelta) - DELTA_TARGET)) {
        bestStrike = k
        bestDelta = d
      }
    }
  }
  if (bestStrike == null) {
    if (!rej.includes('no_csp_strike')) rej.push('no_csp_strike')
    return { suggestion: null, rejections: rej, constructable: false }
  }
  const quote = await polygonPutMid(ticker, exp.date, bestStrike)
  if (!quote || !(quote.mid > 0)) {
    if (!rej.includes('no_csp_quote')) rej.push('no_csp_quote')
    return { suggestion: null, rejections: rej, constructable: false }
  }
  const best = { strike: bestStrike, mid: quote.mid, delta: bestDelta }

  // ── Economics + minimum annualized yield ──
  const collateralPerContract = best.strike * 100
  const annualizedPct = (best.mid / best.strike) * (365 / exp.dte) * 100
  const constructable = true
  if (annualizedPct < MIN_ANNUALIZED_PCT) {
    rej.push('yield_below_min')
  }

  const conditions = {
    net_gex_positive: c1,
    pin_prob_ok: c2,
    spot_between_walls: c3,
    expected_move_ok: c4,
    iv_rank_ok: c5,
    walls_stable: c6,
    catalyst_clear: c7,
  }
  const allPass = Object.values(conditions).every(Boolean) && annualizedPct >= MIN_ANNUALIZED_PCT
  if (!allPass) {
    return { suggestion: null, rejections: Array.from(new Set(rej)), constructable }
  }

  // Sizing vs a reference NLV (per-user 25%/60% caps are enforced at
  // log/order time — the scanner has no portfolio, so it surfaces the
  // single-position collateral and a reference contract count only).
  const maxCollateral = ACCOUNT_SIZE_REFERENCE * PER_TICKER_COLLATERAL_CAP
  const contracts = Math.max(1, Math.floor(maxCollateral / collateralPerContract))

  return {
    constructable,
    rejections: [],
    suggestion: {
      ticker,
      leg: 'csp',
      strike: best.strike,
      expiration: exp.date,
      dte: exp.dte,
      delta: best.delta,
      premium: best.mid,
      contracts,
      collateral_cash: collateralPerContract,
      annualized_pct: Number(annualizedPct.toFixed(2)),
      net_gex: Number(m.net_gex),
      regime: 'A',
      spot,
      put_wall: putWall,
      call_wall: callWall,
      flip,
      pin_probability: Number(pin.toFixed(3)),
      iv_rank: ivRank == null ? null : Number(ivRank.toFixed(1)),
      iv_rank_confidence: ivRankConfidence,
      iv_rank_window_days: ivWindowDays,
      expected_move: Number(em.toFixed(2)),
      wall_stable_days: wallStableDays,
      wall_stable_confidence: wallStableConfidence,
      catalyst_check: catalystCheck,
      conditions,
    },
  }
}
