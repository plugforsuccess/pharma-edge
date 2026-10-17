// Emerging: can we catch a stock like CRL at the turn, before it becomes a
// leader? (owner, 2026-10-17: "how can we find leaders like Charles lab …
// essentially before they become leaders" → "Not 'emerging leader' just
// emerging".) CRL bottomed the week of Apr 7, 2025, under a falling 200-week
// — that week looked like hundreds of others, and the replay's Recovery rule
// (buy while the 200-day still falls) was a coin flip: 51% profitable,
// typical +2%. Emerging waits for the turn instead:
//   1. the 200-day was falling at some point in the last `look` bars,
//   2. and has stopped falling now (20-day slope ≥ 0),
//   3. the close is above it,
//   4. the 3-month return ranks in the top `top` of the universe that day,
//   5. the S&P 500 is above its own 200-day,
//   6. and it is not already a leader (the Leaders rule, src/utils/leaders.js).
// Grid: look 40 / 60 / 90 × top 20% / 30% = 6 variants, picked on train
// (signals before 2024), judged on test (2024 →). Compared, on the same
// trade, against leaders any day, a plain recovery (200-day falling, close
// above the 50-day) and any stock any day. The trade: at-the-money ~2-year
// call bought the next open, the playbook exit (70% at +100%, 15% at +200%,
// runner on a 30% trail, out with 6 months left), open trades at their mark,
// one entry per 21 trading days per ticker. Also: how often an Emerging stock
// became a leader within 6 months, and when CRL (and SPOTLIGHT tickers)
// would have shown up. Research only — prints, uploads emerging.json,
// writes nothing to the database.

import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { trailingVol, oneTrade, OPTION_MODEL } from '../src/utils/replay.js'
import { ATM_MODEL, CLUSTER_GAP } from '../src/utils/callHistory.js'
import { leaderSeries, leaderMisses } from '../src/utils/leaders.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const SPLIT = '2024-01-01'
const LOOKS = [40, 60, 90]
const TOPS = [0.2, 0.3]
const DEFAULT = '60|20'
const SPOTLIGHT = (process.env.SPOTLIGHT || 'CRL').split(',').map((s) => s.trim().toUpperCase())
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))
const sma = (xs, n) => { const out = Array(xs.length).fill(null); let s = 0; xs.forEach((x, i) => { s += x; if (i >= n) s -= xs[i - n]; if (i >= n - 1) out[i] = s / n }); return out }
const vkey = (look, top) => `${look}|${Math.round(top * 100)}`

