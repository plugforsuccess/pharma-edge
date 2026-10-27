// The bear side of the second jump (pre-registered 2026-10-27,
// docs/signal-engine/preregistration.md): a long put, a put debit spread
// under the spread rules, and short shares, entered at the open after a
// jump. Pure; npm run jumpbear:check.
import { bsPut, trailingVol, PUT_MODEL } from './replay.js'

export const JUMP_BEAR = Object.freeze({
  premium: 1.3, premiums: [1.3, 1.6], volBars: 60, volFloor: 0.15, slip: 0.02, rate: 0.04, year: 252,
  put: { horizons: [126, 63], primary: 126 },
  spread: { horizon: 63, closeLeft: PUT_MODEL.closeDte, maxDebit: PUT_MODEL.maxDebit, stop: PUT_MODEL.stop, takes: PUT_MODEL.takes },
  short: { horizon: 126, borrows: [0.30, 1.00], stops: [0.5, 1.0, null], primary: { borrow: 0.30, stop: 1.0 } },
})
export const JUMP_BEAR_PASS = Object.freeze({ minN: 100, years: ['2024', '2025', '2026'] })

// σ on the jump day e (includes the jump), × premium, floored.
export function jumpVol(bars, e, premium = JUMP_BEAR.premium, p = JUMP_BEAR) {
  const rv = trailingVol(bars.slice(Math.max(0, e - p.volBars), e + 1).map((b) => b.c), p.volBars).at(-1)
  return rv > 0 ? Math.max(p.volFloor, rv * premium) : null
}
const entryOf = (bars, e) => { const b = bars[e + 1]; return b ? (b.o > 0 ? b.o : b.c) : null }

// 1. Long ATM put, held to expiry.
export function putTrade(bars, e, { premium = JUMP_BEAR.premium, horizon = JUMP_BEAR.put.primary, p = JUMP_BEAR } = {}) {
  const s = e + 1, end = s + horizon
  if (end >= bars.length) return null
  const S0 = entryOf(bars, e), vol = jumpVol(bars, e, premium, p)
  if (!(S0 > 0) || !vol) return null
  const paid = bsPut(S0, S0, horizon / p.year, vol, p.rate) * (1 + p.slip)
  if (!(paid > 0)) return null
  const got = Math.max(0, S0 - bars[end].c) * (1 - p.slip)
  return { ret: got / paid - 1, paid, vol }
}

// 2. Put debit spread under the spread rules.
export function spreadTrade(bars, e, { premium = JUMP_BEAR.premium, p = JUMP_BEAR } = {}) {
  const q = p.spread, s = e + 1, end = s + q.horizon
  if (end >= bars.length) return null
  const S0 = entryOf(bars, e), vol = jumpVol(bars, e, premium, p)
  if (!(S0 > 0) || !vol) return null
  const T0 = q.horizon / p.year
  const K1 = S0, K2 = S0 * Math.max(0.05, 1 - vol * Math.sqrt(T0)), width = K1 - K2
  const val = (S, T) => Math.min(width, Math.max(0, bsPut(S, K1, T, vol, p.rate) - bsPut(S, K2, T, vol, p.rate)))
  const debit = val(S0, T0)
  if (!(debit > 0) || debit > q.maxDebit * width) return { skipped: true }
  const paid = debit * (1 + p.slip)
  let left = 1, got = 0, took = 0
  for (let j = s + 1; j <= end; j++) {
    const remain = end - j, T = remain / p.year
    const v = remain <= 0 ? Math.max(0, K1 - bars[j].c) - Math.max(0, K2 - bars[j].c) : val(bars[j].c, T)
    const r = v / debit - 1
    while (took < q.takes.length && r >= q.takes[took][0] && left > 0) { const f = Math.min(left, q.takes[took][1]); got += f * v * (1 - p.slip); left -= f; took++ }
    if (left > 0 && (r <= q.stop || remain <= q.closeLeft)) { got += left * v * (1 - p.slip); left = 0; return { ret: got / paid - 1, paid, days: j - s, stopped: r <= q.stop } }
  }
  if (left > 0) got += left * (Math.max(0, K1 - bars[end].c) - Math.max(0, K2 - bars[end].c)) * (1 - p.slip)
  return { ret: got / paid - 1, paid, days: q.horizon, stopped: false }
}

// 3. Short shares: cover at the horizon close or at the first close ≥ (1 + stop) × entry.
export function shortTrade(bars, e, { borrow = JUMP_BEAR.short.primary.borrow, stop = JUMP_BEAR.short.primary.stop, p = JUMP_BEAR } = {}) {
  const q = p.short, s = e + 1, end = s + q.horizon
  if (end >= bars.length) return null
  const S0 = entryOf(bars, e)
  if (!(S0 > 0)) return null
  const sold = S0 * (1 - p.slip)
  let k = end
  if (stop != null) for (let j = s; j <= end; j++) if (bars[j].c >= S0 * (1 + stop)) { k = j; break }
  const cover = bars[k].c * (1 + p.slip)
  const fee = S0 * borrow * (k - s) / p.year
  return { ret: (sold - cover - fee) / S0, days: k - s, stopped: k < end }
}

const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
export function bearStats(trades) {
  const t = trades.filter((x) => x && !x.skipped && Number.isFinite(x.ret)), r = t.map((x) => x.ret)
  return { n: t.length, skipped: trades.filter((x) => x && x.skipped).length, avg: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null, median: med(r), win: r.length ? r.filter((x) => x > 0).length / r.length : null, lostHalf: r.length ? r.filter((x) => x <= -0.5).length / r.length : null, worst: r.length ? Math.min(...r) : null, best: r.length ? Math.max(...r) : null, stopped: t.length ? t.filter((x) => x.stopped).length / t.length : null }
}

// The recorded rule: overall stats + per-year averages (rows: [{ t, trade }]).
export function bearVerdict(rows, pass = JUMP_BEAR_PASS) {
  const all = bearStats(rows.map((r) => r.trade))
  if (all.n < pass.minN) return { verdict: 'inconclusive', all, years: {} }
  const years = Object.fromEntries(pass.years.map((y) => [y, bearStats(rows.filter((r) => r.t.startsWith(y)).map((r) => r.trade))]))
  const ok = all.avg > 0 && all.median > 0 && pass.years.every((y) => years[y].n > 0 && years[y].avg > 0)
  return { verdict: ok ? 'pass' : 'fail', all, years }
}
