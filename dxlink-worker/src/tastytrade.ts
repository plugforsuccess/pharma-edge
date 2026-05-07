// Tastytrade REST helpers needed by the worker:
//  1. POST /oauth/token        — exchange refresh_token for an access_token
//                                 (~24h TTL)
//  2. GET  /api-quote-tokens   — exchange access_token for a DXLink streamer
//                                 token + websocket URL (24h TTL)
//  3. GET  /option-chains/{symbol}/nested — pull strikes + OCC streamer
//                                            symbols for a ticker
//
// We don't share `tastytrade_sessions` with the edge-function helpers
// because the worker is a long-lived process: tokens stay in memory
// and refresh on a timer / on 401. The `login()` export name is
// preserved for caller compatibility but it now performs OAuth refresh.
//
// Required Fly secrets:
//   TASTYTRADE_CLIENT_ID
//   TASTYTRADE_CLIENT_SECRET
//   TASTYTRADE_REFRESH_TOKEN

const BASE =
  Deno.env.get('TASTYTRADE_BASE_URL') || 'https://api.tastyworks.com'
const CLIENT_ID = Deno.env.get('TASTYTRADE_CLIENT_ID')
const CLIENT_SECRET = Deno.env.get('TASTYTRADE_CLIENT_SECRET')
let CURRENT_REFRESH_TOKEN = Deno.env.get('TASTYTRADE_REFRESH_TOKEN') ?? ''

export interface SessionAuth {
  sessionToken: string  // OAuth access_token (kept name for caller compat)
  expiresAt: number     // ms epoch
}

export interface StreamerAuth {
  token: string
  url: string           // wss URL we open the dxFeed connection to
  expiresAt: number     // ms epoch
}

// `login()` keeps its name so call-sites in main.ts don't change. It
// now performs an OAuth refresh-token grant. Tastytrade may rotate
// the refresh_token on each exchange; if so we cache the new value
// in process memory (re-read happens on next worker restart from the
// Fly secret, which means a rotated token effectively only survives
// for the lifetime of the process unless the operator updates the
// secret. In practice Tastytrade refresh tokens rotate rarely and
// the worker restarts on deploys, so this is fine).
export async function login(): Promise<SessionAuth> {
  if (!CLIENT_ID || !CLIENT_SECRET || !CURRENT_REFRESH_TOKEN) {
    throw new Error(
      'TASTYTRADE_CLIENT_ID / TASTYTRADE_CLIENT_SECRET / TASTYTRADE_REFRESH_TOKEN env vars not set',
    )
  }
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: CURRENT_REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  })
  const resp = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`tastytrade oauth refresh ${resp.status}: ${detail.slice(0, 200)}`)
  }
  const body = await resp.json()
  const accessToken: string | undefined = body?.access_token
  const expiresIn: number = Number(body?.expires_in) || 23 * 60 * 60
  if (body?.refresh_token) CURRENT_REFRESH_TOKEN = body.refresh_token
  if (!accessToken) throw new Error('tastytrade oauth refresh: no access_token in response')
  return {
    sessionToken: accessToken,
    // 5-min buffer so we proactively refresh before real expiry.
    expiresAt: Date.now() + (expiresIn - 300) * 1000,
  }
}

export async function getStreamerAuth(session: SessionAuth): Promise<StreamerAuth> {
  // /api-quote-tokens returns { data: { token, dxlink-url, level } }
  // Tokens are 24h; we'll refresh ~22h.
  const resp = await fetch(`${BASE}/api-quote-tokens`, {
    headers: { Authorization: `Bearer ${session.sessionToken}` },
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`api-quote-tokens ${resp.status}: ${detail.slice(0, 200)}`)
  }
  const body = await resp.json()
  const data = body?.data
  if (!data?.token || !data?.['dxlink-url']) {
    throw new Error('api-quote-tokens: missing token or dxlink-url')
  }
  return {
    token: data.token,
    url: data['dxlink-url'],
    expiresAt: Date.now() + 22 * 60 * 60 * 1000,
  }
}

