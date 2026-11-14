// Short windows after a jump (pre-registered 2026-11-14, docs/signal-engine/
// preregistration.md): entries at the jump, after 3 / 5 closes under the jump
// close, or after a 10% drop within 5 sessions; drawdowns at 1M / 2M / 3M / 6M;
// puts and a short priced like the bear tests. Pure; npm run shortwindow:check.
import { bsPut } from './replay.js'
import { jumpVol, JUMP_BEAR } from './jumpBear.js'

export const SHORT_WINDOW = Object.freeze({
  horizons: [21, 42, 63, 126],
  falls: [0.2, 0.3, 0.4], rise: 0.5,
  holdWithin: 20, dropWithin: 5, drop: 0.10,
  putDays: [21, 42, 63], take: 0.20,
  short: { horizon: 63, target: 0.20, stop: 0.50, borrow: 0.30 },
  primary: { entry: 'E3', putDays: 42 },
})
export const SHORT_WINDOW_PASS = Object.freeze({ minN: 100, years: ['2024', '2025', '2026'] })

// Signal bar (a close) for each entry kind, or null. e = the jump bar.
export function entrySignal(bars, e, kind, p = SHORT_WINDOW) {
  const J = bars[e].c
  if (kind === 'E0') return e
  if (kind === 'E3' || kind === 'E5') {
    const n = kind === 'E3' ? 3 : 5
    let run = 0
    for (let k = e + 1; k <= Math.min(bars.length - 1, e + p.holdWithin); k++) {
      run = bars[k].c < J ? run + 1 : 0
      if (run >= n) return k
    }
    return null
  }
  if (kind === 'D10') {
    for (let k = e + 1; k <= Math.min(bars.length - 1, e + p.dropWithin); k++) if (bars[k].c <= J * (1 - p.drop)) return k
    return null
  }
  return null
}

// Path from the open after signal bar s: per horizon the close return, the deepest
// drawdown, falls ≥ each level, a rise ≥ p.rise. null when the longest horizon isn't complete.
export function pathAfter(bars, s, p = SHORT_WINDOW) {
  const a = s + 1, H = Math.max(...p.horizons)
  if (a + H >= bars.length) return null
  const entry = bars[a].o > 0 ? bars[a].o : bars[a].c
  if (!(entry > 0)) return null
  const out = { entry, by: {} }
  let lo = Infinity, hi = 0
  for (let k = a, h = 0; k <= a + H; k++, h++) {
    lo = Math.min(lo, bars[k].l ?? bars[k].c); hi = Math.max(hi, bars[k].h ?? bars[k].c)
    if (p.horizons.includes(h)) out.by[h] = { ret: bars[k].c / entry - 1, dd: lo / entry - 1, falls: Object.fromEntries(p.falls.map((f) => [f, lo / entry - 1 <= -f])), rose: hi / entry - 1 >= p.rise }
  }
  return out
}

// ATM put bought the open after s, `days` sessions to expiry; take = sell at the first
// close ≥ p.take under the entry (marked at the model), else hold to expiry.
export function putAfter(bars, s, days, { take = false, p = SHORT_WINDOW, b = JUMP_BEAR } = {}) {
  const a = s + 1, end = a + days
  if (end >= bars.length) return null
  const S0 = bars[a].o > 0 ? bars[a].o : bars[a].c, vol = jumpVol(bars, s, b.premium, b)
  if (!(S0 > 0) || !vol) return null
  const paid = bsPut(S0, S0, days / b.year, vol, b.rate) * (1 + b.slip)
  if (!(paid > 0)) return null
  if (take) for (let k = a; k < end; k++) if (bars[k].c <= S0 * (1 - p.take)) {
    const got = bsPut(bars[k].c, S0, (end - k) / b.year, vol, b.rate) * (1 - b.slip)
    return { ret: got / paid - 1, days: k - a, took: true }
  }
  return { ret: Math.max(0, S0 - bars[end].c) * (1 - b.slip) / paid - 1, days, took: false }
}

// Short shares from the open after s: out at −target, +stop or the horizon; borrow accrues.
export function shortAfter(bars, s, { p = SHORT_WINDOW, b = JUMP_BEAR } = {}) {
  const q = p.short, a = s + 1, end = a + q.horizon
  if (end >= bars.length) return null
  const S0 = bars[a].o > 0 ? bars[a].o : bars[a].c
  if (!(S0 > 0)) return null
  let k = end
  for (let j = a; j <= end; j++) if (bars[j].c <= S0 * (1 - q.target) || bars[j].c >= S0 * (1 + q.stop)) { k = j; break }
  const fee = S0 * q.borrow * (k - a) / b.year
  return { ret: (S0 * (1 - b.slip) - bars[k].c * (1 + b.slip) - fee) / S0, days: k - a, stopped: bars[k].c >= S0 * (1 + q.stop) }
}

const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
const share = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : null)

export function pathStats(paths, p = SHORT_WINDOW) {
  const ok = paths.filter(Boolean)
  return {
    n: ok.length,
    by: Object.fromEntries(p.horizons.map((h) => [h, {
      ret: med(ok.map((x) => x.by[h].ret)), dd: med(ok.map((x) => x.by[h].dd)),
      falls: Object.fromEntries(p.falls.map((f) => [f, share(ok, (x) => x.by[h].falls[f])])), rose: share(ok, (x) => x.by[h].rose),
    }])),
  }
}

export function tradeStats(trades) {
  const t = trades.filter((x) => x && Number.isFinite(x.ret)), r = t.map((x) => x.ret)
  return { n: t.length, avg: r.length ? r.reduce((a, b) => a + b, 0) / r.length : null, median: med(r), win: share(r, (x) => x > 0), lostHalf: share(r, (x) => x <= -0.5), took: share(t, (x) => x.took) }
}

// rows: [{ t, trade }] (test period) → the recorded verdict.
export function windowVerdict(rows, pass = SHORT_WINDOW_PASS) {
  const all = tradeStats(rows.map((r) => r.trade))
  if (all.n < pass.minN) return { verdict: 'inconclusive', all, years: {} }
  const years = Object.fromEntries(pass.years.map((y) => [y, tradeStats(rows.filter((r) => r.t.startsWith(y)).map((r) => r.trade))]))
  const ok = all.avg > 0 && all.median > 0 && pass.years.every((y) => years[y].n > 0 && years[y].avg > 0)
  return { verdict: ok ? 'pass' : 'fail', all, years }
}
