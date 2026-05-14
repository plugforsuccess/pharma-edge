// Cash Moves — shared option-spread pricing.
//
// Single source of truth for max_profit / max_loss / R/R / POP / EV /
// breakeven from a (ticker, structure, strikes, expiration) tuple
// plus live Polygon mids.
//
// Used by:
//   * suggest-plays            — verify candidates before persisting
//   * scan-universe-plays      — inherits via playSuggester
//   * refresh-play-quote       — live recompute on play detail
//
// Why this exists: Claude estimates pricing from heuristics (DTE +
// distance from spot + IV priors) without ever seeing the live bid/ask.
// On credit spreads its estimates have been measured 3-18× off the
// real market mids. Centralising pricing through Polygon and applying
// the same math everywhere makes those estimates a thing of the past
// — Claude only proposes the structure; the system computes the numbers.

const POLYGON_API_KEY = Deno.env.get('MASSIVE_API_KEY')!

export type Structure =
  | 'BEAR_CALL_CREDIT'
  | 'BULL_PUT_CREDIT'
  | 'BULL_CALL'
  | 'BEAR_PUT'

export interface SpreadClassification {
  optType: 'C' | 'P'
  isCredit: boolean
}

export function classifySpread(s: string): SpreadClassification | null {
  // Accept both upper-case scanner enum and kebab-case external form.
  const norm = s.toUpperCase().replace(/-/g, '_').replace(/_SPREAD$/, '')
  if (norm === 'BEAR_CALL_CREDIT' || norm === 'BEAR_CALL') return { optType: 'C', isCredit: true }
  if (norm === 'BULL_PUT_CREDIT' || norm === 'BULL_PUT') return { optType: 'P', isCredit: true }
  if (norm === 'BULL_CALL') return { optType: 'C', isCredit: false }
  if (norm === 'BEAR_PUT') return { optType: 'P', isCredit: false }
  return null
}

export interface OptionQuote {
  mid: number
  bid: number
  ask: number
  iv: number | null
  age_seconds: number
  underlying_price: number | null
}

export interface PricedSpread {
  ticker: string
  structure: string
  long_strike: number
  short_strike: number
  expiration: string
  spot: number
  long_mid: number
  short_mid: number
  long_bid: number
  long_ask: number
  short_bid: number
  short_ask: number
  iv_used: number
  quote_age_seconds: number
  is_credit: boolean
  credit_mid: number | null
  debit_mid: number | null
  width: number
  max_profit_per_spread: number
  max_loss_per_spread: number
  max_profit_dollars: number
  max_loss_dollars: number
  risk_reward: number
  breakeven: number
  entry_pop_bp: number
  ev_edge_bp: number
  pricing_source: 'verified' | 'rejected'
  rejection_reason?: string
}

export async function fetchPolygonOptionQuote(
  ticker: string,
  expiration: string,
  optType: 'C' | 'P',
  strike: number,
): Promise<OptionQuote | null> {
  const occTicker = buildOccTicker(ticker, expiration, optType, strike)
  const url = `https://api.polygon.io/v3/snapshot/options/${ticker.toUpperCase()}/${occTicker}?apiKey=${POLYGON_API_KEY}`
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return null
    const body = await resp.json()
    const r = body?.results
    if (!r) return null
    const bid = Number(r.last_quote?.bid)
    const ask = Number(r.last_quote?.ask)
    const midpoint = Number(r.last_quote?.midpoint)
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask <= 0 || ask < bid) return null
    const mid = Number.isFinite(midpoint) && midpoint > 0 ? midpoint : (bid + ask) / 2
    const iv = Number(r.implied_volatility)
    const underlying_price = Number(r.underlying_asset?.price)
    const tsNs = Number(r.last_quote?.last_updated)
    const ageSeconds = Number.isFinite(tsNs) && tsNs > 0
      ? Math.max(0, Math.floor((Date.now() - tsNs / 1e6) / 1000))
      : 0
    return {
      mid, bid, ask,
      iv: Number.isFinite(iv) && iv > 0 ? iv : null,
      age_seconds: ageSeconds,
      underlying_price: Number.isFinite(underlying_price) && underlying_price > 0 ? underlying_price : null,
    }
  } catch {
    return null
  }
}

