// What did the good setups of one combination have in common? (owner,
// 2026-10-16, on the entry chart's "across 544 tickers: 2022× · 36% at a
// low · 6M +9.9% avg, 66% win": "What did those tickers in the 36% have in
// common? … What did those 66% have in common?")
//
// Every past buy setup of COMBO (default bravo+echo+macd — the card's
// combination) across the universe, exactly as confluenceModel counts them
// (one per combination per cluster). Two outcomes, the card's own:
//   atLow  a swing low within ±5 bars (hindsight — a grade, never an input)
//   up6    the stock higher 126 trading days later
// For each, the traits on the signal day (nothing after it), compared:
//   1. medians: outcome yes vs no;
//   2. each trait in fifths cut on TRAIN (signals before 2024), the
//      outcome rate on train and TEST (2024 →);
//   3. the best one- and two-trait filters picked on train, judged on test.
// A trait counts only if it holds on test. Also the same for every 2+
// signal setup (all combinations) as a bigger sample. Research only.

import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { entryModel, HORIZONS } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'
import { confluenceModel } from '../src/utils/confluence.js'
import { trailingVol, OPTION_MODEL } from '../src/utils/replay.js'
import { leaderSeries, leaderMisses } from '../src/utils/leaders.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const SPLIT = '2024-01-01'
const COMBO = process.env.COMBO || 'bravo+echo+macd'
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

const sma = (xs, n) => { const out = Array(xs.length).fill(null); let s = 0; xs.forEach((x, i) => { s += x; if (i >= n) s -= xs[i - n]; if (i >= n - 1) out[i] = s / n }); return out }
const pctRank = (xs, i, look) => { const v = xs[i]; if (v == null) return null; let k = 0, m = 0; for (let j = Math.max(0, i - look + 1); j <= i; j++) if (xs[j] != null) { m++; if (xs[j] <= v) k++ } return m >= look / 2 ? k / m : null }

const TRAITS = [
  ['score', 'Signals lit (of 5)'],
  ['momUp', 'Bravo regime up (short-term momentum)'],
  ['leader', 'Meets the Leaders rule'],
  ['mom12', '12-month return, skipping the last month'],
  ['rs6', "6-month return minus the S&P 500's"],
  ['vs200', '% above the 200-day'],
  ['slope200', '200-day rise over 20 days'],
  ['vs50', '% above the 50-day'],
  ['dd252', 'Drop from the 1-year high'],
  ['pull20', 'Drop from the 20-day high'],
  ['ret1m', "Last month's return"],
  ['ret5', 'Last 5 days return'],
  ['rsi', 'RSI 14'],
  ['rsiMin10', 'Lowest RSI in the last 10 days'],
  ['vol', '60-day volatility'],
  ['volRank', 'Volatility rank over the past year'],
  ['volu', 'Volume vs 50-day average'],
  ['spyUp', 'S&P 500 above its 200-day'],
  ['spy3m', 'S&P 500 3-month return'],
  ['room', 'Room to the 40-day low'],
]
const DISCRETE = new Set(['score', 'momUp', 'leader', 'spyUp'])

function rsiSeries(c, n = 14) {
  const out = Array(c.length).fill(null); let g = 0, l = 0
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0)
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = 100 - 100 / (1 + g / (l || 1e-9)); continue }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-9))
  }
  return out
}

