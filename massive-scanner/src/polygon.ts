// Polygon (rebranded Massive) Options Advanced API client.
//
// We use the trades feed (`/v3/trades/{options_ticker}`) + reference
// chain (`/v3/snapshot/options/{underlying}`) endpoints. Trades comes
// back per-contract; we need to aggregate by underlying then qualify
// the largest prints against the bot's filter (premium $, side, etc).
//
// Polygon's `trades` response includes price + size; premium dollars =
// price × size × 100. Side detection comes from `conditions` (codes 12,
// 41 ≈ aggressor-buy; 13, 42 ≈ aggressor-sell). Bid/ask snapshots come
// from the `snapshot/options` endpoint.
//
// Rate limit: Options Advanced is "unlimited" for REST. We still
// debounce per-symbol so a thrashing chain doesn't burn requests.

const POLYGON_BASE = Deno.env.get('POLYGON_BASE_URL') || 'https://api.polygon.io'
const MASSIVE_API_KEY = Deno.env.get('MASSIVE_API_KEY')

export class PolygonError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

interface PolygonTrade {
  price: number
  size: number
  timestamp: number  // ns since epoch
  conditions?: number[]
  exchange?: number
}

interface OptionContractSnapshot {
  details?: {
    contract_type?: 'call' | 'put'
    expiration_date?: string
    strike_price?: number
    ticker?: string
  }
  day?: { volume?: number; vwap?: number }
  open_interest?: number
  last_quote?: { bid?: number; ask?: number; last_updated?: number }
  last_trade?: { price?: number; size?: number; sip_timestamp?: number; conditions?: number[] }
  implied_volatility?: number
  greeks?: { gamma?: number; delta?: number; vega?: number; theta?: number }
  underlying_asset?: { ticker?: string; price?: number }
}

function authParam(): string {
  if (!MASSIVE_API_KEY) throw new PolygonError('MASSIVE_API_KEY not set')
  return `apiKey=${encodeURIComponent(MASSIVE_API_KEY)}`
}

async function getJson<T>(path: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?'
  const url = `${POLYGON_BASE}${path}${sep}${authParam()}`
  const resp = await fetch(url)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new PolygonError(`polygon ${resp.status} ${path}: ${text.slice(0, 200)}`, resp.status)
  }
  return resp.json() as Promise<T>
}

// Get the full option chain snapshot for an underlying (all expiries,
// all strikes). We use the strike/expiry filter params to keep payload
// reasonable.
export async function getChainSnapshot(
  underlying: string,
  opts: { strikeMinPct?: number; strikeMaxPct?: number; expiryFrom?: string; expiryTo?: string } = {},
): Promise<{ underlyingPrice: number; contracts: OptionContractSnapshot[] }> {
  const params = new URLSearchParams()
  params.set('limit', '250')
  if (opts.expiryFrom) params.set('expiration_date.gte', opts.expiryFrom)
  if (opts.expiryTo) params.set('expiration_date.lte', opts.expiryTo)
  const body = await getJson<{ results?: OptionContractSnapshot[] }>(
    `/v3/snapshot/options/${encodeURIComponent(underlying)}?${params.toString()}`,
  )
  const results = body.results ?? []
  const underlyingPrice = Number(results[0]?.underlying_asset?.price) || 0
  return { underlyingPrice, contracts: results }
}

// Get the last N trades for a single option contract (e.g. for the
// last 60 seconds).
export async function getRecentOptionTrades(
  optionTicker: string,
  limit = 100,
  sinceNs?: bigint,
): Promise<PolygonTrade[]> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('order', 'desc')
  if (sinceNs) params.set('timestamp.gt', sinceNs.toString())
  const body = await getJson<{ results?: PolygonTrade[] }>(
    `/v3/trades/${encodeURIComponent(optionTicker)}?${params.toString()}`,
  )
  return body.results ?? []
}

// Aggressor side from Polygon condition codes.
// 12, 41 → aggressor buy; 13, 42 → aggressor sell. Otherwise mid.
export function sideFromConditions(conditions?: number[]): 'buy' | 'sell' | 'mid' {
  if (!conditions || !conditions.length) return 'mid'
  if (conditions.includes(12) || conditions.includes(41)) return 'buy'
  if (conditions.includes(13) || conditions.includes(42)) return 'sell'
  return 'mid'
}

// Polygon option ticker format: O:AAPL250620C00150000
// Parse out the components.
export function parseOptionTicker(t: string): {
  underlying: string
  expiry: string
  type: 'C' | 'P'
  strike: number
} | null {
  const m = t.match(/^O:([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
  if (!m) return null
  const [, underlying, yy, mm, dd, type, strikeStr] = m
  const expiry = `20${yy}-${mm}-${dd}`
  const strike = Number(strikeStr) / 1000
  return { underlying, expiry, type: type as 'C' | 'P', strike }
}

export type { OptionContractSnapshot, PolygonTrade }