export interface ChainStrike {
  strike: number
  callOcc: string         // OCC symbol for use as the option streamer symbol
  putOcc: string
  callStreamer: string    // dxFeed-style streamer symbol (.AAPL250119C150)
  putStreamer: string
}

export interface ChainExpiration {
  expirationDate: string  // YYYY-MM-DD
  daysToExpiration: number
  strikes: ChainStrike[]
}

export async function fetchNestedChain(
  session: SessionAuth,
  ticker: string,
): Promise<ChainExpiration[]> {
  const resp = await fetch(
    `${BASE}/option-chains/${encodeURIComponent(ticker.toUpperCase())}/nested`,
    { headers: { Authorization: `Bearer ${session.sessionToken}` } },
  )
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(
      `option-chains/${ticker} ${resp.status}: ${detail.slice(0, 200)}`,
    )
  }
  const body = await resp.json()
  const root = body?.data?.items?.[0]
  if (!root) return []
  const rawExpirations = (root['expirations'] ?? []) as Array<Record<string, unknown>>
  return rawExpirations
    .map((exp) => {
      const strikes = (exp['strikes'] ?? []) as Array<Record<string, unknown>>
      return {
        expirationDate: String(exp['expiration-date'] ?? ''),
        daysToExpiration: Number(exp['days-to-expiration'] ?? 0),
        strikes: strikes
          .map((s) => ({
            strike: Number(s['strike-price']),
            callOcc: String(s['call'] ?? ''),
            putOcc: String(s['put'] ?? ''),
            callStreamer: String(s['call-streamer-symbol'] ?? s['call'] ?? ''),
            putStreamer: String(s['put-streamer-symbol'] ?? s['put'] ?? ''),
          }))
          .filter((s) => Number.isFinite(s.strike) && s.callStreamer && s.putStreamer),
      }
    })
    .filter((e) => e.expirationDate && e.strikes.length > 0)
}

// Tastytrade `/market-metrics` returns market summary data (OI, IV
// rank, beta, etc.) for up to ~100 symbols per call. We use it to
// snapshot open_interest for every option in the subscription plan
// — the dxFeed Summary frames that should also carry OI are
// unreliable as a first-time seed (they're snapshot-on-change,
// missing on quiet symbols), so this REST snapshot is the
// reliable source.
//
// Returns a Map<OCC symbol, openInterest>. Symbols with no OI on
// file (illiquid wing strikes) are absent from the map; callers
// should treat absent as "unknown" not "zero".
//
// Rate-limited: call at chain-refresh cadence (every 4h), not on
// every Quote frame. With ~16k option symbols across the streamed
// universe and ~100 per request, that's ~160 requests per refresh —
// well under any sane rate limit.
const MARKET_METRICS_BATCH = 100

export async function fetchOpenInterestMap(
  session: SessionAuth,
  occSymbols: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (occSymbols.length === 0) return result

  for (let i = 0; i < occSymbols.length; i += MARKET_METRICS_BATCH) {
    const batch = occSymbols.slice(i, i + MARKET_METRICS_BATCH)
    const url = `${BASE}/market-metrics?symbols=${batch.map(encodeURIComponent).join(',')}`
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      })
      if (!resp.ok) {
        // Don't blow up the whole snapshot on a single batch failure;
        // log + skip so the worker still gets partial OI coverage.
        console.warn(`[market-metrics] batch ${i / MARKET_METRICS_BATCH} → ${resp.status}`)
        continue
      }
      const body = await resp.json()
      const items = (body?.data?.items ?? []) as Array<Record<string, unknown>>
      for (const item of items) {
        const sym = String(item['symbol'] ?? '')
        const oi = Number(item['option-open-interest'])
        if (sym && Number.isFinite(oi)) result.set(sym, oi)
      }
    } catch (e) {
      console.warn(`[market-metrics] batch fetch failed:`, e)
    }
  }
  return result
}

// Equity quote streamer symbol is the bare ticker prefixed with nothing
// — but option streamer symbols are dxFeed-style, e.g. ".AAPL240517C150".
// fetchNestedChain returns both fields so we can subscribe correctly.
export function equityStreamerSymbol(ticker: string): string {
  return ticker.toUpperCase()
}