function setupsFor(ticker, bars, spyBars, spyAt) {
  if (!bars || bars.length < 400) return []
  const model = entryModel(bars)
  const suite = suiteModel(bars)
  const conf = confluenceModel({ bars, model, suite, horizons: HORIZONS })
  const c = bars.map((b) => b.c), h = bars.map((b) => b.h), l = bars.map((b) => b.l), v = bars.map((b) => b.v || 0)
  const s200 = sma(c, 200), s50 = sma(c, 50), r14 = rsiSeries(c), vol = trailingVol(c, OPTION_MODEL.volBars)
  const ls = leaderSeries(bars, spyBars, { vol })
  const out = []
  for (const s of conf.buy.setups) {
    const i = s.i
    if (i < 260 || s200[i] == null || s.returns?.[1] == null) continue
    const sp = spyAt(bars[i].t), sp126 = spyAt(bars[i - 126].t), sp63 = spyAt(bars[i - 63].t)
    let hi252 = 0; for (let j = i - 251; j <= i; j++) hi252 = Math.max(hi252, h[j])
    let hi20 = 0; for (let j = i - 19; j <= i; j++) hi20 = Math.max(hi20, h[j])
    let lo40 = Infinity; for (let j = i - 39; j <= i; j++) lo40 = Math.min(lo40, l[j])
    let v50 = 0; for (let j = i - 49; j <= i; j++) v50 += v[j] / 50
    let rmin = Infinity; for (let j = i - 9; j <= i; j++) if (r14[j] != null) rmin = Math.min(rmin, r14[j])
    const lt = ls.at(i)
    out.push({
      ticker, t: bars[i].t, key: s.key, atLow: s.atTurn, up6: s.returns[1] > 0, r6: s.returns[1],
      f: {
        score: s.score,
        momUp: suite.bravo.regime[i] === 1 ? 1 : 0,
        leader: lt ? (leaderMisses(lt).length === 0 ? 1 : 0) : null,
        mom12: c[i - 21] / c[i - 252] - 1,
        rs6: sp && sp126 ? (c[i] / c[i - 126] - 1) - (sp.c / sp126.c - 1) : null,
        vs200: c[i] / s200[i] - 1,
        slope200: s200[i - 20] ? s200[i] / s200[i - 20] - 1 : null,
        vs50: s50[i] ? c[i] / s50[i] - 1 : null,
        dd252: c[i] / hi252 - 1,
        pull20: c[i] / hi20 - 1,
        ret1m: c[i] / c[i - 21] - 1,
        ret5: c[i] / c[i - 5] - 1,
        rsi: r14[i],
        rsiMin10: Number.isFinite(rmin) ? rmin : null,
        vol: vol[i],
        volRank: pctRank(vol, i, 252),
        volu: v50 > 0 ? v[i] / v50 : null,
        spyUp: sp ? (sp.c > sp.s200 ? 1 : 0) : null,
        spy3m: sp && sp63 ? sp.c / sp63.c - 1 : null,
        room: 1 - lo40 / c[i],
      },
    })
  }
  return out
}

// ── stats ──
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] }
const P = (x, d = 0) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const W = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
function rate(rows, outcome) {
  const g = rows.filter((r) => r[outcome] != null)
  if (!g.length) return { n: 0 }
  const r6 = g.map((r) => r.r6)
  return { n: g.length, rate: g.filter((r) => r[outcome]).length / g.length, med6: q(r6, 0.5), avg6: r6.reduce((a, x) => a + x, 0) / r6.length }
}
const fmtTrait = (key, x) => (x == null ? '—' : DISCRETE.has(key) ? (key === 'score' ? x.toFixed(1) : W(x)) : key === 'rsi' || key === 'rsiMin10' ? x.toFixed(1) : key === 'volu' ? x.toFixed(2) : P(x, 1))

function buckets(train, key) {
  const vals = train.map((r) => r.f[key]).filter((x) => x != null)
  if (DISCRETE.has(key)) return [...new Set(vals)].sort((a, b) => a - b).map((u) => ({ label: String(u), test: (x) => x === u }))
  const cuts = [0.2, 0.4, 0.6, 0.8].map((p) => q(vals, p))
  const fmt = (x) => (key === 'rsi' || key === 'rsiMin10' ? x.toFixed(0) : key === 'volu' ? x.toFixed(2) : P(x, 1))
  return [0, 1, 2, 3, 4].map((b) => {
    const lo = b === 0 ? -Infinity : cuts[b - 1], hi = b === 4 ? Infinity : cuts[b]
    return { label: b === 0 ? `≤ ${fmt(hi)}` : b === 4 ? `> ${fmt(lo)}` : `${fmt(lo)} … ${fmt(hi)}`, test: (x) => x > lo && x <= hi }
  })
}

function filters(train) {
  const singles = []
  for (const [key] of TRAITS) {
    const vals = train.map((r) => r.f[key]).filter((x) => x != null)
    if (!vals.length) continue
    if (DISCRETE.has(key)) { for (const u of new Set(vals)) singles.push({ name: `${key} = ${u}`, key, pass: (f) => f[key] === u }); continue }
    const med = q(vals, 0.5)
    singles.push({ name: `${key} ≤ ${med.toFixed(3)}`, key, pass: (f) => f[key] != null && f[key] <= med })
    singles.push({ name: `${key} > ${med.toFixed(3)}`, key, pass: (f) => f[key] != null && f[key] > med })
  }
  const out = [...singles]
  for (let a = 0; a < singles.length; a++) for (let b = a + 1; b < singles.length; b++) {
    if (singles[a].key === singles[b].key) continue
    const A = singles[a], B = singles[b]
    out.push({ name: `${A.name} AND ${B.name}`, pass: (f) => A.pass(f) && B.pass(f) })
  }
  return out
}

