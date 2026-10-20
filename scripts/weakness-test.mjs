// The weakness test (owner, 2026-10-20: "find stocks that also indicate
// weakness and thus likely will go down … Go, run the weakness test").
// Research only, no DB writes. Pre-registered in
// docs/signal-engine/preregistration.md ("the weakness test"): nine facts at
// each month's first close (five on price, four from the annual report filed
// by that day), the outcome = a 30% fall from that close to a later low
// within 126 trading days. Train < 2024 picks the score threshold (highest
// lift × recall); test 2024 → is reported against the pass mark: lift ≥ 2,
// recall ≥ 30%, median 6-month return ≥ 5 points under the universe median.
import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { trailingVol, OPTION_MODEL } from '../src/utils/replay.js'
import { leaderSeries, leaderMisses } from '../src/utils/leaders.js'
import { annualFinancials, isFund } from '../src/utils/quality.js'
import { priceWeakness, businessWeakness, weaknessScore, forwardDrop, flagStats, weakVerdict, PRICE_SIGNALS, BUSINESS_SIGNALS, WEAK, WEAK_PASS } from '../src/utils/weakness.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { cikMap, companyFacts, secStatus } from './lib/sec.mjs'

const SPLIT = '2024-01-01'
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))
const labelOf = new Map(CHART_TICKERS.map((t) => [t.symbol, t.label ?? '']))

const spyBars = await dailyBars('SPY')
// Month starts: the first trading day of each month on the SPY calendar.
const dates = spyBars.map((b) => b.t)
const monthStarts = new Set(dates.filter((t, i) => i > 0 && t.slice(0, 7) !== dates[i - 1].slice(0, 7)))

