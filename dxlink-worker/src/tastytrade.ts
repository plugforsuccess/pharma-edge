// Tastytrade REST helpers needed by the worker:
//  1. POST /sessions          — get a session-token from username/password
//  2. GET  /api-quote-tokens  — exchange session-token for a DXLink streamer
//                                token + websocket URL (24h TTL)
//  3. GET  /option-chains/{symbol}/nested — pull strikes + OCC streamer
//                                            symbols for a ticker
//
// We don't share `tastytrade_sessions` with the edge-function helpers
// because the worker is a long-lived process: it just keeps tokens in
// memory and refreshes them on a timer / on 401.

const BASE =
  Deno.env.get('TASTYTRADE_BASE_URL') || 'https://api.tastyworks.com'
const USERNAME = Deno.env.get('TASTYTRADE_USERNAME')
const PASSWORD = Deno.env.get('TASTYTRADE_PASSWORD')

export interface SessionAuth {
  sessionToken: string
  expiresAt: number   // ms epoch
}

export interface StreamerAuth {
  token: string
  url: string         // wss URL we open the dxFeed connection to
  expiresAt: number   // ms epoch
}

export async function login(): Promise<SessionAuth> {
  if (!USERNAME || !PASSWORD) {
    throw new Error('TASTYTRADE_USERNAME / TASTYTRADE_PASSWORD env vars not set')
  }
  const resp = await fetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login: USERNAME,
      password: PASSWORD,
      'remember-me': true,
    }),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`tastytrade login ${resp.status}: ${detail.slice(0, 200)}`)
  }
  const body = await resp.json()
  const token = body?.data?.['session-token']
  if (!token) throw new Error('tastytrade login: no session-token in response')
  return {
    sessionToken: token,
    // sessions live ~24h; treat 23h as the safe expiry
    expiresAt: Date.now() + 23 * 60 * 60 * 1000,
  }
}

export async function getStreamerAuth(session: SessionAuth): Promise<StreamerAuth> {
  // /api-quote-tokens returns { data: { token, dxlink-url, level } }
  // Tokens are 24h; we'll refresh ~22h.
  const resp = await fetch(`${BASE}/api-quote-tokens`, {
    headers: { Authorization: session.sessionToken },
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
    { headers: { Authorization: session.sessionToken } },
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

// Equity quote streamer symbol is the bare ticker prefixed with nothing
// — but option streamer symbols are dxFeed-style, e.g. ".AAPL240517C150".
// fetchNestedChain returns both fields so we can subscribe correctly.
export function equityStreamerSymbol(ticker: string): string {
  return ticker.toUpperCase()
}
