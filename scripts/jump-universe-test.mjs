// Jumps on bigger stocks, with the missing factors (pre-registered 2026-11-17,
// docs/signal-engine/preregistration.md). Universe = the app's chart tickers
// (funds out). Q1: do non-earnings jumps fade here? Q2: the bear call spread on
// E3 non-earnings jumps. Q3: which factors separate the jumps that gained.
// Prints the report, uploads jump-universe.json, writes nothing to the DB.
import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { isFund } from '../src/utils/quality.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { cikMap, secStatus } from './lib/sec.mjs'
import { filingsMap } from './lib/secFilings.mjs'
import { eventFlags, countedJumps } from '../src/utils/secondJump.js'
import { entrySignal, putAfter, shortAfter, bearCallAfter, windowVerdict, jumpPath, jumpPathStats } from '../src/utils/shortWindow.js'
import { JUMP_BEAR } from '../src/utils/jumpBear.js'
import { reportOnJump } from '../src/utils/jumpRecord.js'
import { jumpTraits, jumpOutcome6, traitTable, traitHolds, LATER } from '../src/utils/jumpTraits.js'

const SPLIT = '2024-01-01'
const pct = (x, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`)
const tickers = [...new Set(CHART_TICKERS.map((t) => t.symbol))].filter((t) => !isFund(t) && !t.startsWith('^'))
console.log(`${tickers.length} tickers (funds out)`)

// 1. Bars, market context.
const stocks = []
let failed = 0
await mapLimit(tickers, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try { const bars = await dailyBars(tk); if (bars && bars.length >= 300) stocks.push({ tk, bars }) } catch { failed++ }
})
console.log(`${stocks.length} with ≥ 300 bars · ${failed} failed · Yahoo ${sources.yahoo} / edge ${sources.edge}`)
const spyBars = await dailyBars('SPY'), iwmBars = await dailyBars('IWM')
let vixBars = []
try { vixBars = await dailyBars('^VIX') } catch { console.log('VIX bars unavailable — the VIX factor is blank') }
const monthStarts = new Set(spyBars.map((b) => b.t).filter((t, i, a) => i > 0 && t.slice(0, 7) !== a[i - 1].slice(0, 7)))
const vixOn = new Map(vixBars.map((b) => [b.t, b.c]))
const iwmUp = new Map()
iwmBars.forEach((b, i) => { if (i >= 199) { let m = 0; for (let k = i - 199; k <= i; k++) m += iwmBars[k].c; iwmUp.set(b.t, b.c > m / 200) } })

// 2. SEC filings (earnings tag, cause, offerings).
const ciks = await cikMap()
const { filings, ok: flOk, failed: flFailed } = await filingsMap(stocks.filter((s) => ciks.get(s.tk)).map((s) => ({ cik: ciks.get(s.tk), ticker: s.tk })))
console.log(`SEC filings: ${flOk} · failed ${flFailed} · status ${JSON.stringify(secStatus)}`)
const tag = (tk, t) => { const fl = filings.get(tk); return fl ? (reportOnJump(fl, t) ? 'earnings' : 'other') : 'unknown' }

// 3. Jumps and entries.
const E0 = [], E3 = [], control = []
for (const s of stocks) {
  const flags = eventFlags(s.bars)
  for (const e of countedJumps(flags, 252)) {
    const t = s.bars[e].t
    const row = { tk: s.tk, s: e, j: e, t, bars: s.bars, ern: tag(s.tk, t), flags }
    E0.push(row)
    const g = entrySignal(s.bars, e, 'E3')
    if (g != null) E3.push({ ...row, s: g, t: s.bars[g].t })
  }
  s.bars.forEach((b, i) => { if (i >= 252 && monthStarts.has(b.t)) control.push({ tk: s.tk, s: i, t: b.t, bars: s.bars }) })
}
const isTest = (r) => r.t >= SPLIT
console.log(`jumps: ${E0.length} (test ${E0.filter(isTest).length}, non-earnings test ${E0.filter((r) => isTest(r) && r.ern === 'other').length}) · E3 entries ${E3.length} · control ${control.length}`)

// Q1 — the path.
const report = { at: new Date().toISOString(), universe: { tickers: tickers.length, withBars: stocks.length }, path: {}, q1: null, q2: {}, traits: null }
const sets = [
  ['non-earnings · test', E0.filter((r) => isTest(r) && r.ern === 'other')],
  ['non-earnings · 2026', E0.filter((r) => r.t >= '2026-01-01' && r.ern === 'other')],
  ['earnings · test', E0.filter((r) => isTest(r) && r.ern === 'earnings')],
  ['all jumps · train', E0.filter((r) => !isTest(r))],
  ['any day · test', control.filter(isTest)],
]
const MONTHS = [0.25, 0.5, 1, 2, 3, 6]
const stats = sets.map(([name, rows]) => [name, jumpPathStats(rows.map((r) => jumpPath(r.bars, r.s)))])
console.log('\n=== Q1 — path from the jump close (median change · share below the jump close · down 20%+)')
console.log(`  ${'after'.padEnd(6)} ${stats.map(([n, st]) => `${n} (${st.n})`.padEnd(28)).join(' ')}`)
for (const m of MONTHS) {
  const label = m < 1 ? `${Math.round(m * 4)}W` : `${m}M`
  console.log(`  ${label.padEnd(6)} ${stats.map(([, st]) => { const x = st.at[m]; return `${String(x.n).padStart(5)} ${pct(x.ret).padStart(5)} ${pct(x.below).padStart(4)} ${pct(x.down20).padStart(4)}`.padEnd(28) }).join(' ')}`)
}
for (const [n, st] of stats) report.path[n] = st
const ne3 = stats[0][1].at[3], any3 = stats[4][1].at[3]
const fade = ne3.n >= 30 && ne3.ret <= -0.05 && ne3.below >= 0.55 && (any3.ret - ne3.ret) >= 0.05 && (ne3.below - any3.below) >= 0.05
report.q1 = { fade, ne3, any3 }
console.log(`  Q1 verdict: ${fade ? 'FADE — yes' : 'NO FADE'} (non-earnings 3M median ${pct(ne3.ret)} · below ${pct(ne3.below)} vs any day ${pct(any3.ret)} · ${pct(any3.below)})`)

// Q2 — the trade.
console.log('\n=== Q2 — E3, non-earnings, test (avg / median / win / lost half) — return on max loss for the spread')
const line = (name, vd, extra = '') => `  ${name.padEnd(40)} ${String(vd.all.n).padStart(5)} ${pct(vd.all.avg, 1).padStart(7)} ${pct(vd.all.median, 1).padStart(7)} ${pct(vd.all.win).padStart(5)} ${pct(vd.all.lostHalf).padStart(5)}${extra}`
const ne = E3.filter((r) => isTest(r) && r.ern === 'other')
const SLIP5 = { ...JUMP_BEAR, slip: 0.05 }
const variants = [
  { name: 'bear call · ATM / +1 move *', graded: true, fn: (r) => bearCallAfter(r.bars, r.s) },
  { name: 'bear call · 5% slippage per leg', fn: (r) => bearCallAfter(r.bars, r.s, { b: SLIP5 }) },
  { name: 'put 42d · −20% take', fn: (r) => putAfter(r.bars, r.s, 42, { take: true }) },
  { name: 'short · −20% / +50% / 63d', fn: (r) => shortAfter(r.bars, r.s) },
]
for (const v of variants) {
  const vd = windowVerdict(ne.map((r) => ({ t: r.t, trade: v.fn(r) })))
  const yrs = Object.entries(vd.years).map(([y, x]) => `${y} ${pct(x.avg)} (${x.n})`).join(' · ')
  const verdict = v.graded ? (fade ? vd.verdict.toUpperCase() : `${vd.verdict.toUpperCase()} → read as NO (no fade)`) : ''
  console.log(line(v.name, vd, v.graded ? `  → ${verdict}  ${yrs}` : `  ${yrs}`))
  report.q2[v.name] = { ...vd, graded: !!v.graded }
}
const ctl = windowVerdict(control.filter(isTest).map((r) => ({ t: r.t, trade: bearCallAfter(r.bars, r.s) })))
console.log(line('bear call · any-day control', ctl))
report.q2.control = ctl

// Q3 — the factors.
const ctxFor = (r) => ({ filings: filings.get(r.tk) ?? null, binary: null, spyUp: null, jumps: r.flags, vix: vixOn.get(r.t) ?? null, iwmUp: iwmUp.has(r.t) ? iwmUp.get(r.t) : null })
const rows = E0.map((r) => ({ t: r.t, traits: jumpTraits(r.bars, r.s, ctxFor(r)), out: jumpOutcome6(r.bars, r.s) }))
const disc = traitTable(rows.filter((r) => r.t >= SPLIT && r.t < '2026-01-01'))
const chk = traitTable(rows.filter((r) => r.t >= '2026-01-01'))
report.traits = { disc, chk }
const f = (x) => (x ? `${String(x.n).padStart(4)} ${pct(x.gained).padStart(4)} ${pct(x.median).padStart(5)} ${(x.lift >= 0 ? '+' : '') + Math.round(x.lift * 100)}`.padEnd(24) : '   —'.padEnd(24))
console.log(`\n=== Q3 — what the jumps that gained had in common (gained = 6M close above the jump close) · discovery 2024–25 n ${disc.all.n} gained ${pct(disc.all.gained)} · 2026 n ${chk.all.n} gained ${pct(chk.all.gained)}`)
console.log(`  ${'factor'.padEnd(30)} ${'2024–25: n gain med lift'.padEnd(24)} ${'2026'.padEnd(24)} verdict`)
for (const later of [false, true]) {
  if (later) console.log('  — known later:')
  for (const k of Object.keys(disc.by)) {
    if (LATER.has(k) !== later || k === 'binary' || k === 'spy') continue
    for (const v of Object.keys(disc.by[k]).sort()) console.log(`  ${`${k}: ${v}`.padEnd(30)} ${f(disc.by[k][v])} ${f(chk.by[k]?.[v])} ${traitHolds(disc.by[k][v], chk.by[k]?.[v])}`)
  }
}
console.log('  Holds = lift ≥ 8 points in both sets, same direction, ≥ 30 jumps each. Many factors tested: one hit by chance is expected.')
console.log('\nCaveats: survivors only (buyouts / delistings missing); names without listed options not removed; model prices; overlapping signals; one mostly-rising market.')
writeFileSync('jump-universe.json', JSON.stringify(report))
console.log('Wrote jump-universe.json')
