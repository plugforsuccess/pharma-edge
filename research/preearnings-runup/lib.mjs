// Pre-earnings run-up: the pure engine (PREREG.md, committed 2026-10-28).
// Everything here is a function of its inputs; no network, no clock.
// node research/preearnings-runup/check.mjs

export const RULES = Object.freeze({
  version: 'prereg-2026-10-28',
  oosFrom: '2025-05-01',
  universe: Object.freeze(['NOW', 'NVDA', 'AMZN', 'GOOGL', 'META', 'MSFT', 'CRM', 'ADBE', 'AAPL', 'NFLX', 'AMD', 'AVGO', 'ORCL', 'TSLA', 'INTC', 'QCOM', 'MU', 'UBER', 'SHOP', 'PANW', 'SNOW', 'INTU', 'COST', 'JPM', 'GS', 'WMT', 'HD', 'DIS', 'BA', 'PYPL']),
  liquidity: Object.freeze({ underlyingAvgOptVol: 20000, oi: 500, prevVol: 100, maxSpreadOfMid: 0.10, minMid: 0.20 }),
  deltas: Object.freeze([0.20, 0.30, 0.50]),
  entries: Object.freeze([5, 3, 2, 1, 'same-day']),
  directions: Object.freeze(['put', 'call', 'straddle', 'trend']),
  exits: Object.freeze(['pre-release', 'held-through']),
  times: Object.freeze({ entry: '15:45', sameDay: '10:00', exit: '15:55', heldExit: '10:00' }),
  costs: Object.freeze({ edge: 0.25, commission: 0.65, regFees: 0.05 }),
  budget: 1000,
  rate: 0.04,
  control: Object.freeze({ perEvent: 3, minGap: 15, seed: 20261028 }),
  bootstrap: Object.freeze({ reps: 10000, seed: 7 }),
  pass: Object.freeze({ minTrades: 100, alpha: 0.05, dropTop: 5 }),
  primary: Object.freeze({ direction: 'put', delta: 0.20, entry: 'same-day', exit: 'pre-release', timing: 'AMC' }),
})

// ---- 1. Event timing ------------------------------------------------------
// EDGAR's acceptanceDateTime carries a 'Z' but its clock is Eastern time
// (a filing accepted at 4:05 pm ET reads "…T16:05:00.000Z"). The events job
// prints the hour-of-day distribution so a wrong reading shows at once.
export function edgarTiming(acceptance) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(acceptance ?? '')
  if (!m) return null
  const mins = Number(m[2]) * 60 + Number(m[3])
  const timing = mins < 9 * 60 + 30 ? 'BMO' : mins >= 16 * 60 ? 'AMC' : 'DMH'
  return { date: m[1], timing, minutes: mins }
}

// Two sources agree on date and timing → a confirmed event.
// second: { date, timing } or null. → { status, date, timing }
export function confirm(edgar, second) {
  if (!edgar || edgar.timing === 'DMH') return { status: 'during-market' }
  if (!second) return { status: 'one-source', date: edgar.date, timing: edgar.timing }
  if (second.date !== edgar.date) return { status: 'date-mismatch', date: edgar.date, timing: edgar.timing, other: second }
  if (second.timing !== edgar.timing) return { status: 'timing-mismatch', date: edgar.date, timing: edgar.timing, other: second }
  return { status: 'confirmed', date: edgar.date, timing: edgar.timing }
}

// Sessions: sorted ['YYYY-MM-DD'] trading days. → { L, after } indices, or null.
export function sessionsFor(sessions, date, timing) {
  const d = sessions.indexOf(date)
  if (d < 0) return null
  const L = timing === 'AMC' ? d : d - 1
  const after = L + 1
  if (L < 0 || after >= sessions.length) return null
  return { L, after }
}

// ---- 2. Contracts ----------------------------------------------------------
const normCdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p }
export function bsDelta(S, K, T, vol, type, r = RULES.rate) {
  if (!(S > 0 && K > 0 && T > 0 && vol > 0)) return null
  const d1 = (Math.log(S / K) + (r + vol * vol / 2) * T) / (vol * Math.sqrt(T))
  return type === 'call' ? normCdf(d1) : normCdf(d1) - 1
}
const mid = (c) => (c.bid + c.ask) / 2

// First expiry on or after the first session after the release.
export function pickExpiry(expiries, afterDate) {
  return [...new Set(expiries)].sort().find((e) => e >= afterDate) ?? null
}

