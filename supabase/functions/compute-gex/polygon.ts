// Polygon (Massive) chain source for compute-gex.
//
// Mirrors yahoo.ts's exported interface so the existing GEX compute
// functions can swap data sources without restructuring. Polygon's
// /v3/snapshot/options/{underlying} endpoint returns OI + Greeks +
// IV per contract per expiry — everything compute-gex needs.
//
// Why primary: Polygon is real-time (sub-second) on Options Advanced,
// covers every listed underlying (not just the ~15 in DXLink's curated
// subscription), and we're already paying $199/mo. dxlink_quotes
// remains the secondary source for resiliency.
//
// Required env: MASSIVE_API_KEY.

const POLYGON_BASE = Deno.env.get('POLYGON_BASE_URL') || 'https://api.polygon.io'
const MASSIVE_API_KEY = Deno.env.get('MASSIVE_API_KEY')

// Map app-internal ticker symbols to Polygon's options-snapshot
// underlying ticker. Polygon's `/v3/snapshot/options/{underlying}`
// expects the SPOT underlying, not the options root.
//   * SPXW (S&P 500 Weekly options root) → SPX (the index)
//   * Yahoo-style ^SPX → SPX
//   * VIXW / VIX → VIX (index, served as I:VIX on some endpoints)
// Add mappings as we discover more cases. Unknown tickers pass through.
const POLYGON_UNDERLYING_OVERRIDES: Record<string, string> = {
  SPXW: 'SPX',
  '^SPX': 'SPX',
  VIXW: 'VIX',
  '^VIX': 'VIX',
}

function polygonUnderlying(t: string): string {
  const up = t.toUpperCase()
  return POLYGON_UNDERLYING_OVERRIDES[up] ?? up
}

export interface PolygonStrike {
  strike: number
  callOI: number
  putOI: number
  callIV: number | null
  putIV: number | null
  callGamma: number | null
  putGamma: number | null
  callDelta: number | null
  putDelta: number | null
  callVega: number | null
  putVega: number | null
  callTheta: number | null
  putTheta: number | null
}

export interface PolygonChain {
  ticker: string
  spot: number
  previousClose: number | null
  expirations: number[]       // unix-seconds, sorted ascending
  expirationDate: string      // YYYY-MM-DD of the expiry returned
  expirationUnix: number
  daysToExpiration: number
  strikes: PolygonStrike[]
}

export class PolygonError extends Error {
  status?: number
  constructor(msg: string, status?: number) {
    super(msg)
    this.status = status
  }
}

interface SnapshotContract {
  details?: {
    contract_type?: 'call' | 'put'
    expiration_date?: string
    strike_price?: number
    ticker?: string
  }
  day?: { volume?: number; vwap?: number; close?: number }
  open_interest?: number
  implied_volatility?: number
  greeks?: {
    delta?: number; gamma?: number; theta?: number; vega?: number
  }
  last_quote?: { bid?: number; ask?: number; last_updated?: number }
  last_trade?: { price?: number; sip_timestamp?: number }
  underlying_asset?: { ticker?: string; price?: number; change_to_break_even?: number; last_updated?: number }
}

