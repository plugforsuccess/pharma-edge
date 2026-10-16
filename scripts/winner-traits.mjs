// What do the winning pullback entries have in common? (owner, 2026-10-15:
// "how can we ensure that we aren't picking the losers? What's the pattern
// for the winners … We certainly will have an exit plan and not hold to
// expiry ever.")
//
// Every past BUY SETUP and 2-signal (confluence) entry across the universe,
// one per dip (21-day gap), played as an at-the-money ~2-year call with the
// app's exit plan (70% at +100%, 15% at +200%, runner on a 30% trail, out
// with 6 months left; src/utils/replay.js oneTrade, Black-Scholes on
// trailing vol, 2% slippage a fill, open trades marked). For each entry,
// what the stock looked like on the signal day (nothing after it). Then:
//   1. winners (+100% or more) vs losers (−50% or worse): the median of
//      each trait;
//   2. each trait in fifths, cut on TRAIN (signals before 2024): win rate,
//      median, share that lost half — on train and on TEST (2024 →);
//   3. the best one- and two-trait filters picked on TRAIN, judged on TEST.
// A trait only counts if it holds on test. Survivorship: today's tickers.
//
// Run by .github/workflows/winner-traits.yml; writes winner-traits.json.

import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { entryModel } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'
import { replaySignals, trailingVol, oneTrade, OPTION_MODEL } from '../src/utils/replay.js'
import { ATM_MODEL, CLUSTER_GAP } from '../src/utils/callHistory.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { LEADER, leaderSeries, leaderMisses } from '../src/utils/leaders.js'

const SPLIT = '2024-01-01'
let spyBarsAll = []
const todayStatus = []
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

const sma = (xs, n) => { const out = Array(xs.length).fill(null); let s = 0; xs.forEach((x, i) => { s += x; if (i >= n) s -= xs[i - n]; if (i >= n - 1) out[i] = s / n }); return out }
function rsi(closes, n = 14) {
  const out = Array(closes.length).fill(null); let g = 0, l = 0
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0)
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = 100 - 100 / (1 + g / (l || 1e-9)); continue }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-9))
  }
  return out
}
const DISCRETE = new Set(['score', 'momUp', 'spyUp'])
const pctRank = (xs, i, look) => { const v = xs[i]; if (v == null) return null; let k = 0, m = 0; for (let j = Math.max(0, i - look + 1); j <= i; j++) if (xs[j] != null) { m++; if (xs[j] <= v) k++ } return m >= look / 2 ? k / m : null }

// The traits, all from bars up to and including the signal day.
const TRAITS = [
  ['score', 'Signals lit (of 5)'],
  ['momUp', 'Short-term momentum rising (Bravo)'],
  ['mom12', '12-month return, skipping the last month'],
  ['rs6', '6-month return minus the S&P 500\'s'],
  ['vs200', '% above the 200-day'],
  ['slope200', '200-day rise over 20 days'],
  ['dd252', 'Drop from the 1-year high'],
  ['pull20', 'Drop from the 20-day high'],
  ['ret1m', 'Last month\'s return'],
  ['rsi', 'RSI 14'],
  ['vol', '60-day volatility (option price)'],
  ['volRank', 'Volatility rank over the past year'],
  ['volu', 'Volume vs 50-day average'],
  ['spyUp', 'S&P 500 above its 200-day'],
  ['spy3m', 'S&P 500 3-month return'],
  ['room', 'Room to the 40-day low'],
]

function features(bars, i, ctx) {
  const { c, h, l, v, s200, r14, vol, spyAt, regime, score } = ctx
  if (i < 260 || s200[i] == null) return null
  const sp = spyAt(bars[i].t), sp126 = spyAt(bars[i - 126].t), sp63 = spyAt(bars[i - 63].t)
  let hi252 = 0; for (let j = i - 251; j <= i; j++) hi252 = Math.max(hi252, h[j])
  let hi20 = 0; for (let j = i - 19; j <= i; j++) hi20 = Math.max(hi20, h[j])
  let lo40 = Infinity; for (let j = i - 39; j <= i; j++) lo40 = Math.min(lo40, l[j])
  let v50 = 0; for (let j = i - 49; j <= i; j++) v50 += v[j] / 50
  return {
    score: score[i],
    momUp: regime[i] === 1 ? 1 : 0,
    mom12: c[i - 21] / c[i - 252] - 1,
    rs6: sp && sp126 ? (c[i] / c[i - 126] - 1) - (sp.c / sp126.c - 1) : null,
    vs200: c[i] / s200[i] - 1,
    slope200: s200[i - 20] ? s200[i] / s200[i - 20] - 1 : null,
    dd252: c[i] / hi252 - 1,
    pull20: c[i] / hi20 - 1,
    ret1m: c[i] / c[i - 21] - 1,
    rsi: r14[i],
    vol: vol[i],
    volRank: pctRank(vol, i, 252),
    volu: v50 > 0 ? v[i] / v50 : null,
    spyUp: sp ? (sp.c > sp.s200 ? 1 : 0) : null,
    spy3m: sp && sp63 ? sp.c / sp63.c - 1 : null,
    room: 1 - lo40 / c[i],
  }
}