// contracts: [{ expiry, strike, type, bid, ask, iv, delta, oi, prevVol }]
export function pickByDelta(contracts, { type, target, expiry, spot, asOf }) {
  const T = Math.max(1, (Date.parse(expiry) - Date.parse(asOf)) / 86400e3) / 365
  let best = null
  for (const c of contracts) {
    if (c.type !== type || c.expiry !== expiry) continue
    const d = c.delta != null ? c.delta : bsDelta(spot, c.strike, T, c.iv, type)
    if (d == null) continue
    const gap = Math.abs(Math.abs(d) - target)
    const moneyness = Math.abs(c.strike - spot)
    if (!best || gap < best.gap - 1e-12 || (Math.abs(gap - best.gap) <= 1e-12 && moneyness < best.moneyness)) best = { c, gap, moneyness, delta: d }
  }
  return best ? { ...best.c, delta: best.delta } : null
}

export function liquidityOk(c, underlyingAvgOptVol, L = RULES.liquidity) {
  if (!c) return 'no contract'
  if (!(underlyingAvgOptVol >= L.underlyingAvgOptVol)) return 'underlying option volume'
  if (!(c.oi >= L.oi)) return 'open interest'
  if (!(c.prevVol >= L.prevVol)) return 'prior-day volume'
  if (!(c.bid > 0 && c.ask >= c.bid)) return 'no two-sided quote'
  const m = mid(c)
  if (!(m >= L.minMid)) return 'mid under $0.20'
  if ((c.ask - c.bid) / m > L.maxSpreadOfMid) return 'spread over 10% of mid'
  return null
}

// ---- 3. Fills, fees, returns -------------------------------------------------
export const buyPrice = (c, mode = 'realistic', k = RULES.costs.edge) => (mode === 'worst' ? c.ask : c.ask - k * (c.ask - c.bid))
export const sellPrice = (c, mode = 'realistic', k = RULES.costs.edge) => (mode === 'worst' ? c.bid : c.bid + k * (c.ask - c.bid))

// legs: [{ entry: quote, exit: quote }] (one leg, or two for a straddle).
// → { ret, pnl, contracts, cost, proceeds } per $budget, or { skip }.
export function tradeResult(legs, { mode = 'realistic', budget = RULES.budget, costs = RULES.costs } = {}) {
  const perSide = costs.commission + costs.regFees
  const unitCost = legs.reduce((s, l) => s + buyPrice(l.entry, mode) * 100, 0)
  const unitFees = legs.length * perSide
  if (!(unitCost > 0)) return { skip: 'no price' }
  if (unitCost + unitFees > budget) return { skip: 'one contract over the budget' }
  const n = Math.floor(budget / (unitCost + unitFees))
  const cost = n * (unitCost + unitFees)
  const proceeds = n * (legs.reduce((s, l) => s + Math.max(0, sellPrice(l.exit, mode)) * 100, 0) - unitFees)
  return { ret: proceeds / cost - 1, pnl: proceeds - cost, contracts: n, cost, proceeds }
}

// ---- 4. Controls -------------------------------------------------------------
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay()

// Pseudo-L indices for one real event: ≥ minGap sessions from every real L, same weekday,
// with room for the 5-day entry and the after session. Deterministic per (seed, ticker, L).
export function controlLs(sessions, realLs, L, { perEvent = RULES.control.perEvent, minGap = RULES.control.minGap, seed = RULES.control.seed, salt = 0 } = {}) {
  const wd = weekday(sessions[L])
  const pool = []
  for (let i = 6; i < sessions.length - 1; i++) if (weekday(sessions[i]) === wd && realLs.every((r) => Math.abs(i - r) >= minGap)) pool.push(i)
  const rand = rng(seed + salt * 7919 + L)
  const out = []
  const used = new Set()
  while (out.length < perEvent && used.size < pool.length) { const k = Math.floor(rand() * pool.length); if (!used.has(k)) { used.add(k); out.push(pool[k]) } }
  return out.sort((a, b) => a - b)
}

// ---- 5. Statistics -------------------------------------------------------------
const quant = (v, q) => { const s = [...v].sort((a, b) => a - b); if (!s.length) return null; const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo) }
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null)

// ISO week of a date, for clustering.
export function weekKey(d) {
  const t = new Date(`${d}T12:00:00Z`); const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  const y = t.getUTCFullYear(), first = new Date(Date.UTC(y, 0, 4))
  return `${y}-W${String(1 + Math.round(((t - first) / 86400e3 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`
}