async function fetchSnapshot(
  underlying: string,
  expiryFrom: string,
  expiryTo: string,
  strikeMin?: number,
  strikeMax?: number,
): Promise<SnapshotContract[]> {
  if (!MASSIVE_API_KEY) {
    throw new PolygonError('MASSIVE_API_KEY not set in Supabase secrets', 500)
  }
  const url = new URL(`${POLYGON_BASE}/v3/snapshot/options/${polygonUnderlying(underlying)}`)
  url.searchParams.set('expiration_date.gte', expiryFrom)
  url.searchParams.set('expiration_date.lte', expiryTo)
  // API-side strike filter when caller passes a window — drops 80-90%
  // of the payload for liquid names. Without this, SPY's 90d chain
  // pages out to 10K+ contracts, and the prior 5000-row cap was
  // truncating multi-expiry coverage (only 0DTE made it through).
  if (Number.isFinite(strikeMin)) {
    url.searchParams.set('strike_price.gte', String(Math.floor(strikeMin!)))
  }
  if (Number.isFinite(strikeMax)) {
    url.searchParams.set('strike_price.lte', String(Math.ceil(strikeMax!)))
  }
  url.searchParams.set('limit', '250')
  url.searchParams.set('apiKey', MASSIVE_API_KEY)

  // Polygon paginates via next_url. Walk every page so all expirations
  // are returned. The strike filter above prevents this from being
  // pathological.
  //
  // Polygon's next_url does NOT carry the apiKey forward — earlier
  // versions of this loop assumed it did, so page-2+ requests came
  // back 401 and only page-1 contracts (often 0DTE-only) made it
  // through. The reattachApiKey helper below ensures every request
  // carries the auth.
  function reattachApiKey(u: string): string {
    if (u.includes('apiKey=')) return u
    return u + (u.includes('?') ? '&' : '?') + `apiKey=${encodeURIComponent(MASSIVE_API_KEY!)}`
  }

  let nextUrl: string | null = url.toString()
  const all: SnapshotContract[] = []
  while (nextUrl) {
    const resp = await fetch(reattachApiKey(nextUrl))
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new PolygonError(
        `polygon ${resp.status} ${nextUrl}: ${text.slice(0, 200)}`,
        resp.status,
      )
    }
    const body: { results?: SnapshotContract[]; next_url?: string } = await resp.json()
    if (Array.isArray(body.results)) all.push(...body.results)
    nextUrl = body.next_url ?? null
  }
  return all
}

// Get the prior trading day's close for an underlying. Polygon's
// /v2/aggs/.../prev returns the previous regular-session close.
async function fetchPrevClose(underlying: string): Promise<number | null> {
  if (!MASSIVE_API_KEY) return null
  const url = new URL(`${POLYGON_BASE}/v2/aggs/ticker/${polygonUnderlying(underlying)}/prev`)
  url.searchParams.set('adjusted', 'true')
  url.searchParams.set('apiKey', MASSIVE_API_KEY)
  try {
    const resp = await fetch(url.toString())
    if (!resp.ok) return null
    const body: { results?: Array<{ c?: number }> } = await resp.json()
    const c = body.results?.[0]?.c
    return Number.isFinite(c) ? Number(c) : null
  } catch {
    return null
  }
}

