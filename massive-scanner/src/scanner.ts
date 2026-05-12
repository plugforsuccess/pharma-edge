// Per-underlying scan logic.
//
// For each underlying in SCAN_UNIVERSE:
//   1. Fetch the chain snapshot (current bid/ask + day volume + OI per
//      contract).
//   2. For each contract with non-trivial day volume, fetch the trades
//      since our last-seen timestamp.
//   3. Group consecutive same-side prints within 100ms into one "sweep"
//      if total premium >= MIN_PREMIUM_DOLLARS.
//   4. Emit a PrintCandidate for each qualifying print.
//
// We don't directly insert into Supabase here — main.ts owns the
// per-user qualification + insert step (a single print is observed
// for all active users, with the user's bot_config dictating which
// ones treat it as qualifying).

import {
  getChainSnapshot,
  getRecentOptionTrades,
  parseOptionTicker,
  sideFromConditions,
  type OptionContractSnapshot,
  type PolygonTrade,
} from './polygon.ts'
import type { PrintCandidate } from './filter.ts'

// State: per-contract last-seen trade timestamp (ns). We use this so we
// only fetch new trades since the last loop.
const lastSeenNs = new Map<string, bigint>()

const MIN_PREMIUM_DOLLARS_DEFAULT = Number(Deno.env.get('MIN_PREMIUM_DOLLARS_DEFAULT') || '500000')

function isoToday(): string { return new Date().toISOString().slice(0, 10) }

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86_400_000,
  )
}

function computeOtmPct(spot: number, strike: number, type: 'C' | 'P'): number {
  if (!spot) return 0
  return type === 'C' ? ((strike - spot) / spot) * 100 : ((spot - strike) / spot) * 100
}

// Group trades within `windowMs` and on the same aggressor side into
// one consolidated "sweep" print.
function consolidateTrades(
  trades: PolygonTrade[],
  windowMs = 100,
): Array<{ trades: PolygonTrade[]; side: 'buy' | 'sell' | 'mid'; ts: number; isSweep: boolean }> {
  const out: Array<{ trades: PolygonTrade[]; side: 'buy'|'sell'|'mid'; ts: number; isSweep: boolean }> = []
  let bucket: PolygonTrade[] = []
  let bucketSide: 'buy' | 'sell' | 'mid' | null = null
  let bucketTsNs = 0n
  for (const t of trades.slice().reverse()) {  // chronological
    const side = sideFromConditions(t.conditions)
    if (bucket.length && bucketSide === side &&
        Number(BigInt(t.timestamp) - bucketTsNs) / 1_000_000 < windowMs) {
      bucket.push(t)
      bucketTsNs = BigInt(t.timestamp)
    } else {
      if (bucket.length) {
        out.push({ trades: bucket, side: bucketSide!, ts: Number(bucketTsNs / 1_000_000n), isSweep: bucket.length > 1 })
      }
      bucket = [t]
      bucketSide = side
      bucketTsNs = BigInt(t.timestamp)
    }
  }
  if (bucket.length) {
    out.push({ trades: bucket, side: bucketSide!, ts: Number(bucketTsNs / 1_000_000n), isSweep: bucket.length > 1 })
  }
  return out
}

async function scanUnderlying(
  underlying: string,
  minPremiumDollars: number,
): Promise<PrintCandidate[]> {
  const candidates: PrintCandidate[] = []
  const expiryFrom = isoToday()
  const expiryToD = new Date()
  expiryToD.setUTCDate(expiryToD.getUTCDate() + 90)
  const expiryTo = expiryToD.toISOString().slice(0, 10)

  let chain: { underlyingPrice: number; contracts: OptionContractSnapshot[] }
  try {
    chain = await getChainSnapshot(underlying, { expiryFrom, expiryTo })
  } catch (err) {
    console.warn(`[${underlying}] chain fetch failed:`, (err as Error).message)
    return candidates
  }
  if (!chain.underlyingPrice) return candidates

  for (const c of chain.contracts) {
    const optTicker = c.details?.ticker
    if (!optTicker) continue
    const parsed = parseOptionTicker(optTicker)
    if (!parsed) continue
    const dayVol = Number(c.day?.volume ?? 0)
    const oi = Number(c.open_interest ?? 0)
    if (dayVol < 50) continue  // skip illiquid contracts
    // Heuristic: only fetch trades if dayVol × midPrice × 100 > minPremium
    const mid = ((Number(c.last_quote?.bid) || 0) + (Number(c.last_quote?.ask) || 0)) / 2
    if (mid * dayVol * 100 < minPremiumDollars) continue

    const sinceNs = lastSeenNs.get(optTicker)
    let trades: PolygonTrade[]
    try {
      trades = await getRecentOptionTrades(optTicker, 100, sinceNs)
    } catch (err) {
      console.warn(`[${optTicker}] trades fetch failed:`, (err as Error).message)
      continue
    }
    if (!trades.length) continue

    // Update last-seen
    const newest = trades.reduce((a, b) => a.timestamp > b.timestamp ? a : b)
    lastSeenNs.set(optTicker, BigInt(newest.timestamp))

    const consolidated = consolidateTrades(trades)

    for (const group of consolidated) {
      const totalSize = group.trades.reduce((s, t) => s + Number(t.size || 0), 0)
      const totalDollars = group.trades.reduce((s, t) => s + Number(t.size || 0) * Number(t.price || 0), 0) * 100
      if (totalDollars < minPremiumDollars) continue
      if (group.side === 'mid') continue

      const dte = daysBetween(parsed.expiry, isoToday())
      const otmPct = computeOtmPct(chain.underlyingPrice, parsed.strike, parsed.type)
      const volOi = oi > 0 ? dayVol / oi : 99

      candidates.push({
        ticker: parsed.underlying,
        option_type: parsed.type,
        strike: parsed.strike,
        expiry: parsed.expiry,
        premium_dollars: totalDollars,
        contracts: totalSize,
        side: group.side,
        bid: Number(c.last_quote?.bid) || 0,
        ask: Number(c.last_quote?.ask) || 0,
        mid,
        spot: chain.underlyingPrice,
        spot_at_print: chain.underlyingPrice,
        otm_pct: otmPct,
        dte,
        vol_oi_ratio: volOi,
        iv_rank: Number(c.implied_volatility) ? Number(c.implied_volatility) * 100 : 50,
        is_sweep: group.isSweep,
        is_single_leg: true,  // Polygon doesn't tag complex orders reliably; assume single-leg
        uw_trade_id: `${optTicker}:${group.ts}`,
      })
    }
  }
  return candidates
}

export async function scanUniverse(
  universe: readonly string[],
  minPremiumDollars: number = MIN_PREMIUM_DOLLARS_DEFAULT,
): Promise<PrintCandidate[]> {
  const all: PrintCandidate[] = []
  for (const u of universe) {
    const c = await scanUnderlying(u, minPremiumDollars)
    all.push(...c)
  }
  return all
}