// Pass 1: per-ticker features.
const spyBars = await dailyBars('SPY')
const spyC = spyBars.map((b) => b.c), spyS = sma(spyC, 200)
const spyUp = new Map(spyBars.map((b, i) => [b.t, spyS[i] != null && b.c > spyS[i]]))
const T = new Map()
let done = 0, failed = 0
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try {
    const bars = await dailyBars(tk)
    if (!bars || bars.length < 400) return
    const c = bars.map((b) => b.c)
    const s50 = sma(c, 50), s200 = sma(c, 200)
    const vol = trailingVol(c, OPTION_MODEL.volBars)
    const ls = leaderSeries(bars, spyBars, { vol })
    const n = bars.length
    const slope = Array(n).fill(null), leader = Array(n).fill(false), ret63 = Array(n).fill(null), lastFall = Array(n).fill(-Infinity)
    for (let i = 0; i < n; i++) {
      if (i >= 220 && s200[i - 20] > 0) slope[i] = s200[i] / s200[i - 20] - 1
      if (i >= 63 && c[i - 63] > 0) ret63[i] = c[i] / c[i - 63] - 1
      lastFall[i] = slope[i] != null && slope[i] < 0 ? i : (i ? lastFall[i - 1] : -Infinity)
      if (i >= 260) leader[i] = leaderMisses(ls.at(i)).length === 0
    }
    T.set(tk, { bars, c, s50, s200, vol, slope, leader, ret63, lastFall })
  } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed`)
})
console.log(`Tickers: ${T.size} (bars Yahoo ${sources.yahoo}, edge ${sources.edge})\n`)

// Cross-sectional rank of the 3-month return, per date (1 = best).
const byDate = new Map()
for (const [tk, d] of T) d.bars.forEach((b, i) => { if (d.ret63[i] != null) { if (!byDate.has(b.t)) byDate.set(b.t, []); byDate.get(b.t).push([tk, d.ret63[i]]) } })
const pct = new Map() // `${tk}|${t}` → share of the universe at or above it (0 = top)
for (const [t, xs] of byDate) {
  if (xs.length < 50) continue
  xs.sort((a, b) => b[1] - a[1])
  xs.forEach(([tk], k) => pct.set(`${tk}|${t}`, k / xs.length))
}

// Pass 2: entries and trades.
const RULES = []
for (const look of LOOKS) for (const top of TOPS) RULES.push([`emerging:${vkey(look, top)}`, (d, i, tk) => {
  const p = pct.get(`${tk}|${d.bars[i].t}`)
  return d.slope[i] != null && d.slope[i] >= 0 && i - d.lastFall[i] <= look && d.c[i] > d.s200[i] && p != null && p < top && spyUp.get(d.bars[i].t) === true && !d.leader[i]
}])
RULES.push(['leader', (d, i) => d.leader[i]])
RULES.push(['recovery', (d, i) => d.slope[i] != null && d.slope[i] < 0 && d.s50[i] != null && d.c[i] > d.s50[i]])
RULES.push(['baseline', () => true])

const all = []
const turned = {} // rule → [became a leader within 126 bars]
const spot = {}
for (const [tk, d] of T) {
  const n = d.bars.length
  const cache = new Map()
  const trade = (i) => { if (!cache.has(i)) cache.set(i, oneTrade(d.bars, d.c, d.vol, i, { exitRule: 'targets', opt: ATM_MODEL })); return cache.get(i) }
  for (const [rule, want] of RULES) {
    let last = -Infinity
    for (let i = 260; i < n - 2; i++) {
      if (i - last < CLUSTER_GAP || !want(d, i, tk)) continue
      last = i
      const tr = trade(i)
      if (!tr) continue
      let becameLeader = null
      if (rule.startsWith('emerging')) { for (let j = i + 1; j <= Math.min(n - 1, i + 126); j++) if (d.leader[j]) { becameLeader = j - i; break } }
      all.push({ ticker: tk, rule, t: d.bars[i].t, ret: tr.optionReturn, open: tr.open, stock: tr.stockReturn, becameLeader, room: i + 126 < n })
      if (SPOTLIGHT.includes(tk) && (rule === `emerging:${DEFAULT}` || rule === 'leader')) (spot[tk] ??= []).push({ rule, t: d.bars[i].t, close: d.c[i], ret: tr.optionReturn, stock: tr.stockReturn, open: tr.open })
    }
  }
}

const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] }
function stats(rows) {
  const r = rows.map((x) => x.ret)
  if (!r.length) return { n: 0 }
  const em = rows.filter((x) => x.room && x.rule.startsWith('emerging'))
  return { n: r.length, win: r.filter((x) => x > 0).length / r.length, median: q(r, 0.5), badq: q(r, 0.25), avg: r.reduce((a, x) => a + x, 0) / r.length,
    lostHalf: r.filter((x) => x <= -0.5).length / r.length, big: r.filter((x) => x >= 1).length / r.length, open: rows.filter((x) => x.open).length / rows.length,
    becameLeader: em.length ? em.filter((x) => x.becameLeader != null).length / em.length : null, daysToLeader: q(em.filter((x) => x.becameLeader != null).map((x) => x.becameLeader), 0.5) }
}
const P = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`)
const W = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const line = (s) => (s.n ? `n ${String(s.n).padStart(5)} · profitable ${W(s.win).padStart(4)} · typical ${P(s.median).padStart(5)} · 1 in 4 ≤ ${P(s.badq).padStart(5)} · avg ${P(s.avg).padStart(5)} · lost half ${W(s.lostHalf).padStart(4)} · ≥+100% ${W(s.big).padStart(4)} · open ${W(s.open)}${s.becameLeader != null ? ` · became a leader ${W(s.becameLeader)} (median ${s.daysToLeader ?? '—'} bars)` : ''}` : 'n 0')

const years = [...new Set(all.map((r) => r.t.slice(0, 4)))].sort()
const report = { ran_at: new Date().toISOString(), split: SPLIT, default: DEFAULT, rules: {}, spotlight: spot }
for (const [rule] of RULES) {
  const rows = all.filter((r) => r.rule === rule)
  const R = { all: stats(rows), train: stats(rows.filter((r) => r.t < SPLIT)), test: stats(rows.filter((r) => r.t >= SPLIT)), byYear: {} }
  for (const y of years) R.byYear[y] = stats(rows.filter((r) => r.t.startsWith(y)))
  report.rules[rule] = R
  console.log(`── ${rule}\n  train ${line(R.train)}\n  test  ${line(R.test)}`)
  console.log(`  ${years.map((y) => `${y} ${R.byYear[y].n ? `${P(R.byYear[y].median)} (${R.byYear[y].n})` : '—'}`).join(' · ')}`)
}
const picked = Object.entries(report.rules).filter(([k, R]) => k.startsWith('emerging') && R.train.n >= 100).sort((a, b) => b[1].train.avg - a[1].train.avg)[0]
report.picked = picked?.[0] ?? null
if (picked) console.log(`\nPicked on train: ${picked[0]}\n  test ${line(picked[1].test)}\n  leader test ${line(report.rules.leader.test)}\n  recovery test ${line(report.rules.recovery.test)}`)
for (const [tk, rows] of Object.entries(spot)) {
  console.log(`\n════ ${tk} ════`)
  for (const r of rows) console.log(`  ${r.rule.padEnd(14)} ${r.t} at $${r.close.toFixed(2)} → call ${P(r.ret)}${r.open ? ' (open, marked)' : ''} · stock ${P(r.stock)}`)
}
writeFileSync('emerging.json', JSON.stringify(report))
console.log('wrote emerging.json')