function tradesFor(ticker, bars, spyAt) {
  if (!bars || bars.length < 400) return []
  const model = entryModel(bars)
  const suite = suiteModel(bars)
  const sig = replaySignals(bars, model, suite)
  const c = bars.map((b) => b.c)
  const ctx = {
    c, h: bars.map((b) => b.h), l: bars.map((b) => b.l), v: bars.map((b) => b.v || 0),
    s200: sma(c, 200), r14: rsi(c), vol: trailingVol(c, OPTION_MODEL.volBars), spyAt,
    regime: suite.bravo.regime, score: sig.buyScore,
  }
  const ls = leaderSeries(bars, spyBarsAll, { vol: ctx.vol })
  const n = bars.length
  todayStatus.push({ ticker, misses: leaderMisses(ls.at(n - 1)), score: sig.buyScore[n - 1], rising: sig.rising[n - 1] })
  const out = []
  for (const rule of ['setup', 'confluence']) {
    let last = -Infinity
    sig.entry[rule].forEach((on, i) => {
      if (!on || i - last < CLUSTER_GAP || i >= bars.length - 2) return
      last = i
      const f = features(bars, i, ctx)
      if (!f) return
      const row = { ticker, rule, t: bars[i].t, f, lt: ls.at(i) }
      for (const [k, opt] of [['atm', ATM_MODEL], ['itm', OPTION_MODEL]]) {
        const tr = oneTrade(bars, c, ctx.vol, i, { exitRule: 'targets', opt })
        if (tr) row[k] = { ret: tr.optionReturn, open: tr.open, days: tr.days, stock: tr.stockReturn, how: tr.exits.map((x) => x.reason).join('+') || 'open' }
      }
      if (row.atm) out.push(row)
    })
  }
  return out
}

