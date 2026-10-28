// Top Forming job 1 (research/top-forming/PREREG.md): do stage-based exits beat a
// plain 25% trail on stocks a holder is already up 50%+ on? Prices only. Runs on
// GitHub's runners; writes job1-results.json and charts to out/, nothing to the DB.
import { writeFileSync, mkdirSync } from 'node:fs'
import { dailyBars, mapLimit, sources } from '../../scripts/lib/marketData.mjs'
import { publicFloatCiks, tickersFor } from '../../scripts/lib/secUniverse.mjs'
import { CHART_TICKERS } from '../../src/lib/chartTickers.js'
import { topFormingSeries, STAGE_RANK } from '../../src/utils/topForming.js'
import { TOP_FORMING } from '../../src/utils/topFormingConfig.js'
import { simulate, entryFacts, exitedEarly, isRunUp, POLICIES, EXIT } from '../../src/utils/exitPolicies.js'
import { stageChartSvg } from './charts.mjs'

const START = '2013-01-01', GRADE_FROM = '2018-01-01'
const U = { floatMin: 50e6, floatMax: 10e9, years: [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025], pxMin: 0.5, pxMax: 50, advMin: 1e6, gap: 60 }
const CASES = ['AEVA', 'AIRJ', 'RXRX', 'NAUT', 'GME', 'DJT', 'MSTR']
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`)
const med = (v) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null }
const mean = (v) => { const s = v.filter(Number.isFinite); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null }
const quant = (v, q) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo) }
const rngOf = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const seedOf = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)

// 1. Universe.
const floats = await publicFloatCiks({ years: U.years, min: U.floatMin, max: U.floatMax })
const byCik = await tickersFor(new Set(floats.keys()))
let tickers = [...new Set([...byCik.values(), ...CHART_TICKERS.map((t) => (typeof t === 'string' ? t : t.ticker ?? t.symbol)).filter(Boolean)])].filter((t) => /^[A-Z][A-Z0-9.]{0,5}$/.test(t))
if (process.env.TICKERS) tickers = process.env.TICKERS.split(',').map((s) => s.trim().toUpperCase())
for (const c of CASES) if (!tickers.includes(c)) tickers.push(c)
const gone = floats.size - byCik.size
console.log(`${floats.size} float-range filers · ${byCik.size} with a listed ticker today · ${tickers.length} tickers with the chart universe`)
console.log(`Survivorship: ${gone} of ${floats.size} (${pct(gone / floats.size, 0)}) float-range filers have no listed ticker today and are missing. That flatters buy-and-hold.`)

// 2. Per ticker: bars → series → entries, controls, validation counters.
const entries = [], controls = []
const V = { days: 0, events: 0, stage: {}, signal: {}, bucket: {}, warn: {} }
for (const s of TOP_FORMING.stageOrder) V.stage[s] = { days: 0, events: 0 }
const SIG = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'B4', 'B5', 'E1', 'E2', 'E3']
for (const k of SIG) V.signal[k] = { days: 0, events: 0 }
const caseSeries = {}, falsePos = []
let done = 0, failed = 0, tooShort = 0
const adv20 = (bars, i) => { if (i < 19) return 0; let s = 0; for (let k = i - 19; k <= i; k++) s += (bars[k].v ?? 0) * bars[k].c; return s / 20 }
const eligible = (bars, i) => bars[i].c >= U.pxMin && bars[i].c <= U.pxMax && adv20(bars, i) >= U.advMin
// Top event on day t (PREREG §4): a close ≤ 0.70 × close(t) within 60 sessions before any close > 1.10 × close(t).
function topEvent(bars, t) {
  if (t + 60 >= bars.length) return null
  const c0 = bars[t].c
  for (let d = t + 1; d <= t + 60; d++) { if (bars[d].c > 1.1 * c0) return { event: false }; if (bars[d].c <= 0.7 * c0) { let tr = d; for (let q = d; q <= t + 60; q++) if (bars[q].c < bars[tr].c) tr = q; return { event: true, trough: tr } } }
  return { event: false }
}
await mapLimit(tickers, Number(process.env.CONCURRENCY) || 4, async (tk) => {
  let bars
  try { bars = (await dailyBars(tk, { range: 'max' })).filter((b) => b.t >= START) } catch { failed++; return }
  if (++done % 250 === 0) console.log(`  ${done}/${tickers.length} · ${failed} failed · Yahoo ${sources.yahoo} / edge ${sources.edge}`)
  if (bars.length < 400) { tooShort++; return }
  const ser = topFormingSeries(bars)
  if (CASES.includes(tk)) caseSeries[tk] = { bars: bars.map((b) => ({ t: b.t, c: b.c })), score: ser.score, stage: ser.stage }
  // Validation counters (graded period, eligible days with a score).
  let firstStageDay = {}
  for (let t = 0; t < bars.length; t++) {
    const st = ser.stage[t]
    if (st == null || bars[t].t < GRADE_FROM || !eligible(bars, t)) continue
    const ev = topEvent(bars, t)
    if (!ev) continue
    V.days++; if (ev.event) V.events++
    V.stage[st].days++; if (ev.event) V.stage[st].events++
    for (const k of SIG) if (ser.signals[k][t] >= 0.5) { V.signal[k].days++; if (ev.event) V.signal[k].events++ }
    const bk = Math.min(9, Math.floor(ser.score[t] / 10)); V.bucket[bk] ??= { days: 0, events: 0 }; V.bucket[bk].days++; if (ev.event) V.bucket[bk].events++
    if (ev.event && st !== 'clear') (V.warn[st] ??= []).push(ev.trough - t)
    // False positives: Distribution or worse, then a double within 252 sessions.
    if (STAGE_RANK[st] >= 2) { let mx = bars[t].c; for (let d = t + 1; d <= Math.min(bars.length - 1, t + 252); d++) mx = Math.max(mx, bars[d].c); if (mx >= 2 * bars[t].c) falsePos.push({ tk, t: bars[t].t, stage: st, score: ser.score[t], gain: mx / bars[t].c - 1 }) }
  }
  // Job 1 entries: run-ups, one per 60 sessions.
  let lastE = -Infinity
  const mine = []
  for (let t = 0; t < bars.length - EXIT.horizon - 1; t++) {
    if (ser.stage[t] == null || bars[t].t < GRADE_FROM || t - lastE < U.gap || !eligible(bars, t) || !isRunUp(bars, t)) continue
    lastE = t; mine.push(t)
  }
  const run = (t, list, kind) => {
    const facts = entryFacts(bars, t)
    const row = { tk, t: bars[t].t, kind, G: facts.G, dbl: facts.dbl != null, stage0: ser.stage[t], p: {} }
    for (const pol of POLICIES) { const s = simulate(bars, t, pol, ser.stage); row.p[pol.key] = { R: s.R, early: exitedEarly(s, facts), out: s.exitIdx != null ? s.exitIdx - t : null } }
    list.push(row)
  }
  for (const t of mine) run(t, entries, 'runup')
  // Control: the same count of random eligible days, same spacing.
  const rand = rngOf(seedOf(tk)), pool = []
  for (let t = 0; t < bars.length - EXIT.horizon - 1; t++) if (ser.stage[t] != null && bars[t].t >= GRADE_FROM && eligible(bars, t)) pool.push(t)
  const picked = []
  for (let tries = 0; picked.length < mine.length && tries < mine.length * 50 && pool.length; tries++) { const t = pool[Math.floor(rand() * pool.length)]; if (picked.every((p) => Math.abs(p - t) >= U.gap)) picked.push(t) }
  for (const t of picked) run(t, controls, 'random')
}, 120)
console.log(`bars: ${done} loaded · ${failed} failed · ${tooShort} under 400 sessions · Yahoo ${sources.yahoo} / edge ${sources.edge}`)

// 3. Job 1 results.
const month = (d) => d.slice(0, 7)
const fold = (d) => `${d.slice(0, 4)}${+d.slice(5, 7) <= 6 ? 'H1' : 'H2'}`
function bootLower(rows, q, reps = 10000) {
  const g = new Map(); for (const r of rows) { const k = month(r.t); const e = g.get(k) ?? { s: 0, n: 0 }; e.s += r.x; e.n++; g.set(k, e) }
  const G = [...g.values()], rand = rngOf(20261028), m = []
  for (let b = 0; b < reps; b++) { let s = 0, n = 0; for (let k = 0; k < G.length; k++) { const e = G[Math.floor(rand() * G.length)]; s += e.s; n += e.n } m.push(s / n) }
  return { lo: quant(m, (1 - q) / 2), hi: quant(m, 1 - (1 - q) / 2) }
}
function summarize(list, label) {
  const withPeak = list.filter((r) => r.G >= EXIT.minPeak), doublers = list.filter((r) => r.dbl)
  const out = { label, n: list.length, withPeak: withPeak.length, doublers: doublers.length, policies: {} }
  console.log(`\n=== ${label}: ${list.length} entries · ${withPeak.length} with a peak gain ≥ 10% · ${doublers.length} went on to double within 252 sessions`)
  console.log(`  ${'policy'.padEnd(32)} ${'captured'.padStart(9)} ${'final avg'.padStart(10)} ${'final med'.padStart(10)} ${'give-back'.padStart(10)} ${'worst'.padStart(8)} ${'5th pct'.padStart(8)} ${'doublers out early'.padStart(19)}`)
  for (const pol of POLICIES) {
    const cap = withPeak.map((r) => r.p[pol.key].R / r.G), R = list.map((r) => r.p[pol.key].R)
    const o = { captured: mean(cap), capturedMedian: med(cap), finalAvg: mean(R), finalMedian: med(R), giveBack: mean(withPeak.map((r) => r.G - r.p[pol.key].R)), worst: Math.min(...R), p5: quant(R, 0.05), earlyShare: doublers.length ? doublers.filter((r) => r.p[pol.key].early).length / doublers.length : null }
    out.policies[pol.key] = o
    console.log(`  ${pol.name.padEnd(32)} ${pct(o.captured).padStart(9)} ${pct(o.finalAvg).padStart(10)} ${pct(o.finalMedian).padStart(10)} ${pct(o.giveBack).padStart(10)} ${pct(o.worst, 0).padStart(8)} ${pct(o.p5, 0).padStart(8)} ${pct(o.earlyShare, 0).padStart(19)}`)
  }
  return out
}
const report = { rules: TOP_FORMING.version, built: new Date().toISOString(), universe: { floats: floats.size, listed: byCik.size, gone, tickers: tickers.length, loaded: done, failed, tooShort } }
report.runup = summarize(entries, 'Run-up entries (holder up 50%+ from a 60-session low)')
report.random = summarize(controls, 'Control: random entry days, same stocks and spacing')

// Graded comparisons (PREREG §4).
const withPeak = entries.filter((r) => r.G >= EXIT.minPeak)
report.verdict = {}
console.log('\n=== Pass test (graded): captured gain vs the 25% trail, paired, clustered by entry month (97.5% interval)')
for (const key of ['stage', 'thirdsStage']) {
  const diffs = withPeak.map((r) => ({ t: r.t, x: (r.p[key].R - r.p.trail25.R) / r.G }))
  const b = bootLower(diffs, 0.975)
  const folds = {}; for (const d of diffs) (folds[fold(d.t)] ??= []).push(d.x)
  const fm = Object.entries(folds).sort().map(([f, xs]) => [f, mean(xs), xs.length])
  const posShare = fm.filter(([, m]) => m > 0).length / fm.length
  const p = report.runup.policies
  const early = p[key].earlyShare - p.trail25.earlyShare
  const c1 = b.lo > 0, c2 = posShare >= 0.6, c3 = early <= 0.05
  const verdict = withPeak.length < 200 ? 'inconclusive' : c1 && c2 && c3 ? 'pass' : 'fail'
  report.verdict[key] = { meanDiff: mean(diffs.map((d) => d.x)), lo: b.lo, hi: b.hi, foldsPositive: posShare, folds: fm, earlyDiff: early, checks: { interval: c1, folds: c2, doublers: c3 }, verdict }
  console.log(`  ${POLICIES.find((x) => x.key === key).name.padEnd(32)} diff ${pct(report.verdict[key].meanDiff)} [${pct(b.lo)}, ${pct(b.hi)}] · folds positive ${pct(posShare, 0)} (${fm.length}) · doublers out early ${early >= 0 ? '+' : ''}${(early * 100).toFixed(1)} pts → ${verdict.toUpperCase()}`)
  console.log(`    by fold: ${fm.map(([f, m, n]) => `${f} ${pct(m)} (${n})`).join(' · ')}`)
}
// Random control, same comparison (not graded).
const rPeak = controls.filter((r) => r.G >= EXIT.minPeak)
for (const key of ['stage', 'thirdsStage']) console.log(`  control (random days): ${key} − trail25 captured ${pct(mean(rPeak.map((r) => (r.p[key].R - r.p.trail25.R) / r.G)))} on ${rPeak.length}`)

// 4. Stage validation (reported, not graded).
const base = V.events / V.days
console.log(`\n=== Stage validation: top event = a close 30% under close(t) within 60 sessions before any close 10% above it`)
console.log(`  base rate ${pct(base, 2)} of ${V.days.toLocaleString('en-US')} eligible stock-days since ${GRADE_FROM}`)
report.validation = { base, days: V.days, events: V.events, stages: {}, signals: {}, buckets: {} }
for (const s of TOP_FORMING.stageOrder) {
  const x = V.stage[s], prec = x.days ? x.events / x.days : null, recall = V.events ? x.events / V.events : null
  report.validation.stages[s] = { days: x.days, precision: prec, recall, lift: prec / base, warnMedian: med(V.warn[s] ?? []) }
  console.log(`  ${TOP_FORMING.stageNames[s].padEnd(13)} days ${String(x.days).padStart(9)} · precision ${pct(prec, 2).padStart(7)} · recall ${pct(recall, 1).padStart(6)} · lift ${(prec / base).toFixed(2)}×${V.warn[s] ? ` · median ${med(V.warn[s])} sessions to the trough` : ''}${s !== 'clear' && prec / base < 1.5 ? '  ← under 1.5×' : ''}`)
}
console.log('  per signal (strength ≥ 0.5):')
for (const k of SIG) { const x = V.signal[k], l = x.days ? x.events / x.days / base : null; report.validation.signals[k] = { days: x.days, lift: l }; console.log(`    ${k}  days ${String(x.days).padStart(9)} · lift ${l?.toFixed(2) ?? '—'}×`) }
console.log('  calibration (score bucket → top-event rate):')
for (let b = 0; b <= 9; b++) { const x = V.bucket[b]; if (!x) continue; report.validation.buckets[b] = { days: x.days, rate: x.events / x.days }; console.log(`    ${String(b * 10).padStart(2)}–${b * 10 + 9}: ${pct(x.events / x.days, 2).padStart(7)} of ${x.days}`) }

// 5. Case studies + false positives.
mkdirSync('out', { recursive: true })
console.log('\n=== Case studies (stage changes)')
report.cases = {}
for (const tk of CASES) {
  const cs = caseSeries[tk]
  if (!cs) { console.log(`  ${tk}: no bars`); continue }
  const changes = []
  for (let i = 1; i < cs.stage.length; i++) if (cs.stage[i] !== cs.stage[i - 1] && cs.stage[i]) changes.push(`${cs.bars[i].t} ${TOP_FORMING.stageNames[cs.stage[i]]} $${cs.bars[i].c.toFixed(2)}`)
  report.cases[tk] = changes.slice(-14)
  console.log(`  ${tk}: ${changes.slice(-10).join(' → ')}`)
  writeFileSync(`out/${tk}.svg`, stageChartSvg(cs, `${tk} · price, TopScore and stage`))
}
const seen = new Set(), fp = falsePos.sort((a, b) => b.gain - a.gain).filter((r) => (seen.has(r.tk) ? false : seen.add(r.tk))).slice(0, 3)
report.falsePositives = fp
console.log(`\n=== Strongest false positives (Distribution or worse, then doubled within 252 sessions): ${falsePos.length} stock-days in all`)
for (const r of fp) console.log(`  ${r.tk} ${r.t} ${TOP_FORMING.stageNames[r.stage]} score ${r.score.toFixed(0)} → +${(r.gain * 100).toFixed(0)}%`)
writeFileSync('job1-results.json', JSON.stringify(report, null, 1))
console.log('\nwrote job1-results.json and out/*.svg')
