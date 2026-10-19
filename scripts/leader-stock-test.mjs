// Leaders as plain stock picks, 5 years (owner, 2026-10-19: "Leader records
// needs further investigation" — the first year of the leader record had
// leaders bought on joining typically flat while the S&P was up ~11% over the
// same days). Research only, no DB writes.
//
// Every ticker, every entry rule, at most once per 21 trading days per ticker,
// bought at the signal day's close: the stock's change after 1 / 3 / 6 / 12
// months against SPY over the same days, and by entry year — so a bad year
// can be told apart from a rule that doesn't beat the market.
//   join      the day a stock becomes a leader (after 21+ days off) — the record
//   anyday    a leader, any day (the list)
//   withspy   the rule with the S&P-above-its-200-day check (the rule until
//             2026-10-19; the live rule no longer has it)
//   novol     the rule without the cheap-volatility check
//   momentum  only "up 17%+ over 12-1 months and above the 200-day"
//   baseline  any stock, every 21st trading day — the universe itself
// The universe is today's ticker list (survivorship flatters every rule
// alike; read rules against the baseline, not in absolute terms).

import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { trailingVol, OPTION_MODEL } from '../src/utils/replay.js'
import { leaderSeries, leaderMisses, LEADER } from '../src/utils/leaders.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const GAP = 21
const H = [['1M', 21], ['3M', 63], ['6M', 126], ['12M', 252]]
const { volRankMax: _v, ...NO_VOL } = LEADER
const WITH_SPY = { ...LEADER, spyUp: true }
const MOM = { mom12: LEADER.mom12, vs200: 0 }
const RULES = [
  ['join', 'Becomes a leader (the record)'],
  ['anyday', 'Leader, any day (the list)'],
  ['withspy', 'Leader rule with the S&P check (old)'],
  ['novol', 'Leader rule without the volatility check'],
  ['momentum', 'Momentum only (12-1 > +17%, above 200-day)'],
  ['baseline', 'Any stock, any day'],
]
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

function entriesFor(ticker, bars, spyAt) {
  if (!bars || bars.length < 300) return []
  const c = bars.map((b) => b.c)
  const vol = trailingVol(c, OPTION_MODEL.volBars)
  const ls = leaderSeries(bars, spyBars, { vol })
  const n = bars.length
  const tr = Array.from({ length: n }, (_, i) => ls.at(i))
  const ok = (rule) => tr.map((t) => leaderMisses(t, rule).length === 0)
  const lead = ok(LEADER)
  const flags = { anyday: lead, withspy: ok(WITH_SPY), novol: ok(NO_VOL), momentum: ok(MOM), baseline: tr.map((t) => t != null) }
  // join: first leader day after 21+ days off the list
  let lastOn = -Infinity
  flags.join = lead.map((on, i) => { const j = on && i - lastOn > GAP; if (on) lastOn = i; return j })
  const out = []
  for (const [rule] of RULES) {
    let last = -Infinity
    for (let i = 260; i < n; i++) {
      if (!flags[rule][i] || (rule !== 'join' && i - last < GAP)) continue
      last = i
      const s0 = spyAt.get(bars[i].t)
      if (!s0) continue
      const row = { ticker, rule, t: bars[i].t }
      for (const [k, d] of H) {
        if (i + d >= n) continue
        const s1 = spyAt.get(bars[i + d].t)
        if (!s1) continue
        row[k] = c[i + d] / c[i] - 1
        row[`spy${k}`] = s1 / s0 - 1
      }
      out.push(row)
    }
  }
  return out
}

const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
function stats(rows, k) {
  const r = rows.filter((x) => x[k] != null)
  if (!r.length) return { n: 0 }
  const g = r.map((x) => x[k]), ex = r.map((x) => x[k] - x[`spy${k}`])
  return { n: r.length, median: med(g), win: g.filter((x) => x > 0).length / g.length, avg: g.reduce((a, x) => a + x, 0) / g.length,
    spyMedian: med(r.map((x) => x[`spy${k}`])), beat: ex.filter((x) => x > 0).length / ex.length, excessMedian: med(ex), excessAvg: ex.reduce((a, x) => a + x, 0) / ex.length }
}
const P = (x) => (x == null ? '   —' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`)
const W = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const cell = (s) => (s.n ? `n ${String(s.n).padStart(5)} typ ${P(s.median).padStart(7)} up ${W(s.win).padStart(4)} avg ${P(s.avg).padStart(7)} | S&P typ ${P(s.spyMedian).padStart(7)} | beat ${W(s.beat).padStart(4)} excess typ ${P(s.excessMedian).padStart(7)} avg ${P(s.excessAvg).padStart(7)}` : 'n 0')

const spyBars = await dailyBars('SPY')
const spyAt = new Map(spyBars.map((b) => [b.t, b.c]))
const all = []
let done = 0, failed = 0
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try { all.push(...entriesFor(tk, await dailyBars(tk), spyAt)) } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed`)
})
console.log(`\n${universe.length} tickers · ${failed} failed · bars from Yahoo ${sources.yahoo} / edge ${sources.edge}\n`)

const report = { at: new Date().toISOString(), tickers: universe.length, failed, rules: {} }
for (const [k] of H) {
  console.log(`=== Held ${k} (stock bought at the close; S&P = SPY over the same days)`)
  for (const [rule, label] of RULES) { const s = stats(all.filter((x) => x.rule === rule), k); console.log(`  ${label.padEnd(44)} ${cell(s)}`) }
  console.log('')
}
const years = [...new Set(all.map((x) => x.t.slice(0, 4)))].sort()
for (const [k] of [['6M'], ['12M']]) {
  console.log(`=== By entry year, held ${k}`)
  for (const y of years) {
    console.log(`  ${y}`)
    for (const [rule, label] of RULES) { const s = stats(all.filter((x) => x.rule === rule && x.t.startsWith(y)), k); if (s.n) console.log(`    ${label.padEnd(42)} ${cell(s)}`) }
  }
  console.log('')
}
for (const [rule] of RULES) {
  report.rules[rule] = Object.fromEntries(H.map(([k]) => [k, { all: stats(all.filter((x) => x.rule === rule), k),
    byYear: Object.fromEntries(years.map((y) => [y, stats(all.filter((x) => x.rule === rule && x.t.startsWith(y)), k)])) }]))
}
writeFileSync('leader-stock-test.json', JSON.stringify(report, null, 1))
console.log('Wrote leader-stock-test.json')
