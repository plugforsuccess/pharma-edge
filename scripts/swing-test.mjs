// Can short option swings on leaders make money? (owner, 2026-10-16: "if the
// app is finding pull backs then why can't we do options swings and sell on
// a 5% spot gain which equates to more option profit" → "Run it".)
//
// The baseline already measured: the 1M at-the-money call on a leader day,
// all out at +40% on the call, else after 2 weeks — typical +22%, profitable
// 5 of 10, average +4%, one in four lost 67%+. This grid asks what fixes it:
//
//   entry   anyday  a leader, any day (one trade per ticker per 10 bars)
//           dip3    a leader closing ≥ 3% under its 20-day high
//           dip5    a leader closing ≥ 5% under its 20-day high
//   call    ATM, 30 / 60 / 91 calendar days to expiry, bought the next open
//   target  stock +3% / +5% / +7% (close at or above), or the call +40%
//   stop    none / stock −3% / stock −5% (close at or below)
//   hold    out after 10 or 15 trading days
//
// 3 × 3 × 4 × 3 × 2 = 216 variants. Priced with Black-Scholes on trailing
// 60-day vol (floor 15%), 2% slippage each way (the replay's OPTION_MODEL),
// re-marked daily on the vol known that day. Estimates, not quotes — real IV
// after a dip usually sits above trailing realised vol.
//
// Variants are ranked on train (signals before 2024) by the average return
// (what taking every trade earned), and reported on test (2024 →) — the
// only numbers that count. Research only: prints, uploads swing-test.json,
// writes nothing to the database.

import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { trailingVol, bsCall, OPTION_MODEL } from '../src/utils/replay.js'
import { leaderSeries, leaderMisses } from '../src/utils/leaders.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const SPLIT = '2024-01-01'
const GAP = 10
const ENTRIES = { anyday: 0, dip3: 0.03, dip5: 0.05 }
const DTES = [30, 60, 91]
const TARGETS = [['stock', 0.03], ['stock', 0.05], ['stock', 0.07], ['call', 0.40]]
const STOPS = [null, 0.03, 0.05]
const HOLDS = [10, 15]
const SLIP = OPTION_MODEL.slippage
const FLOOR = OPTION_MODEL.volFloor
const DAY = 86_400_000
const ms = (t) => Date.parse(`${t}T00:00:00Z`)

const keyOf = (v) => `${v.entry}|${v.dte}|${v.target[0]}${Math.round(v.target[1] * 100)}|${v.stop == null ? 'nostop' : `stop${Math.round(v.stop * 100)}`}|${v.hold}`
const VARIANTS = []
for (const entry of Object.keys(ENTRIES)) for (const dte of DTES) for (const target of TARGETS) for (const stop of STOPS) for (const hold of HOLDS) VARIANTS.push({ entry, dte, target, stop, hold })

const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

// One swing: signal at bar i's close, buy bar i+1's open.
function swing(bars, c, vol, i, v) {
  const e = i + 1
  if (e >= bars.length) return null
  const S0 = bars[e].o > 0 ? bars[e].o : bars[e].c
  const v0 = Math.max(FLOOR, vol[i] ?? 0)
  if (!(vol[i] > 0)) return null
  const K = S0
  const exp = ms(bars[e].t) + v.dte * DAY
  const cost = bsCall(S0, K, v.dte / 365, v0) * (1 + SLIP)
  if (!(cost > 0)) return null
  let j = e
  let reason = 'open'
  for (; j < bars.length; j++) {
    const left = Math.max(0, (exp - ms(bars[j].t)) / DAY) / 365
    const mark = bsCall(c[j], K, left, Math.max(FLOOR, vol[j] ?? v0))
    const stockRet = c[j] / S0 - 1
    const hit = v.target[0] === 'stock' ? stockRet >= v.target[1] : mark >= cost * (1 + v.target[1])
    if (hit) { reason = 'target'; return out(mark * (1 - SLIP)) }
    if (v.stop != null && stockRet <= -v.stop) { reason = 'stop'; return out(mark * (1 - SLIP)) }
    if (j - e >= v.hold || left <= 0) { reason = 'time'; return out(mark * (1 - SLIP)) }
  }
  // Still open on the last bar: marked, no exit slippage.
  const lastJ = bars.length - 1
  const left = Math.max(0, (exp - ms(bars[lastJ].t)) / DAY) / 365
  j = lastJ
  return out(bsCall(c[lastJ], K, left, Math.max(FLOOR, vol[lastJ] ?? v0)))
  function out(value) {
    return { t: bars[i].t, ret: value / cost - 1, reason, open: reason === 'open', days: j - e }
  }
}