const stocks = []
let done = 0, failed = 0
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try {
    const bars = await dailyBars(tk)
    if (!bars || bars.length < 300) return
    const ls = leaderSeries(bars, spyBars, { vol: trailingVol(bars.map((b) => b.c), OPTION_MODEL.volBars) })
    const months = []
    bars.forEach((b, i) => {
      if (!monthStarts.has(b.t)) return
      const tr = ls.at(i)
      const price = priceWeakness(bars, i, tr)
      if (!price) return
      months.push({ t: b.t, i, price, leader: leaderMisses(tr).length === 0, out: forwardDrop(bars, i) })
    })
    stocks.push({ tk, bars, months, fund: isFund(tk, labelOf.get(tk)) })
  } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed`)
})
console.log(`\n${stocks.length} tickers · ${failed} failed · bars from Yahoo ${sources.yahoo} / edge ${sources.edge}`)

// SEC annual reports for every company (funds skip the business signals).
const companies = stocks.filter((s) => !s.fund).map((s) => s.tk)
let ciks = new Map()
try { ciks = await cikMap() } catch (e) { console.log(`SEC ticker map unavailable (${e.message})`) }
const sec = await companyFacts(companies, ciks)
console.log(`SEC: facts for ${sec.ok} of ${companies.length} companies · not filers ${sec.notFiler} · failed ${sec.missing} · non-200 ${JSON.stringify(secStatus)}`)
if (sec.ok < 0.9 * (companies.length - sec.notFiler)) { console.log('SEC coverage under 90% — throttled run, not reporting.'); process.exit(1) }

// Stock-months with both sides and a graded outcome.
const rows = []
for (const s of stocks) {
  const facts = s.fund ? null : sec.facts.get(s.tk)
  for (const m of s.months) {
    if (!m.out) continue
    const business = s.fund ? null : facts ? businessWeakness(annualFinancials(facts, m.t)) : null
    const sc = weaknessScore(m.price, business)
    rows.push({ tk: s.tk, t: m.t, fund: s.fund, hasBiz: business != null, leader: m.leader, priceFlags: m.price, bizFlags: business, ...sc, dropped: m.out.dropped, maxFall: m.out.maxFall, ret: m.out.ret })
  }
}
const train = rows.filter((r) => r.t < SPLIT), test = rows.filter((r) => r.t >= SPLIT)
console.log(`Stock-months graded: ${rows.length} (train ${train.length}, test ${test.length}) · with business data ${rows.filter((r) => r.hasBiz).length} · base rate of a 30% drop within 6 months: train ${pct(flagStats(train.map((r) => ({ ...r, flagged: false }))).base)} · test ${pct(flagStats(test.map((r) => ({ ...r, flagged: false }))).base)}`)

function pct(x, d = 1) { return x == null ? '—' : `${(x * 100).toFixed(d)}%` }
const line = (name, s) => `  ${name.padEnd(30)} ${String(s.flagged).padStart(6)} ${pct(s.precision).padStart(8)} ${(s.lift == null ? '—' : s.lift.toFixed(2) + '×').padStart(7)} ${pct(s.recall).padStart(7)} ${pct(s.medianRet).padStart(9)} ${pct(s.medianAll).padStart(9)}`
const header = `  ${'flag'.padEnd(30)} ${'months'.padStart(6)} ${'dropped'.padStart(8)} ${'lift'.padStart(7)} ${'caught'.padStart(7)} ${'6M median'.padStart(9)} ${'universe'.padStart(9)}`
const stats = (set, flag) => flagStats(set.map((r) => ({ ...r, flagged: flag(r) })))

// Threshold chosen on train: score ≥ k with the highest lift × recall.
const report = { at: new Date().toISOString(), rows: rows.length, train: train.length, test: test.length, thresholds: {}, signals: {}, leaders: {} }
let bestK = null, bestV = -1
console.log('\n=== Train (before 2024): score ≥ k')
console.log(header)
for (let k = 1; k <= 5; k++) {
  const s = stats(train, (r) => r.score >= k)
  report.thresholds[`train_${k}`] = s
  console.log(line(`score ≥ ${k}`, s))
  const v = (s.lift ?? 0) * (s.recall ?? 0)
  if (s.flagged >= 100 && v > bestV) { bestV = v; bestK = k }
}
console.log(`Chosen on train: score ≥ ${bestK}`)

console.log('\n=== Test (2024 →): the chosen threshold, every threshold, each signal alone')
console.log(header)
const chosen = stats(test, (r) => r.score >= bestK)
const verdict = weakVerdict(chosen)
report.chosen = { k: bestK, test: chosen, verdict }
console.log(line(`CHOSEN score ≥ ${bestK}`, chosen) + `   → ${verdict.toUpperCase()}`)
for (let k = 1; k <= 5; k++) { const s = stats(test, (r) => r.score >= k); report.thresholds[`test_${k}`] = s; console.log(line(`score ≥ ${k}`, s)) }
for (const k of ['price', 'business']) for (let n = 1; n <= 3; n++) { const s = stats(test, (r) => r[k] >= n); report.thresholds[`test_${k}_${n}`] = s; console.log(line(`${k} ≥ ${n}`, s)) }
for (const sig of [...PRICE_SIGNALS, ...BUSINESS_SIGNALS]) {
  const s = stats(test, (r) => (r.priceFlags?.[sig] || r.bizFlags?.[sig]) === true)
  report.signals[sig] = s
  console.log(line(sig, s))
}
console.log('\nSame, train (for stability):')
console.log(header)
for (const sig of [...PRICE_SIGNALS, ...BUSINESS_SIGNALS]) console.log(line(sig, stats(train, (r) => (r.priceFlags?.[sig] || r.bizFlags?.[sig]) === true)))

// Leaders at risk: among leader months, does a business flag change the outcome?
console.log('\n=== Leaders only (test): business sub-score ≥ 1 vs 0')
console.log(header)
const lt = test.filter((r) => r.leader && r.hasBiz)
report.leaders = { withFlag: stats(lt, (r) => r.business >= 1), stretched: stats(lt, (r) => r.priceFlags.stretched), n: lt.length }
console.log(line('leader + business flag', report.leaders.withFlag))
console.log(line('leader + stretched', report.leaders.stretched))
console.log(`  (${lt.length} leader-months; drops among all leader-months ${pct(report.leaders.withFlag.base)}, universe ${pct(chosen.base)})`)

console.log(`\nPass mark (test): lift ≥ ${WEAK_PASS.lift}×, caught ≥ ${pct(WEAK_PASS.recall, 0)}, 6M median ≥ ${WEAK_PASS.medianGap * 100} points under the universe. Outcome = a ${WEAK.drop * 100}% fall to a later low within ${WEAK.dropHorizon} trading days.`)
console.log('Caveats: today\'s ticker list omits delisted names (hides failures, biases against finding them); ~4.5 years, one bull market; no options / insider / short-interest history; monthly sampling.')
writeFileSync('weakness-test.json', JSON.stringify(report, null, 1))
console.log('Wrote weakness-test.json')
