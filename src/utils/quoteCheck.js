// The real-quote check (owner, 2026-11-16: "Start the real quote check now"):
// every night, for each stock on the Stopped believing scan, the same bear call
// spread the short-window test priced with a formula (sell the at-the-money call,
// buy the call one expected move higher, ~1 month out) is priced two ways — the
// formula (σ = 1.3 × 60-day vol, 2% slippage per leg) and the real quotes (bid /
// ask) on the listed strikes. If real credits run well under the formula's, the
// test's +7% is not real. Pure; npm run quotecheck:check.
import { bsCall } from './replay.js'
import { jumpVol, JUMP_BEAR } from './jumpBear.js'

export const QUOTE_CHECK = Object.freeze({ days: 30, maxGapOfCredit: 0.2, minCreditOfWidth: 0.2 })
const mid = (c) => (c && c.ask > 0 && c.bid >= 0 ? (c.bid + c.ask) / 2 : null)

// bars: daily (for the formula's vol), chain: { spot, expiry, dte, calls: [{ strike, bid, ask, iv, oi }] }
export function spreadQuote(bars, chain, b = JUMP_BEAR) {
  const S = chain?.spot
  const calls = (chain?.calls ?? []).filter((c) => c.strike > 0).sort((x, y) => x.strike - y.strike)
  if (!(S > 0) || !(chain.dte > 0) || calls.length < 2) return { ok: false, reason: 'no chain' }
  const vol = jumpVol(bars, bars.length - 1, b.premium, b)
  if (!vol) return { ok: false, reason: 'no vol' }
  const T = chain.dte / 365
  const leg1 = calls.find((c) => c.strike >= S)
  if (!leg1) return { ok: false, reason: 'no ATM strike' }
  const target = S * (1 + vol * Math.sqrt(T))
  const above = calls.filter((c) => c.strike > leg1.strike)
  if (!above.length) return { ok: false, reason: 'no upper strike' }
  const leg2 = above.reduce((a, c) => (Math.abs(c.strike - target) < Math.abs(a.strike - target) ? c : a))
  const width = leg2.strike - leg1.strike
  const model = bsCall(S, leg1.strike, T, vol, b.rate) * (1 - b.slip) - bsCall(S, leg2.strike, T, vol, b.rate) * (1 + b.slip)
  const quoted = leg1.bid > 0 && leg1.ask > 0 && leg2.ask > 0
  const realMid = quoted && mid(leg2) != null ? mid(leg1) - mid(leg2) : null
  const realNatural = quoted ? leg1.bid - leg2.ask : null
  const gap = quoted && leg2.bid != null ? (leg1.ask - leg1.bid) + (leg2.ask - (leg2.bid || 0)) : null
  return {
    ok: true, quoted, spot: S, expiry: chain.expiry, dte: chain.dte, k1: leg1.strike, k2: leg2.strike, width,
    modelVol: vol, iv1: leg1.iv ?? null, model, realMid, realNatural, gap,
    bid1: leg1.bid ?? null, ask1: leg1.ask ?? null, bid2: leg2.bid ?? null, ask2: leg2.ask ?? null, oi1: leg1.oi ?? null, oi2: leg2.oi ?? null,
  }
}

const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }

// rows: spreadQuote results (+ ticker) → the night's reading.
export function quoteSummary(rows, p = QUOTE_CHECK) {
  const ok = rows.filter((r) => r.ok)
  const q = ok.filter((r) => r.quoted && r.model > 0 && r.realMid != null)
  const share = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : null)
  return {
    stocks: rows.length, withChain: ok.length, quoted: q.length,
    midVsModel: med(q.map((r) => r.realMid / r.model)),
    naturalVsModel: med(q.map((r) => r.realNatural / r.model)),
    ivVsModel: med(q.filter((r) => r.iv1 > 0).map((r) => r.iv1 / r.modelVol)),
    modelOfWidth: med(q.map((r) => r.model / r.width)),
    midOfWidth: med(q.map((r) => r.realMid / r.width)),
    tradeable: share(q, (r) => r.oi1 > 0 && r.oi2 > 0 && r.gap != null && r.realMid > 0 && r.gap <= p.maxGapOfCredit * r.realMid && r.realMid >= p.minCreditOfWidth * r.width),
    naturalPositive: share(q, (r) => r.realNatural > 0),
  }
}
