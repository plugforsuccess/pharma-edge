// Can the Leaders rule be fixed? (owner, 2026-10-19: "If leaders' gains
// aren't sustained and the list picks a stock after it's already moving up,
// what must we do to fix this?" → "Yes", run the test). Research only, no DB
// writes.
//
// Every variant is held as a basket — every stock that qualifies at a
// month's first close, equal weight, at most CAP_PER_GROUP per industry group
// (strongest 12-1 first), rebalanced monthly, close to close — beside SPY and
// an equal-weight "any stock" basket. The variants, all on top of today's
// rule (LEADER, S&P check off):
//   base       today's rule
//   uncapped   today's rule without the per-group cap
//   smooth     plus a steady climb: share of up days over the 12-1 window at
//              or above the train-period median of base leaders
//   unstretched plus close < 35% above the 200-day
//   strongGroup plus the stock's industry fund beating SPY over 12-1
//   calm       base, but cash (0%) for the month when SPY's 20-day volatility
//              sits in the top 20% of its past year
//   combo      smooth + unstretched + strongGroup
// Thresholds are fixed before results: the smooth cut is set on train
// (entries before 2024) only; the rest are round numbers chosen up front.
// Judge on test (2024 →). Caveats printed with the report: today's ticker list
// (survivorship), groups assigned from the last 120 days (a little hindsight
// for the group variants), no costs or dividends.

import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { trailingVol, OPTION_MODEL } from '../src/utils/replay.js'
import { leaderSeries, leaderMisses, LEADER } from '../src/utils/leaders.js'
import { THEMES, returnsByDate, themeOf } from '../src/utils/themes.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const SPLIT = '2024-01-01'
const CAP_PER_GROUP = 4
const STRETCH_MAX = 0.35
const CALM_PCT = 0.8
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

const spyBars = await dailyBars('SPY')
const dates = spyBars.map((b) => b.t)
const dIdx = new Map(dates.map((t, i) => [t, i]))
const spyC = spyBars.map((b) => b.c)
// Month starts: the first trading day of each month.
const monthStarts = dates.map((t, i) => (i > 0 && t.slice(0, 7) !== dates[i - 1].slice(0, 7) ? i : -1)).filter((i) => i >= 0)

// 12-1 return on any close series aligned to SPY dates.
const mom12At = (c, i) => (i >= 252 && c[i - 21] && c[i - 252] ? c[i - 21] / c[i - 252] - 1 : null)

// Industry funds on SPY dates.
const fundClose = new Map(), fundRet = new Map()
for (const [etf] of THEMES) {
  try {
    const b = await dailyBars(etf)
    fundRet.set(etf, returnsByDate(b))
    const m = new Map(b.map((x) => [x.t, x.c]))
    fundClose.set(etf, dates.map((t) => m.get(t) ?? null))
  } catch { /* fund missing → its stocks get no group check */ }
}

// SPY 20-day volatility rank within its past year → the calm switch.
const r1 = spyC.map((c, i) => (i ? Math.log(c / spyC[i - 1]) : 0))
const vol20 = spyC.map((_, i) => { if (i < 21) return null; let s = 0, q = 0; for (let k = i - 19; k <= i; k++) { s += r1[k]; q += r1[k] * r1[k] } const m = s / 20; return Math.sqrt(Math.max(0, q / 20 - m * m)) })
const volRank = vol20.map((v, i) => { if (v == null || i < 252) return null; let k = 0, n = 0; for (let j = i - 251; j <= i; j++) if (vol20[j] != null) { n++; if (vol20[j] <= v) k++ } return n ? k / n : null })