// Midnight UTC of today, in epoch ms. DTE math compares expiry
// midnight to today midnight so tomorrow's expiry is always 1, not 0
// (which the prior `(expMs - Date.now())/86_400_000` would yield any
// time `now` was more than 12h past last midnight UTC).
function startOfTodayUtcMs(): number {
  const d = new Date()
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function unixSeconds(yyyyMmDd: string): number {
  return Math.floor(new Date(yyyyMmDd + 'T16:00:00-04:00').getTime() / 1000)
}

function pickExpiration(
  candidates: string[],
  preferredDte: number,
  override?: string | null,
): { date: string; dte: number } | null {
  if (!candidates.length) return null
  const today = startOfTodayUtcMs()
  if (override) {
    if (candidates.includes(override)) {
      const dte = Math.max(0, Math.round(
        (new Date(override + 'T00:00:00Z').getTime() - today) / 86_400_000,
      ))
      return { date: override, dte }
    }
    // not in chain, fall through to closest-to-preferred
  }
  const withDte = candidates.map((d) => ({
    date: d,
    dte: Math.max(0, Math.round((new Date(d + 'T00:00:00Z').getTime() - today) / 86_400_000)),
  }))
  // pick the expiry whose DTE is closest to preferredDte
  let best = withDte[0]
  let bestScore = Math.abs(best.dte - preferredDte)
  for (const w of withDte) {
    const s = Math.abs(w.dte - preferredDte)
    if (s < bestScore) { best = w; bestScore = s }
  }
  return best
}

// Returns chain in the same shape yahoo.ts returns, so the downstream
// compute functions can be shared.
export async function fetchPolygonChain(
  ticker: string,
  preferredDte: number,
  expirationOverride?: string | null,
): Promise<PolygonChain> {
  // 60d horizon — plenty for /reasoning single-strike views.
  const today = new Date().toISOString().slice(0, 10)
  const horizon = new Date()
  horizon.setUTCDate(horizon.getUTCDate() + 60)
  const horizonStr = horizon.toISOString().slice(0, 10)

  // Pre-filter strikes API-side using prev_close as a spot approximation.
  // ±35% window covers volatility blow-ups while still cutting the chain
  // payload by ~70%. The downstream STRIKE_WINDOW_PCT in compute-gex/index.ts
  // narrows further once we know the actual spot.
  const prevClose = await fetchPrevClose(ticker)
  const strikeMin = prevClose ? prevClose * 0.65 : undefined
  const strikeMax = prevClose ? prevClose * 1.35 : undefined

  const contracts = await fetchSnapshot(ticker, today, horizonStr, strikeMin, strikeMax)
  if (contracts.length === 0) {
    throw new PolygonError(`no option contracts returned for ${ticker}`, 502)
  }

  // Spot: take from any contract's underlying_asset.price (Polygon
  // populates the same value on every contract).
  let spot = 0
  for (const c of contracts) {
    const s = Number(c.underlying_asset?.price)
    if (Number.isFinite(s) && s > 0) { spot = s; break }
  }
  if (!spot) throw new PolygonError(`no spot price for ${ticker}`, 502)

  // Build the available-expirations list + pick the one we want.
  const expirySet = new Set<string>()
  for (const c of contracts) {
    const e = c.details?.expiration_date
    if (e) expirySet.add(e)
  }
  const expiries = Array.from(expirySet).sort()
  if (expiries.length === 0) throw new PolygonError('no expirations parsed', 502)
  const chosen = pickExpiration(expiries, preferredDte, expirationOverride)
  if (!chosen) throw new PolygonError('expiration selection failed', 502)

  // Group contracts at the chosen expiration by strike, splitting call/put.
  const byStrike = new Map<number, PolygonStrike>()
  for (const c of contracts) {
    if (c.details?.expiration_date !== chosen.date) continue
    const strike = Number(c.details.strike_price)
    if (!Number.isFinite(strike) || strike <= 0) continue
    const type = c.details.contract_type
    if (type !== 'call' && type !== 'put') continue
    const oi = Number(c.open_interest) || 0
    const iv = Number(c.implied_volatility)
    const ivVal = Number.isFinite(iv) && iv > 0 ? iv : null
    const gamma = Number(c.greeks?.gamma)
    const delta = Number(c.greeks?.delta)
    const vega = Number(c.greeks?.vega)
    const theta = Number(c.greeks?.theta)

    let existing = byStrike.get(strike)
    if (!existing) {
      existing = {
        strike,
        callOI: 0, putOI: 0,
        callIV: null, putIV: null,
        callGamma: null, putGamma: null,
        callDelta: null, putDelta: null,
        callVega: null, putVega: null,
        callTheta: null, putTheta: null,
      }
    }
    if (type === 'call') {
      existing.callOI = oi
      existing.callIV = ivVal
      existing.callGamma = Number.isFinite(gamma) ? gamma : null
      existing.callDelta = Number.isFinite(delta) ? delta : null
      existing.callVega = Number.isFinite(vega) ? vega : null
      existing.callTheta = Number.isFinite(theta) ? theta : null
    } else {
      existing.putOI = oi
      existing.putIV = ivVal
      existing.putGamma = Number.isFinite(gamma) ? gamma : null
      existing.putDelta = Number.isFinite(delta) ? delta : null
      existing.putVega = Number.isFinite(vega) ? vega : null
      existing.putTheta = Number.isFinite(theta) ? theta : null
    }
    byStrike.set(strike, existing)
  }
  const strikes = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike)
  if (strikes.length === 0) {
    throw new PolygonError(`no strikes found for ${ticker} ${chosen.date}`, 502)
  }

  return {
    ticker: ticker.toUpperCase(),
    spot,
    previousClose: prevClose,
    expirations: expiries.map(unixSeconds),
    expirationDate: chosen.date,
    expirationUnix: unixSeconds(chosen.date),
    daysToExpiration: chosen.dte,
    strikes,
  }
}

// Matrix-mode variant: returns multiple expirations worth of data so
// the heatmap can render the strikes × expirations grid. Returns the
// raw per-contract structure grouped by expiry for the matrix compute
// to pivot.
export interface PolygonMatrixExpiry {
  date: string
  dte: number
  strikes: PolygonStrike[]
}

export interface PolygonMatrixChain {
  ticker: string
  spot: number
  previousClose: number | null
  expiries: PolygonMatrixExpiry[]
}