function study(label, rows, outcome, outLabel, minN) {
  const train = rows.filter((r) => r.t < SPLIT), test = rows.filter((r) => r.t >= SPLIT)
  const all = rate(rows, outcome), tr = rate(train, outcome), te = rate(test, outcome)
  const line = (s) => (s.n ? `n ${String(s.n).padStart(5)} · ${outLabel} ${W(s.rate).padStart(4)} · 6M median ${P(s.med6, 1).padStart(6)} · avg ${P(s.avg6, 1).padStart(6)}` : 'n 0')
  console.log(`\n════ ${label} — outcome: ${outLabel} ════`)
  console.log(`all    ${line(all)}\ntrain  ${line(tr)}   (signals before ${SPLIT})\ntest   ${line(te)}`)
  const yes = rows.filter((r) => r[outcome] === true), no = rows.filter((r) => r[outcome] === false)
  console.log(`\nMedian on the signal day — ${outLabel} (${yes.length}) vs not (${no.length})`)
  const R = { all, train: tr, test: te, medians: {}, fifths: {}, filters: [] }
  for (const [key, name] of TRAITS) {
    const m = (set) => { const xs = set.map((r) => r.f[key]).filter((x) => x != null); return DISCRETE.has(key) ? (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null) : q(xs, 0.5) }
    const a = m(yes), b = m(no)
    R.medians[key] = { yes: a, no: b }
    console.log(`  ${name.padEnd(42)} yes ${fmtTrait(key, a).padStart(7)} · no ${fmtTrait(key, b).padStart(7)}`)
  }
  console.log(`\nEach trait in fifths (cut on train) — ${outLabel} rate: train | test`)
  for (const [key, name] of TRAITS) {
    console.log(`  ${name}`)
    R.fifths[key] = buckets(train, key).map((bk) => {
      const a = rate(train.filter((r) => r.f[key] != null && bk.test(r.f[key])), outcome), b = rate(test.filter((r) => r.f[key] != null && bk.test(r.f[key])), outcome)
      console.log(`    ${bk.label.padEnd(18)} train ${W(a.rate).padStart(4)} (${String(a.n).padStart(5)}) med6 ${P(a.med6).padStart(5)} | test ${W(b.rate).padStart(4)} (${String(b.n).padStart(5)}) med6 ${P(b.med6).padStart(5)}`)
      return { label: bk.label, train: a, test: b }
    })
  }
  const cands = filters(train).map((fl) => ({ ...fl, tr: rate(train.filter((r) => fl.pass(r.f)), outcome) }))
    .filter((x) => x.tr.n >= minN)
  // Shrunk rate on train: (rate·n + base·50) / (n + 50), highest first.
  const shrink = (s) => (s.rate * s.n + tr.rate * 50) / (s.n + 50)
  cands.sort((a, b) => shrink(b.tr) - shrink(a.tr))
  console.log(`\nBest filters chosen on train (n ≥ ${minN}), judged on test — baseline test ${outLabel} ${W(te.rate)}, 6M median ${P(te.med6, 1)}`)
  for (const fl of cands.slice(0, 10)) {
    const b = rate(test.filter((r) => fl.pass(r.f)), outcome)
    R.filters.push({ name: fl.name, train: fl.tr, test: b })
    console.log(`  ${fl.name}\n      train ${line(fl.tr)}\n      test  ${line(b)}`)
  }
  return R
}

// ── main ──
const spyBars = await dailyBars('SPY')
const spyC = spyBars.map((b) => b.c), spyS = sma(spyC, 200)
const spyMap = new Map(spyBars.map((b, i) => [b.t, { c: b.c, s200: spyS[i] }]))
const spyAt = (t) => spyMap.get(t) ?? null
const all = []
let done = 0, failed = 0
const t0 = Date.now()
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try { all.push(...setupsFor(tk, await dailyBars(tk), spyBars, spyAt)) } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed · ${Math.round((Date.now() - t0) / 1000)}s`)
})
const keys = {}; for (const r of all) keys[r.key] = (keys[r.key] ?? 0) + 1
console.log(`Setups: ${all.length} from ${universe.length - failed} tickers (bars Yahoo ${sources.yahoo}, edge ${sources.edge}). Top combos: ${Object.entries(keys).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(' · ')}`)
const combo = all.filter((r) => r.key === COMBO)
const report = { ran_at: new Date().toISOString(), combo: COMBO, split: SPLIT }
report.comboLow = study(`${COMBO} (the card's combination)`, combo, 'atLow', 'at a swing low', 60)
report.comboUp = study(`${COMBO} (the card's combination)`, combo, 'up6', 'higher 6M later', 60)
report.allLow = study('every 2+ signal setup', all, 'atLow', 'at a swing low', 300)
report.allUp = study('every 2+ signal setup', all, 'up6', 'higher 6M later', 300)
writeFileSync('combo-traits.json', JSON.stringify(report))
console.log('\nwrote combo-traits.json')