export async function priceSpread(args: {
  ticker: string
  structure: string
  long_strike: number
  short_strike: number
  expiration: string
  max_quote_age_seconds?: number
}): Promise<PricedSpread> {
  const cls = classifySpread(args.structure)
  if (!cls) return rejection(args, `unsupported structure: ${args.structure}`)
  const width = Math.abs(args.long_strike - args.short_strike)
  if (width <= 0) return rejection(args, 'zero-width spread')

  const [longQ, shortQ] = await Promise.all([
    fetchPolygonOptionQuote(args.ticker, args.expiration, cls.optType, args.long_strike),
    fetchPolygonOptionQuote(args.ticker, args.expiration, cls.optType, args.short_strike),
  ])
  if (!longQ || !shortQ) return rejection(args, 'polygon quote unavailable for one or both legs')

  const maxAge = args.max_quote_age_seconds ?? 300
  if (longQ.age_seconds > maxAge || shortQ.age_seconds > maxAge) {
    return rejection(args, `stale quote: long ${longQ.age_seconds}s short ${shortQ.age_seconds}s`)
  }
  const spot = longQ.underlying_price ?? shortQ.underlying_price
  if (!spot) return rejection(args, 'no underlying price on snapshots')

  const spreadMid = cls.isCredit ? shortQ.mid - longQ.mid : longQ.mid - shortQ.mid
  if (!(spreadMid > 0) || spreadMid >= width) {
    return rejection(args, `degenerate pricing: mid $${spreadMid.toFixed(3)} vs width $${width}`)
  }

  const maxProfit = cls.isCredit ? spreadMid : width - spreadMid
  const maxLoss = cls.isCredit ? width - spreadMid : spreadMid
  const riskReward = maxProfit / maxLoss

  let breakeven: number
  if (cls.isCredit && cls.optType === 'C') breakeven = args.short_strike + spreadMid
  else if (cls.isCredit && cls.optType === 'P') breakeven = args.short_strike - spreadMid
  else if (!cls.isCredit && cls.optType === 'C') breakeven = args.long_strike + spreadMid
  else breakeven = args.long_strike - spreadMid

  const iv = shortQ.iv ?? longQ.iv ?? 0.30
  const dte = daysBetween(args.expiration)
  const popEntry = computePopBp({
    spot, strike: args.short_strike, iv, dte,
    isCallSide: cls.optType === 'C', isCredit: cls.isCredit,
  })
  const popDecimal = popEntry / 10000
  const evDollars = popDecimal * maxProfit - (1 - popDecimal) * maxLoss
  const evEdgeBp = Math.round((evDollars / maxLoss) * 10000)

  return {
    ticker: args.ticker.toUpperCase(),
    structure: args.structure,
    long_strike: args.long_strike,
    short_strike: args.short_strike,
    expiration: args.expiration,
    spot,
    long_mid: longQ.mid, short_mid: shortQ.mid,
    long_bid: longQ.bid, long_ask: longQ.ask,
    short_bid: shortQ.bid, short_ask: shortQ.ask,
    iv_used: iv,
    quote_age_seconds: Math.max(longQ.age_seconds, shortQ.age_seconds),
    is_credit: cls.isCredit,
    credit_mid: cls.isCredit ? spreadMid : null,
    debit_mid: cls.isCredit ? null : spreadMid,
    width,
    max_profit_per_spread: maxProfit,
    max_loss_per_spread: maxLoss,
    max_profit_dollars: Math.round(maxProfit * 100 * 100) / 100,
    max_loss_dollars: Math.round(maxLoss * 100 * 100) / 100,
    risk_reward: Number(riskReward.toFixed(4)),
    breakeven: Number(breakeven.toFixed(4)),
    entry_pop_bp: popEntry,
    ev_edge_bp: evEdgeBp,
    pricing_source: 'verified',
  }
}

function rejection(
  args: { ticker: string; structure: string; long_strike: number; short_strike: number; expiration: string },
  reason: string,
): PricedSpread {
  return {
    ticker: args.ticker.toUpperCase(),
    structure: args.structure,
    long_strike: args.long_strike,
    short_strike: args.short_strike,
    expiration: args.expiration,
    spot: 0, long_mid: 0, short_mid: 0,
    long_bid: 0, long_ask: 0, short_bid: 0, short_ask: 0,
    iv_used: 0, quote_age_seconds: 0,
    is_credit: false, credit_mid: null, debit_mid: null, width: 0,
    max_profit_per_spread: 0, max_loss_per_spread: 0,
    max_profit_dollars: 0, max_loss_dollars: 0,
    risk_reward: 0, breakeven: 0,
    entry_pop_bp: 0, ev_edge_bp: 0,
    pricing_source: 'rejected',
    rejection_reason: reason,
  }
}

function buildOccTicker(ticker: string, expiration: string, type: 'C' | 'P', strike: number): string {
  const exp = new Date(expiration + 'T00:00:00Z')
  const yy = String(exp.getUTCFullYear()).slice(-2)
  const mm = String(exp.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(exp.getUTCDate()).padStart(2, '0')
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0')
  return `O:${ticker.toUpperCase()}${yy}${mm}${dd}${type}${strikeStr}`
}

function daysBetween(expiration: string): number {
  const exp = new Date(expiration + 'T16:00:00-04:00')
  const days = (exp.getTime() - Date.now()) / 86_400_000
  return Math.max(0.01, days)
}

function computePopBp(args: {
  spot: number; strike: number; iv: number; dte: number
  isCallSide: boolean; isCredit: boolean
}): number {
  const r = 0.045
  const t = args.dte / 365
  if (!(args.iv > 0 && t > 0 && args.spot > 0 && args.strike > 0)) return 5000
  const sqrtT = Math.sqrt(t)
  const d2 = (Math.log(args.spot / args.strike) + (r - 0.5 * args.iv * args.iv) * t) / (args.iv * sqrtT)
  let p: number
  if (args.isCredit) p = args.isCallSide ? normCdf(-d2) : normCdf(d2)
  else p = args.isCallSide ? normCdf(d2) : normCdf(-d2)
  return Math.round(clampProb(p) * 10000)
}

function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5
  return Math.max(0.01, Math.min(0.99, p))
}

function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + p * ax)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + sign * y)
}

export function computeContracts(maxLossPerSpread: number, accountSize: number): number {
  if (maxLossPerSpread <= 0 || accountSize <= 0) return 1
  const targetRisk = accountSize * 0.02
  const riskPerContract = maxLossPerSpread * 100
  return Math.max(1, Math.floor(targetRisk / riskPerContract))
}
