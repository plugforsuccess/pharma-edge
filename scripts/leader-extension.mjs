// Does it matter how far above its averages a leader is when you buy it?
// (owner, 2026-10-17: "some of these stocks aren't being signaled at moving
// averages prices rather high above the moving average unlike amd. Think of
// CNC" → "Do 2 only": test it, don't tag the rows yet.)
//
// AMD sat at its 50-day, 20% under its 20-day high; CNC sat 6% above its
// 50-day, 3% under its high. The leader-timing study only tested "5%+ off
// the 20-day high", never the distance to the 50-day, so this splits leader
// days (the Leaders rule, met that day) three ways:
//   vs50    close vs the 50-day: below · 0–5% · 5–10% · 10%+ above
//   vs200   close vs the 200-day: 9–20% · 20–35% · 35%+ above
//   off20   under the 20-day high: < 3% (near the high) · 3–10% · 10%+
// plus "AMD-style" (within 3% of the 50-day, either side, 10%+ off the high)
// vs "CNC-style" (5%+ above the 50-day, < 3% off the high).
// Each bucket is sampled on its own, at most once per 21 trading days per
// ticker. Same trade as leader-timing: at-the-money ~2-year call bought the
// next open, the playbook exit (70% at +100%, 15% at +200%, runner on a 30%
// trail, out with 6 months left), open trades at their mark. Buckets are
// read on train (before 2024) and checked on test (2024 →); a difference
// counts only if it shows in both. Research only — prints, uploads
// leader-extension.json, writes nothing to the database.

import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { trailingVol, oneTrade, OPTION_MODEL } from '../src/utils/replay.js'
import { ATM_MODEL, CLUSTER_GAP } from '../src/utils/callHistory.js'
import { leaderSeries, leaderMisses } from '../src/utils/leaders.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const SPLIT = '2024-01-01'
const GROUPS = {
  vs50: [['below', 'Below the 50-day', (x) => x.vs50 < 0], ['0-5', '0–5% above the 50-day', (x) => x.vs50 >= 0 && x.vs50 < 0.05],
    ['5-10', '5–10% above the 50-day', (x) => x.vs50 >= 0.05 && x.vs50 < 0.10], ['10+', '10%+ above the 50-day', (x) => x.vs50 >= 0.10]],
  vs200: [['9-20', '9–20% above the 200-day', (x) => x.vs200 < 0.20], ['20-35', '20–35% above the 200-day', (x) => x.vs200 >= 0.20 && x.vs200 < 0.35],
    ['35+', '35%+ above the 200-day', (x) => x.vs200 >= 0.35]],
  off20: [['near', '< 3% under the 20-day high', (x) => x.off20 < 0.03], ['3-10', '3–10% under the 20-day high', (x) => x.off20 >= 0.03 && x.off20 < 0.10],
    ['10+', '10%+ under the 20-day high', (x) => x.off20 >= 0.10]],
  style: [['any', 'Any leader day', () => true], ['amd', 'AMD-style: at the 50-day (±3%), 10%+ off the high', (x) => Math.abs(x.vs50) <= 0.03 && x.off20 >= 0.10],
    ['cnc', 'CNC-style: 5%+ above the 50-day, < 3% off the high', (x) => x.vs50 >= 0.05 && x.off20 < 0.03]],
}
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))
const sma = (xs, n) => { const out = Array(xs.length).fill(null); let s = 0; xs.forEach((x, i) => { s += x; if (i >= n) s -= xs[i - n]; if (i >= n - 1) out[i] = s / n }); return out }

function tradesFor(ticker, bars, spyBars) {
  if (!bars || bars.length < 400) return []
  const c = bars.map((b) => b.c), h = bars.map((b) => b.h)
  const s50 = sma(c, 50)
  const vol = trailingVol(c, OPTION_MODEL.volBars)
  const ls = leaderSeries(bars, spyBars, { vol })
  const n = bars.length
  const day = Array(n).fill(null)
  for (let i = 260; i < n - 2; i++) {
    const tr = ls.at(i)
    if (!tr || leaderMisses(tr).length || !(s50[i] > 0)) continue
    let hi = 0
    for (let j = i - 19; j <= i; j++) hi = Math.max(hi, h[j])
    day[i] = { vs50: c[i] / s50[i] - 1, vs200: tr.vs200, off20: hi > 0 ? 1 - c[i] / hi : 0 }
  }
  const cache = new Map()
  const trade = (i) => { if (!cache.has(i)) cache.set(i, oneTrade(bars, c, vol, i, { exitRule: 'targets', opt: ATM_MODEL })); return cache.get(i) }
  const out = []
  for (const [group, buckets] of Object.entries(GROUPS)) {
    for (const [key, , test] of buckets) {
      let last = -Infinity
      for (let i = 260; i < n - 2; i++) {
        if (!day[i] || i - last < CLUSTER_GAP || !test(day[i])) continue
        last = i
        const tr = trade(i)
        if (tr) out.push({ ticker, group, key, t: bars[i].t, ret: tr.optionReturn, open: tr.open, stock: tr.stockReturn })
      }
    }
  }
  return out
}

const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] }
function stats(rows) {
  const r = rows.map((x) => x.ret)
  if (!r.length) return { n: 0 }
  return { n: r.length, tickers: new Set(rows.map((x) => x.ticker)).size, win: r.filter((x) => x > 0).length / r.length, median: q(r, 0.5), badq: q(r, 0.25),
    avg: r.reduce((a, x) => a + x, 0) / r.length, lostHalf: r.filter((x) => x <= -0.5).length / r.length, open: rows.filter((x) => x.open).length / rows.length }
}
const P = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`)
const W = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const line = (s) => (s.n ? `n ${String(s.n).padStart(5)} · profitable ${W(s.win).padStart(4)} · typical ${P(s.median).padStart(5)} · 1 in 4 ≤ ${P(s.badq).padStart(5)} · avg ${P(s.avg).padStart(5)} · lost half ${W(s.lostHalf).padStart(4)} · open ${W(s.open)}` : 'n 0')

const spyBars = await dailyBars('SPY')
const all = []
let done = 0, failed = 0
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try { all.push(...tradesFor(tk, await dailyBars(tk), spyBars)) } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed`)
})
console.log(`Trades: ${all.length} from ${universe.length - failed} tickers (bars Yahoo ${sources.yahoo}, edge ${sources.edge})\n`)
const report = { ran_at: new Date().toISOString(), split: SPLIT, groups: {} }
const years = [...new Set(all.map((r) => r.t.slice(0, 4)))].sort()
for (const [group, buckets] of Object.entries(GROUPS)) {
  console.log(`════════ ${group} ════════`)
  report.groups[group] = {}
  for (const [key, label] of buckets) {
    const rows = all.filter((r) => r.group === group && r.key === key)
    const R = { label, all: stats(rows), train: stats(rows.filter((r) => r.t < SPLIT)), test: stats(rows.filter((r) => r.t >= SPLIT)), byYear: {} }
    for (const y of years) R.byYear[y] = stats(rows.filter((r) => r.t.startsWith(y)))
    console.log(`── ${label}\n  train ${line(R.train)}\n  test  ${line(R.test)}`)
    console.log(`  ${years.map((y) => `${y} ${R.byYear[y].n ? `${P(R.byYear[y].median)} (${R.byYear[y].n})` : '—'}`).join(' · ')}`)
    report.groups[group][key] = R
  }
  console.log('')
}
writeFileSync('leader-extension.json', JSON.stringify(report))
console.log('wrote leader-extension.json')