// ── stats ──
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] }
function stats(rows, k = 'atm') {
  const r = rows.map((x) => x[k]?.ret).filter((x) => x != null)
  if (!r.length) return { n: 0 }
  return { n: r.length, win: r.filter((x) => x > 0).length / r.length, big: r.filter((x) => x >= 1).length / r.length, lostHalf: r.filter((x) => x <= -0.5).length / r.length, median: q(r, 0.5), avg: r.reduce((a, x) => a + x, 0) / r.length, badq: q(r, 0.25) }
}
const P = (x, d = 0) => (x == null ? '   —' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const W = (x) => (x == null ? ' —' : `${Math.round(x * 100)}%`)
const line = (s) => (s.n ? `n ${String(s.n).padStart(4)} · win ${W(s.win).padStart(4)} · median ${P(s.median).padStart(5)} · avg ${P(s.avg).padStart(5)} · lost half ${W(s.lostHalf).padStart(4)} · ≥+100% ${W(s.big).padStart(4)}` : 'n    0')

function buckets(train, key) {
  const vals = train.map((r) => r.f[key]).filter((x) => x != null)
  const uniq = [...new Set(vals)]
  if (DISCRETE.has(key)) return uniq.sort((a, b) => a - b).map((u) => ({ label: String(u), test: (x) => x === u }))
  const cuts = [0.2, 0.4, 0.6, 0.8].map((p) => q(vals, p))
  const fmt = (x) => (Math.abs(x) < 3 && key !== 'rsi' && key !== 'volu' ? P(x, 1) : x.toFixed(key === 'volu' ? 2 : 0))
  return [0, 1, 2, 3, 4].map((b) => {
    const lo = b === 0 ? -Infinity : cuts[b - 1], hi = b === 4 ? Infinity : cuts[b]
    return { label: b === 0 ? `≤ ${fmt(hi)}` : b === 4 ? `> ${fmt(lo)}` : `${fmt(lo)} … ${fmt(hi)}`, test: (x) => x > lo && x <= hi, lo, hi }
  })
}

// Filters picked on train: one trait (a fifth or a half), or two (halves).
function candidateFilters(train) {
  const out = []
  for (const [key] of TRAITS) {
    const vals = train.map((r) => r.f[key]).filter((x) => x != null)
    if (!vals.length) continue
    const med = q(vals, 0.5)
    const uniq = [...new Set(vals)]
    if (DISCRETE.has(key)) for (const u of uniq) out.push({ name: `${key} = ${u}`, keys: [key], pass: (f) => f[key] === u })
    else {
      out.push({ name: `${key} ≤ median (${med.toFixed(3)})`, keys: [key], pass: (f) => f[key] != null && f[key] <= med })
      out.push({ name: `${key} > median (${med.toFixed(3)})`, keys: [key], pass: (f) => f[key] != null && f[key] > med })
    }
  }
  const singles = [...out]
  for (let a = 0; a < singles.length; a++) for (let b = a + 1; b < singles.length; b++) {
    if (singles[a].keys[0] === singles[b].keys[0]) continue
    const A = singles[a], B = singles[b]
    out.push({ name: `${A.name} AND ${B.name}`, keys: [...A.keys, ...B.keys], pass: (f) => A.pass(f) && B.pass(f) })
  }
  return out
}
// Score on train: the median trade, docked for losing half, shrunk on small n.
const score = (s) => (s.n ? ((s.median ?? 0) - 0.5 * s.lostHalf) * (s.n / (s.n + 100)) : -Infinity)

// ── main ──
const spyBars = await dailyBars('SPY')
spyBarsAll = spyBars
const spyC = spyBars.map((b) => b.c), spyS = sma(spyC, 200)
const spyMap = new Map(spyBars.map((b, i) => [b.t, { c: b.c, s200: spyS[i] }]))
const spyAt = (t) => spyMap.get(t) ?? null
const t0 = Date.now()
let done = 0, failed = 0
const all = []
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try { all.push(...tradesFor(tk, await dailyBars(tk), spyAt)) } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed · ${Math.round((Date.now() - t0) / 1000)}s`)
})
console.log(`Entries: ${all.length} from ${universe.length - failed} tickers; bars Yahoo ${sources.yahoo}, edge ${sources.edge}\n`)

const report = { ran_at: new Date().toISOString(), split: SPLIT, rules: {} }
for (const rule of ['setup', 'confluence']) {
  const rows = all.filter((r) => r.rule === rule)
  const train = rows.filter((r) => r.t < SPLIT), test = rows.filter((r) => r.t >= SPLIT)
  const R = { all: stats(rows), train: stats(train), test: stats(test), itm: stats(rows, 'itm'), traits: {}, winnersVsLosers: {}, filters: [] }
  console.log(`════ ${rule === 'setup' ? 'BUY SETUP' : '2+ signals (confluence)'} · ATM ~2-year call, exit plan ════`)
  console.log(`all    ${line(R.all)}`)
  console.log(`train  ${line(R.train)}   (signals before ${SPLIT})`)
  console.log(`test   ${line(R.test)}   (open trades marked)`)
  console.log(`ITM .75Δ, same entries: ${line(R.itm)}`)

  // 1. Winners vs losers.
  const winners = rows.filter((r) => r.atm.ret >= 1), losers = rows.filter((r) => r.atm.ret <= -0.5), mid = rows.filter((r) => r.atm.ret > -0.5 && r.atm.ret < 1)
  console.log(`\nWinners (≥ +100%: ${winners.length}) vs losers (≤ −50%: ${losers.length}) vs the rest (${mid.length}) — median on the signal day`)
  for (const [key, label] of TRAITS) {
    const m = (set) => q(set.map((r) => r.f[key]).filter((x) => x != null), 0.5)
    const mean = (set) => { const xs = set.map((r) => r.f[key]).filter((x) => x != null); return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null }
    const binary = key === 'momUp' || key === 'spyUp'
    const vw = binary ? mean(winners) : m(winners), vl = binary ? mean(losers) : m(losers), vm = binary ? mean(mid) : m(mid)
    R.winnersVsLosers[key] = { winners: vw, losers: vl, rest: vm }
    const f = (x) => (x == null ? '—' : binary ? W(x) : key === 'rsi' || key === 'score' ? x.toFixed(1) : key === 'volu' ? x.toFixed(2) : P(x, 1))
    console.log(`  ${label.padEnd(44)} winners ${f(vw).padStart(7)} · losers ${f(vl).padStart(7)} · rest ${f(vm).padStart(7)}`)
  }

  // 2. Each trait in fifths (cut on train).
  console.log('\nEach trait in fifths (cut on train) — train | test')
  for (const [key, label] of TRAITS) {
    const bs = buckets(train, key)
    console.log(`  ${label}`)
    R.traits[key] = bs.map((b) => {
      const tr = stats(train.filter((r) => r.f[key] != null && b.test(r.f[key]))), te = stats(test.filter((r) => r.f[key] != null && b.test(r.f[key])))
      console.log(`    ${b.label.padEnd(18)} train win ${W(tr.win).padStart(4)} med ${P(tr.median).padStart(5)} lost½ ${W(tr.lostHalf).padStart(4)} (${String(tr.n).padStart(4)}) | test win ${W(te.win).padStart(4)} med ${P(te.median).padStart(5)} lost½ ${W(te.lostHalf).padStart(4)} (${String(te.n).padStart(4)})`)
      return { label: b.label, train: tr, test: te }
    })
  }

  // 3. Filters picked on train, judged on test.
  const minN = rule === 'setup' ? 80 : 400
  const cands = candidateFilters(train).map((fl) => {
    const tr = stats(train.filter((r) => fl.pass(r.f)))
    return { ...fl, tr }
  }).filter((x) => x.tr.n >= minN).sort((a, b) => score(b.tr) - score(a.tr)).slice(0, 12)
  console.log(`\nBest filters chosen on train (n ≥ ${minN}), then test — baseline test: ${line(R.test)}`)
  for (const fl of cands) {
    const te = stats(test.filter((r) => fl.pass(r.f)))
    R.filters.push({ name: fl.name, train: fl.tr, test: te })
    console.log(`  ${fl.name}\n      train ${line(fl.tr)}\n      test  ${line(te)}`)
  }
  // The Leaders rule as a whole, and its parts (src/utils/leaders.js).
  const { mom12, vs200, slope200, volRankMax, spyUp } = LEADER
  const VARIANTS = [
    ['strength: mom12 + vs200 + slope200', { mom12, vs200, slope200 }],
    ['strength + S&P up', { mom12, vs200, slope200, spyUp }],
    ['strength + cheap options', { mom12, vs200, slope200, volRankMax }],
    ['LEADER (all five)', LEADER],
  ]
  console.log(`\nLeaders rule (thresholds = train medians; volatility cut = the worst train fifth) — baseline test: ${line(R.test)}`)
  R.leaders = []
  for (const [name, rl] of VARIANTS) {
    const pass = (r) => leaderMisses(r.lt, rl).length === 0
    const tr = stats(train.filter(pass)), te = stats(test.filter(pass)), no = stats(test.filter((r) => !pass(r)))
    R.leaders.push({ name, train: tr, test: te, testRest: no })
    console.log(`  ${name}\n      train ${line(tr)}\n      test  ${line(te)}\n      test, not leaders ${line(no)}`)
    const ys = [...new Set(rows.map((r) => r.t.slice(0, 4)))].sort()
    console.log(`      by year: ${ys.map((y) => { const s2 = stats(rows.filter((r) => r.t.startsWith(y) && pass(r))); return `${y} n ${s2.n} med ${P(s2.median)} win ${W(s2.win)}` }).join(' · ')}`)
  }

  // By year, for context.
  console.log('\nBy signal year')
  const years = [...new Set(rows.map((r) => r.t.slice(0, 4)))].sort()
  R.byYear = {}
  for (const y of years) { const s = stats(rows.filter((r) => r.t.startsWith(y))); R.byYear[y] = s; console.log(`  ${y}  ${line(s)}`) }
  console.log('')
  report.rules[rule] = R
}
const nowLeaders = todayStatus.filter((x) => x.misses.length === 0)
console.log(`Today: ${nowLeaders.length} leaders of ${todayStatus.length}; with 2+ signals and a rising 200-day: ${nowLeaders.filter((x) => x.score >= 2 && x.rising).map((x) => x.ticker).join(', ') || 'none'}`)
const missCount = {}; for (const x of todayStatus) for (const m of x.misses) missCount[m] = (missCount[m] ?? 0) + 1
console.log(`Misses today: ${JSON.stringify(missCount)}`)
writeFileSync('winner-traits.json', JSON.stringify({ ...report, rows: all.map((r) => ({ ticker: r.ticker, rule: r.rule, t: r.t, ...r.f, atm: r.atm?.ret, atmOpen: r.atm?.open, atmDays: r.atm?.days, atmHow: r.atm?.how, itm: r.itm?.ret })) }))
console.log('wrote winner-traits.json')