function tradesFor(bars, spyBars) {
  if (!bars || bars.length < 300) return []
  const c = bars.map((b) => b.c), h = bars.map((b) => b.h)
  const vol = trailingVol(c, OPTION_MODEL.volBars)
  const ls = leaderSeries(bars, spyBars, { vol })
  const n = bars.length
  const leader = Array.from({ length: n }, (_, i) => leaderMisses(ls.at(i)).length === 0)
  const off = (i) => { let hi = 0; for (let j = Math.max(0, i - 19); j <= i; j++) hi = Math.max(hi, h[j]); return hi > 0 ? 1 - c[i] / hi : 0 }
  // Entry days per rule (one per GAP bars).
  const days = {}
  for (const [rule, dip] of Object.entries(ENTRIES)) {
    days[rule] = []
    let last = -Infinity
    for (let i = 260; i < n - 1; i++) {
      if (i - last < GAP || !leader[i] || (dip > 0 && off(i) < dip)) continue
      last = i
      days[rule].push(i)
    }
  }
  const out = {}
  for (const v of VARIANTS) {
    const k = keyOf(v)
    out[k] = []
    for (const i of days[v.entry]) { const tr = swing(bars, c, vol, i, v); if (tr) out[k].push(tr) }
  }
  return out
}

const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] }
function stats(rows) {
  const r = rows.map((x) => x.ret)
  if (!r.length) return { n: 0 }
  return {
    n: r.length,
    median: q(r, 0.5), win: r.filter((x) => x > 0).length / r.length, badq: q(r, 0.25),
    avg: r.reduce((a, x) => a + x, 0) / r.length,
    hit: rows.filter((x) => x.reason === 'target').length / rows.length,
    stopped: rows.filter((x) => x.reason === 'stop').length / rows.length,
    days: q(rows.map((x) => x.days), 0.5),
  }
}
const P = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(0)}%`)
const W = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const line = (s) => (s?.n ? `n ${String(s.n).padStart(5)} · typical ${P(s.median).padStart(5)} · profitable ${W(s.win).padStart(4)} · 1 in 4 ≤ ${P(s.badq).padStart(5)} · avg ${P(s.avg).padStart(5)} · hit ${W(s.hit).padStart(4)} · stopped ${W(s.stopped).padStart(4)} · ${s.days ?? '—'}d` : 'n 0')

const spyBars = await dailyBars('SPY')
const pooled = Object.fromEntries(VARIANTS.map((v) => [keyOf(v), []]))
let done = 0, failed = 0
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try {
    const t = tradesFor(await dailyBars(tk), spyBars)
    for (const [k, rows] of Object.entries(t)) pooled[k].push(...rows)
  } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed`)
})
console.log(`Tickers: ${universe.length - failed} (bars Yahoo ${sources.yahoo}, edge ${sources.edge})\n`)

const results = VARIANTS.map((v) => {
  const k = keyOf(v)
  const rows = pooled[k]
  return { key: k, ...v, train: stats(rows.filter((r) => r.t < SPLIT)), test: stats(rows.filter((r) => r.t >= SPLIT)), all: stats(rows),
    byYear: Object.fromEntries([...new Set(rows.map((r) => r.t.slice(0, 4)))].sort().map((y) => [y, stats(rows.filter((r) => r.t.startsWith(y)))])) }
})
const baseKey = 'anyday|30|call40|nostop|10'
const base = results.find((r) => r.key === baseKey)
console.log('════ Baseline (today\'s swing: 1M ATM, +40% on the call, no stop, 2 weeks) ════')
console.log(`train ${line(base.train)}\ntest  ${line(base.test)}\n`)

const ranked = results.filter((r) => (r.train.n ?? 0) >= 100).sort((a, b) => b.train.avg - a.train.avg)
console.log('════ Top 15 by train average — judged on test ════')
for (const r of ranked.slice(0, 15)) console.log(`${r.key.padEnd(34)}\n  train ${line(r.train)}\n  test  ${line(r.test)}`)
console.log('\n════ Top 15 by test average (hindsight — for context only) ════')
for (const r of [...results].filter((r) => (r.test.n ?? 0) >= 100).sort((a, b) => b.test.avg - a.test.avg).slice(0, 15)) console.log(`${r.key.padEnd(34)} test ${line(r.test)}`)

// The owner's question directly: sell on a 5% spot gain.
console.log('\n════ The +5% stock exit, every entry / expiry / stop (2-week hold) ════')
for (const r of results.filter((x) => x.target[0] === 'stock' && x.target[1] === 0.05 && x.hold === 10)) console.log(`${r.key.padEnd(34)} test ${line(r.test)}`)

const best = ranked[0]
console.log(`\nPicked on train: ${best.key}`)
console.log(`  test ${line(best.test)}`)
console.log(`  baseline test ${line(base.test)}`)
for (const [y, s] of Object.entries(best.byYear)) console.log(`  ${y} ${line(s)}`)

writeFileSync('swing-test.json', JSON.stringify({ ran_at: new Date().toISOString(), split: SPLIT, baseline: baseKey, results }))
console.log('wrote swing-test.json')
