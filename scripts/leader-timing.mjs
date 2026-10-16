// Does a timing signal add anything to the Leaders rule? (owner,
// 2026-10-16: "Should echo tango bravo be sunset … I don't even know if a
// timing signal is relevant or even as a chart drawing.")
//
// The same at-the-money ~2-year call and exit plan as the winner-traits
// study (oneTrade, ATM_MODEL, the playbook: 70% at +100%, 15% at +200%,
// runner on a 30% trail, out with 6 months left), bought the open after the
// signal day, on four entry rules, each at most once per 21 trading days
// per ticker:
//   signals   a leader with 2+ buy signals and a rising 200-day (the list)
//   anyday    a leader, any day it qualifies — no timing signal
//   pullback  a leader 5%+ off its 20-day high — a plain dip, no signal
//   baseline  any stock, any day (every 21st trading day) — no rule at all
// Train = signals before 2024, test = 2024 →. Research only.

import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { entryModel } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'
import { replaySignals, trailingVol, oneTrade, OPTION_MODEL } from '../src/utils/replay.js'
import { ATM_MODEL, CLUSTER_GAP } from '../src/utils/callHistory.js'
import { leaderSeries, leaderMisses } from '../src/utils/leaders.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const SPLIT = '2024-01-01'
const RULES = [
  ['signals', 'Leader + 2 signals (today\'s list)'],
  ['anyday', 'Leader, any day (no signal)'],
  ['pullback', 'Leader, 5%+ off 20-day high'],
  ['baseline', 'Any stock, any day'],
]
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

function tradesFor(ticker, bars, spyBars) {
  if (!bars || bars.length < 400) return []
  const model = entryModel(bars)
  const suite = suiteModel(bars)
  const sig = replaySignals(bars, model, suite)
  const c = bars.map((b) => b.c), h = bars.map((b) => b.h)
  const vol = trailingVol(c, OPTION_MODEL.volBars)
  const ls = leaderSeries(bars, spyBars, { vol })
  const n = bars.length
  const leader = Array.from({ length: n }, (_, i) => leaderMisses(ls.at(i)).length === 0)
  const want = {
    signals: (i) => leader[i] && sig.buyScore[i] >= 2 && sig.rising[i],
    anyday: (i) => leader[i],
    pullback: (i) => { if (!leader[i]) return false; let hi = 0; for (let j = i - 19; j <= i; j++) hi = Math.max(hi, h[j]); return c[i] / hi - 1 <= -0.05 },
    baseline: (i) => true,
  }
  const out = []
  for (const [rule] of RULES) {
    let last = -Infinity
    for (let i = 260; i < n - 2; i++) {
      if (i - last < CLUSTER_GAP || !want[rule](i)) continue
      last = i
      const tr = oneTrade(bars, c, vol, i, { exitRule: 'targets', opt: ATM_MODEL })
      if (tr) out.push({ ticker, rule, t: bars[i].t, ret: tr.optionReturn, open: tr.open, stock: tr.stockReturn })
    }
  }
  return out
}

const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] }
function stats(rows) {
  const r = rows.map((x) => x.ret)
  if (!r.length) return { n: 0 }
  return { n: r.length, win: r.filter((x) => x > 0).length / r.length, median: q(r, 0.5), avg: r.reduce((a, x) => a + x, 0) / r.length, lostHalf: r.filter((x) => x <= -0.5).length / r.length, big: r.filter((x) => x >= 1).length / r.length, open: rows.filter((x) => x.open).length / rows.length }
}
const P = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`)
const W = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const line = (s) => (s.n ? `n ${String(s.n).padStart(5)} · win ${W(s.win).padStart(4)} · median ${P(s.median).padStart(5)} · avg ${P(s.avg).padStart(5)} · lost half ${W(s.lostHalf).padStart(4)} · ≥+100% ${W(s.big).padStart(4)} · open ${W(s.open)}` : 'n 0')

const spyBars = await dailyBars('SPY')
const all = []
let done = 0, failed = 0
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try { all.push(...tradesFor(tk, await dailyBars(tk), spyBars)) } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed`)
})
console.log(`Trades: ${all.length} from ${universe.length - failed} tickers (bars Yahoo ${sources.yahoo}, edge ${sources.edge})\n`)
const report = { ran_at: new Date().toISOString(), split: SPLIT, rules: {} }
const years = [...new Set(all.map((r) => r.t.slice(0, 4)))].sort()
for (const [rule, label] of RULES) {
  const rows = all.filter((r) => r.rule === rule)
  const R = { all: stats(rows), train: stats(rows.filter((r) => r.t < SPLIT)), test: stats(rows.filter((r) => r.t >= SPLIT)), byYear: {} }
  console.log(`════ ${label} ════`)
  console.log(`all    ${line(R.all)}\ntrain  ${line(R.train)}\ntest   ${line(R.test)}`)
  for (const y of years) { R.byYear[y] = stats(rows.filter((r) => r.t.startsWith(y))); console.log(`  ${y}  ${line(R.byYear[y])}`) }
  console.log('')
  report.rules[rule] = R
}
writeFileSync('leader-timing.json', JSON.stringify(report))
console.log('wrote leader-timing.json')