export async function fetchPolygonMatrixChain(
  ticker: string,
  maxExpirations: number,
  strikeWindowPct: number,
): Promise<PolygonMatrixChain> {
  // 60d horizon — enough for the HeatPulse heatmap (further-out expiries
  // contribute negligible gamma anyway).
  const today = new Date().toISOString().slice(0, 10)
  const horizon = new Date()
  horizon.setUTCDate(horizon.getUTCDate() + 60)
  const horizonStr = horizon.toISOString().slice(0, 10)

  // Pre-filter strikes API-side. Use ±2× the eventual narrow window so
  // we have slack for spot drift between prev_close and current spot.
  const prevClose = await fetchPrevClose(ticker)
  const buffer = Math.max(strikeWindowPct * 2, 0.10)
  const strikeMin = prevClose ? prevClose * (1 - buffer) : undefined
  const strikeMax = prevClose ? prevClose * (1 + buffer) : undefined

  const contracts = await fetchSnapshot(ticker, today, horizonStr, strikeMin, strikeMax)
  if (contracts.length === 0) {
    throw new PolygonError(`no option contracts returned for ${ticker}`, 502)
  }

  let spot = 0
  for (const c of contracts) {
    const s = Number(c.underlying_asset?.price)
    if (Number.isFinite(s) && s > 0) { spot = s; break }
  }
  if (!spot) throw new PolygonError(`no spot price for ${ticker}`, 502)

  const lo = spot * (1 - strikeWindowPct)
  const hi = spot * (1 + strikeWindowPct)

  // Group by expiration
  const byExpiry = new Map<string, Map<number, PolygonStrike>>()
  for (const c of contracts) {
    const exp = c.details?.expiration_date
    const strike = Number(c.details?.strike_price)
    if (!exp || !Number.isFinite(strike) || strike < lo || strike > hi) continue
    const type = c.details?.contract_type
    if (type !== 'call' && type !== 'put') continue
    let strikeMap = byExpiry.get(exp)
    if (!strikeMap) { strikeMap = new Map(); byExpiry.set(exp, strikeMap) }

    const oi = Number(c.open_interest) || 0
    const iv = Number(c.implied_volatility)
    const ivVal = Number.isFinite(iv) && iv > 0 ? iv : null
    const gamma = Number(c.greeks?.gamma)
    const delta = Number(c.greeks?.delta)
    const vega = Number(c.greeks?.vega)
    const theta = Number(c.greeks?.theta)
    let existing = strikeMap.get(strike)
    if (!existing) {
      existing = {
        strike,
        callOI: 0, putOI: 0,
        callIV: null, putIV: null,
        callGamma: null, putGamma: null,
        callDelta: null, putDelta: null,
        callVega: null, putVega: null,
        callTheta: null, putTheta: null,
      }
    }
    if (type === 'call') {
      existing.callOI = oi
      existing.callIV = ivVal
      existing.callGamma = Number.isFinite(gamma) ? gamma : null
      existing.callDelta = Number.isFinite(delta) ? delta : null
      existing.callVega = Number.isFinite(vega) ? vega : null
      existing.callTheta = Number.isFinite(theta) ? theta : null
    } else {
      existing.putOI = oi
      existing.putIV = ivVal
      existing.putGamma = Number.isFinite(gamma) ? gamma : null
      existing.putDelta = Number.isFinite(delta) ? delta : null
      existing.putVega = Number.isFinite(vega) ? vega : null
      existing.putTheta = Number.isFinite(theta) ? theta : null
    }
    strikeMap.set(strike, existing)
  }

  // Sort expiries ascending, take the first maxExpirations
  const sortedExpiries = Array.from(byExpiry.keys()).sort().slice(0, maxExpirations)
  const todayMs = startOfTodayUtcMs()
  const expiries: PolygonMatrixExpiry[] = sortedExpiries.map((d) => ({
    date: d,
    dte: Math.max(0, Math.round((new Date(d + 'T00:00:00Z').getTime() - todayMs) / 86_400_000)),
    strikes: Array.from(byExpiry.get(d)!.values()).sort((a, b) => a.strike - b.strike),
  }))

  return {
    ticker: ticker.toUpperCase(),
    spot,
    previousClose: prevClose,
    expiries,
  }
}