// Clustered bootstrap of the mean. rows: [{ cluster, x }] → { lo, hi, p } (p = one-sided P(mean ≤ 0)).
export function bootstrapMean(rows, { reps = RULES.bootstrap.reps, seed = RULES.bootstrap.seed } = {}) {
  if (!rows.length) return { lo: null, hi: null, p: null, mean: null }
  const groups = new Map()
  for (const r of rows) { const g = groups.get(r.cluster) ?? { s: 0, n: 0 }; g.s += r.x; g.n += 1; groups.set(r.cluster, g) }
  const G = [...groups.values()], rand = rng(seed)
  const means = new Array(reps)
  for (let b = 0; b < reps; b++) { let s = 0, n = 0; for (let k = 0; k < G.length; k++) { const g = G[Math.floor(rand() * G.length)]; s += g.s; n += g.n } means[b] = s / n }
  return { mean: mean(rows.map((r) => r.x)), lo: quant(means, 0.025), hi: quant(means, 0.975), p: means.filter((m) => m <= 0).length / reps }
}

// Holm–Bonferroni: pvals { key: p } → Set of keys rejected (significant) at alpha.
export function holm(pvals, alpha = RULES.pass.alpha) {
  const list = Object.entries(pvals).filter(([, p]) => p != null).sort((a, b) => a[1] - b[1])
  const out = new Set()
  for (let i = 0; i < list.length; i++) { if (list[i][1] <= alpha / (list.length - i)) out.add(list[i][0]); else break }
  return out
}

// trades: [{ date, ret, pnl, tk }] → the report's per-variant metrics.
export function metrics(trades, { perYear = null } = {}) {
  const t = [...trades].sort((a, b) => a.date.localeCompare(b.date)), r = t.map((x) => x.ret)
  const wins = r.filter((x) => x > 0), losses = r.filter((x) => x <= 0)
  let eq = 0, peak = 0, dd = 0
  for (const x of t) { eq += x.pnl; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak) }
  const m = mean(r), sd = r.length > 1 ? Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) : null
  const years = t.length > 1 ? Math.max(1 / 52, (Date.parse(t.at(-1).date) - Date.parse(t[0].date)) / (365.25 * 86400e3)) : 1
  const tpy = perYear ?? t.length / years
  return {
    n: t.length, win: r.length ? wins.length / r.length : null, avgWin: mean(wins), avgLoss: mean(losses), expectancy: m,
    perThousand: mean(t.map((x) => x.pnl)), median: quant(r, 0.5), maxDrawdown: dd,
    worst5: [...t].sort((a, b) => a.ret - b.ret).slice(0, 5).map((x) => ({ tk: x.tk, date: x.date, ret: x.ret })),
    sharpe: m != null && sd ? (m / sd) * Math.sqrt(tpy) : null,
    withoutTop5: r.length > 5 ? mean([...r].sort((a, b) => b - a).slice(5)) : null,
  }
}

// The recorded rule for one variant on the out-of-sample set.
// trades / controls: [{ date, ret, pnl }]. → { verdict, checks, boot, diffBoot }
export function grade(trades, controls, pass = RULES.pass) {
  const boot = bootstrapMean(trades.map((t) => ({ cluster: weekKey(t.date), x: t.ret })))
  const cMean = mean(controls.map((c) => c.ret))
  const diffBoot = controls.length ? bootstrapMean(trades.map((t) => ({ cluster: weekKey(t.date), x: t.ret - cMean }))) : { lo: null }
  const m = metrics(trades)
  const checks = {
    expectancy: boot.mean > 0 && boot.lo > 0,
    trades: trades.length >= pass.minTrades,
    control: diffBoot.lo != null && diffBoot.lo > 0,
    outliers: m.withoutTop5 != null && m.withoutTop5 > 0,
  }
  const verdict = !checks.trades ? 'inconclusive' : Object.values(checks).every(Boolean) ? 'pass' : 'fail'
  return { verdict, checks, boot, diffBoot, controlMean: cMean, metrics: m }
}

// The pre-declared grid (PREREG §4).
export function grid(R = RULES) {
  const out = []
  for (const direction of R.directions) for (const delta of direction === 'straddle' ? [0.50] : R.deltas) for (const entry of R.entries) for (const exit of R.exits) {
    out.push({ key: `${direction}|${delta}|${entry}|${exit}`, direction, delta, entry, exit, amcOnly: entry === 'same-day' })
  }
  return out
}
export const isPrimary = (v) => { const P = RULES.primary; return v.direction === P.direction && v.delta === P.delta && v.entry === P.entry && v.exit === P.exit }