const stocks = []
let done = 0, failed = 0
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try {
    const bars = await dailyBars(tk)
    if (!bars || bars.length < 300) return
    const c = bars.map((b) => b.c)
    const vol = trailingVol(c, OPTION_MODEL.volBars)
    const ls = leaderSeries(bars, spyBars, { vol })
    const own = new Map(bars.map((b, i) => [b.t, i]))
    const theme = themeOf(tk, bars, fundRet)
    // Per SPY date: close, leader?, traits, steadiness.
    const close = dates.map((t) => { const i = own.get(t); return i == null ? null : c[i] })
    const info = monthStarts.map((si) => {
      const i = own.get(dates[si])
      if (i == null) return null
      const tr = ls.at(i)
      if (!tr || leaderMisses(tr).length) return { leader: false }
      let up = 0, n = 0
      for (let k = i - 251; k <= i - 21; k++) if (k > 0) { n++; if (c[k] > c[k - 1]) up++ }
      return { leader: true, mom12: tr.mom12, vs200: tr.vs200, pctUp: n ? up / n : null }
    })
    stocks.push({ tk, close, info, etf: theme?.etf ?? null, group: theme?.name ?? null })
  } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed`)
})
console.log(`\n${stocks.length} tickers · ${failed} failed · funds ${fundClose.size}/${THEMES.length} · bars from Yahoo ${sources.yahoo} / edge ${sources.edge}`)

// The smooth cut: median pctUp among base leaders at train month starts.
const trainUps = []
monthStarts.forEach((si, m) => { if (dates[si] >= SPLIT) return; for (const s of stocks) { const x = s.info[m]; if (x?.leader && x.pctUp != null) trainUps.push(x.pctUp) } })
trainUps.sort((a, b) => a - b)
const SMOOTH_MIN = trainUps.length ? trainUps[Math.floor(trainUps.length / 2)] : 0.5
console.log(`Smooth cut (train median share of up days): ${(SMOOTH_MIN * 100).toFixed(1)}% · from ${trainUps.length} train leader-months`)

const groupStrong = (s, si) => {
  if (!s.etf || !fundClose.has(s.etf)) return false
  const f = mom12At(fundClose.get(s.etf), si), sp = mom12At(spyC, si)
  return f != null && sp != null && f > sp
}
const VARIANTS = {
  base: { label: "Today's rule (cap 4 per group)", pick: (s, x) => true },
  uncapped: { label: "Today's rule, no group cap", pick: () => true, uncapped: true },
  smooth: { label: '+ steady climb', pick: (s, x) => x.pctUp != null && x.pctUp >= SMOOTH_MIN },
  unstretched: { label: `+ under ${STRETCH_MAX * 100}% above the 200-day`, pick: (s, x) => x.vs200 < STRETCH_MAX },
  strongGroup: { label: '+ its group beating the S&P', pick: (s, x, si) => groupStrong(s, si) },
  calm: { label: '+ cash when markets are violent', pick: () => true, calm: true },
  combo: { label: '+ steady + unstretched + strong group', pick: (s, x, si) => x.pctUp != null && x.pctUp >= SMOOTH_MIN && x.vs200 < STRETCH_MAX && groupStrong(s, si) },
}

// Monthly returns per variant + benchmarks.
const months = []
for (let m = 0; m < monthStarts.length - 1; m++) {
  const si = monthStarts[m], ei = monthStarts[m + 1]
  if (si < 260) continue
  const ret = (s) => (s.close[si] && s.close[ei] ? s.close[ei] / s.close[si] - 1 : null)
  const row = { t: dates[si], spy: spyC[ei] / spyC[si] - 1 }
  const all = stocks.map(ret).filter((v) => v != null)
  row.any = all.length ? all.reduce((a, v) => a + v, 0) / all.length : 0
  for (const [k, v] of Object.entries(VARIANTS)) {
    let picks = stocks.filter((s) => s.info[m]?.leader && v.pick(s, s.info[m], si) && ret(s) != null)
    if (!v.uncapped) {
      const byGroup = new Map()
      picks = picks.sort((a, b) => b.info[m].mom12 - a.info[m].mom12).filter((s) => {
        const g = s.group ?? `solo:${s.tk}`, n = byGroup.get(g) ?? 0
        if (n >= CAP_PER_GROUP) return false
        byGroup.set(g, n + 1); return true
      })
    }
    const off = v.calm && volRank[si] != null && volRank[si] >= CALM_PCT
    row[k] = off || !picks.length ? 0 : picks.reduce((a, s) => a + ret(s), 0) / picks.length
    row[`${k}_n`] = off ? 0 : picks.length
  }
  months.push(row)
}

function perf(rows, k) {
  if (!rows.length) return null
  let eq = 1, peak = 1, dd = 0
  for (const r of rows) { eq *= 1 + r[k]; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1) }
  const yrs = rows.length / 12
  const beat = rows.filter((r) => r[k] > r.spy).length / rows.length
  const names = rows.map((r) => r[`${k}_n`]).filter((v) => v != null)
  return { total: eq - 1, cagr: Math.pow(eq, 1 / yrs) - 1, maxDD: dd, beatMonths: beat, avgNames: names.length ? names.reduce((a, v) => a + v, 0) / names.length : null }
}
const P = (x) => (x == null ? '   —' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`)
const W = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const train = months.filter((r) => r.t < SPLIT), test = months.filter((r) => r.t >= SPLIT)
const keys = [...Object.keys(VARIANTS), 'any', 'spy']
const label = (k) => (VARIANTS[k]?.label ?? (k === 'any' ? 'Any stock (equal weight)' : 'S&P 500 (SPY)'))
const report = { at: new Date().toISOString(), smoothMin: SMOOTH_MIN, months: months.length, train: train.length, test: test.length, periods: {} }
for (const [name, rows] of [['Train (before 2024)', train], ['Test (2024 →)', test], ['All', months]]) {
  console.log(`\n=== ${name} · ${rows.length} months (${rows[0]?.t ?? '—'} → ${rows[rows.length - 1]?.t ?? '—'})`)
  console.log(`  ${'variant'.padEnd(42)} ${'total'.padStart(8)} ${'a year'.padStart(8)} ${'worst drop'.padStart(10)} ${'beat SPY months'.padStart(16)} ${'avg names'.padStart(9)}`)
  report.periods[name] = {}
  for (const k of keys) {
    const p = perf(rows, k)
    report.periods[name][k] = p
    if (p) console.log(`  ${label(k).padEnd(42)} ${P(p.total).padStart(8)} ${P(p.cagr).padStart(8)} ${P(p.maxDD).padStart(10)} ${W(k === 'spy' ? null : p.beatMonths).padStart(16)} ${(p.avgNames == null ? '' : p.avgNames.toFixed(1)).padStart(9)}`)
  }
}
console.log('\n=== By calendar year (each variant vs SPY)')
const years = [...new Set(months.map((r) => r.t.slice(0, 4)))]
for (const y of years) {
  const rows = months.filter((r) => r.t.startsWith(y))
  console.log(`  ${y} (${rows.length} mo): ` + keys.map((k) => `${k} ${P(perf(rows, k)?.total)}`).join(' · '))
}
report.byYear = Object.fromEntries(years.map((y) => [y, Object.fromEntries(keys.map((k) => [k, perf(months.filter((r) => r.t.startsWith(y)), k)]))]))
console.log('\nCaveats: today\'s ticker list (stocks that collapsed or were delisted are missing — flatters every line, the any-stock line too); groups are assigned from the last 120 days (a little hindsight for the group variants and the cap); monthly close-to-close, no costs, no dividends.')
writeFileSync('leader-fix-test.json', JSON.stringify(report, null, 1))
console.log('Wrote leader-fix-test.json')
