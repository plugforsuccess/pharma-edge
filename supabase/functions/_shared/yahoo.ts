// Yahoo Finance — daily bars and option chains (unofficial endpoints).
//
// Used by price-history and suggest-leaps (owner, 2026-10-03: Yahoo is
// the market-data source; the Polygon subscription was cancelled).
//
//   yahooChart(symbol, range, interval) /v8/finance/chart — no auth needed
//   yahooBars(symbol, range)        daily bars only
//   yahooOptions(symbol, dateUnix?) /v7/finance/options — cookie + crumb
//
// The options endpoint is gated behind a cookie+crumb pair (the same flow
// yfinance uses): hit fc.yahoo.com for session cookies, exchange them at
// /v1/test/getcrumb for a token, cache the pair ~30 min in module scope.
// Data can lag up to 15 minutes and the endpoints can change without
// notice; callers treat a failure as "no data", never as a zero.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const CRUMB_TTL_MS = 30 * 60 * 1000
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']

// t: 'YYYY-MM-DD' for daily bars; for intraday bars, unix seconds of the
// New York wall-clock time read as UTC (so charts label times in ET).
export interface Bar { t: string | number; o: number; h: number; l: number; c: number; v: number }

export class YahooError extends Error {
  status?: number
  constructor(msg: string, status?: number) {
    super(msg)
    this.status = status
  }
}

// Exchange-day date for a bar timestamp (bars are stamped in ET).
const etDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms))
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})
// Unix seconds of the ET wall-clock time, read as UTC.
function etWallSeconds(ms: number): number {
  const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000
}

export async function yahooBars(symbol: string, range: string): Promise<Bar[]> {
  return (await yahooChart(symbol, range, '1d')).bars
}

export async function yahooChart(symbol: string, range: string, interval: string): Promise<{ bars: Bar[]; prevClose: number | null }> {
  // Minute / hour bars carry a time; day, week and month bars a date.
  const intraday = /m$|h$/.test(interval)
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`
  let last = 'no response'
  for (const host of HOSTS) {
    try {
      const resp = await fetch(`https://${host}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      if (!resp.ok) { last = String(resp.status); continue }
      const body = await resp.json()
      const r = body?.chart?.result?.[0]
      const ts: number[] = r?.timestamp ?? []
      const q = r?.indicators?.quote?.[0] ?? {}
      const bars: Bar[] = []
      ts.forEach((s, i) => {
        const c = Number(q.close?.[i])
        if (!Number.isFinite(c) || c <= 0) return
        bars.push({
          t: intraday ? etWallSeconds(s * 1000) : etDay(s * 1000), c,
          o: Number(q.open?.[i]) || c, h: Number(q.high?.[i]) || c, l: Number(q.low?.[i]) || c,
          v: Number(q.volume?.[i]) || 0,
        })
      })
      const prev = Number(r?.meta?.chartPreviousClose ?? r?.meta?.previousClose)
      if (bars.length) return { bars, prevClose: Number.isFinite(prev) && prev > 0 ? prev : null }
      last = 'empty'
    } catch (e) {
      last = (e as Error).message
    }
  }
  throw new YahooError(`yahoo bars ${symbol}: ${last}`)
}

let cachedAuth: { cookie: string; crumb: string; expiresAt: number } | null = null
let pendingAuth: Promise<{ cookie: string; crumb: string }> | null = null

// Parallel callers share one bootstrap.
function getYahooAuth(): Promise<{ cookie: string; crumb: string }> {
  if (cachedAuth && cachedAuth.expiresAt > Date.now()) return Promise.resolve(cachedAuth)
  pendingAuth ??= bootstrapAuth().finally(() => { pendingAuth = null })
  return pendingAuth
}

async function bootstrapAuth(): Promise<{ cookie: string; crumb: string }> {
  const now = Date.now()

  // fc.yahoo.com answers 404 but sets the session cookies we need.
  const cookieResp = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'manual' })
  await cookieResp.body?.cancel().catch(() => {})
  type HeadersWithSet = Headers & { getSetCookie?: () => string[] }
  const headers = cookieResp.headers as HeadersWithSet
  let setCookies: string[] = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  if (setCookies.length === 0) {
    const raw = cookieResp.headers.get('set-cookie')
    if (raw) setCookies = raw.split(/,(?=\s*[A-Za-z][A-Za-z0-9_-]*=)/)
  }
  const cookie = setCookies.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ')
  if (!cookie) throw new YahooError('yahoo: no session cookies')

  const crumbResp = await fetch(`https://${HOSTS[0]}/v1/test/getcrumb`, { headers: { 'User-Agent': UA, Cookie: cookie, Accept: '*/*' } })
  if (!crumbResp.ok) throw new YahooError(`yahoo crumb: ${crumbResp.status}`, crumbResp.status)
  const crumb = (await crumbResp.text()).trim()
  if (!crumb || crumb.length > 64 || crumb.includes('<')) throw new YahooError('yahoo crumb: invalid response')

  cachedAuth = { cookie, crumb, expiresAt: now + CRUMB_TTL_MS }
  return cachedAuth
}

export interface YahooOptionContract {
  contractSymbol?: string
  strike?: number
  bid?: number
  ask?: number
  lastPrice?: number
  openInterest?: number
  volume?: number
  impliedVolatility?: number
  expiration?: number
}
export interface YahooOptionResult {
  underlyingSymbol?: string
  expirationDates?: number[]
  quote?: { regularMarketPrice?: number }
  options?: Array<{ expirationDate?: number; calls?: YahooOptionContract[]; puts?: YahooOptionContract[] }>
}

// One expiration's chain (or the nearest, with every expiration date listed).
export async function yahooOptions(symbol: string, dateUnix?: number): Promise<YahooOptionResult> {
  const { cookie, crumb } = await getYahooAuth()
  const params = new URLSearchParams({ crumb })
  if (dateUnix) params.set('date', String(dateUnix))
  let last = 'no response'
  for (const host of HOSTS) {
    try {
      const resp = await fetch(`https://${host}/v7/finance/options/${encodeURIComponent(symbol)}?${params}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie }, signal: AbortSignal.timeout(8000),
      })
      if (resp.ok) {
        const body = await resp.json()
        const result = body?.optionChain?.result?.[0]
        if (result) return result as YahooOptionResult
        last = 'empty'
        continue
      }
      last = String(resp.status)
      if (resp.status === 401) cachedAuth = null
    } catch (e) {
      last = (e as Error).message
    }
  }
  throw new YahooError(`yahoo options ${symbol}: ${last}`)
}

// Black-Scholes call delta (Yahoo gives IV, not greeks).
export function callDelta(spot: number, strike: number, years: number, iv: number, rate = 0.04): number | null {
  if (!(spot > 0 && strike > 0 && years > 0 && iv > 0)) return null
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * years) / (iv * Math.sqrt(years))
  return normCdf(d1)
}

function normCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}
