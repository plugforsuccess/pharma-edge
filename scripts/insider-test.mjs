// The insider / short-interest test (owner, 2026-10-20: "Run it"). Research
// only, no DB writes. Pre-registered in docs/signal-engine/preregistration.md
// ("the insider / short-interest test"): at each month's first close, from
// filings made by that day — insider sell cluster, net selling, buy cluster
// (the mirror), short interest rising, heavily shorted — alone and combined
// with the weakness score; outcome = a 30% fall within 126 trading days and
// the 6-month return. Train < 2024 / test 2024 →. Pass on test: lift ≥ 2×,
// 6M median ≥ 5 points under the universe, ≥ 200 flagged months (recall
// reported, not required). Form 4 from the SEC DERA bulk files
// (scripts/lib/form345.mjs); short interest from FINRA (scripts/lib/finra.mjs,
// skipped and said when it refuses the runner).
import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { trailingVol, OPTION_MODEL } from '../src/utils/replay.js'
import { leaderSeries, leaderMisses } from '../src/utils/leaders.js'
import { annualFinancials, isFund } from '../src/utils/quality.js'
import { priceWeakness, businessWeakness, weaknessScore, forwardDrop, flagStats } from '../src/utils/weakness.js'
import { insiderSignals, shortSignals, insiderVerdict, INSIDER_PASS } from '../src/utils/insiders.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { cikMap, companyFacts, secStatus } from './lib/sec.mjs'
import { loadForm345 } from './lib/form345.mjs'
import { shortInterest, finraStatus } from './lib/finra.mjs'

const SPLIT = '2024-01-01'
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))
const labelOf = new Map(CHART_TICKERS.map((t) => [t.symbol, t.label ?? '']))
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`)

const spyBars = await dailyBars('SPY')
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
      months.push({ t: b.t, price, leader: leaderMisses(tr).length === 0, out: forwardDrop(bars, i) })
    })
    stocks.push({ tk, months, fund: isFund(tk, labelOf.get(tk)) })
  } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed`)
})
console.log(`\n${stocks.length} tickers · ${failed} failed · bars from Yahoo ${sources.yahoo} / edge ${sources.edge}`)

// SEC annual reports (business signals + shares outstanding).
const companies = stocks.filter((s) => !s.fund).map((s) => s.tk)
let ciks = new Map()
try { ciks = await cikMap() } catch (e) { console.log(`SEC ticker map unavailable (${e.message})`) }
const sec = await companyFacts(companies, ciks)
console.log(`SEC: facts for ${sec.ok} of ${companies.length} companies · failed ${sec.missing} · non-200 ${JSON.stringify(secStatus)}`)
if (sec.ok < 0.9 * (companies.length - sec.notFiler)) { console.log('SEC coverage under 90% — throttled run, not reporting.'); process.exit(1) }
// Latest cover-page share count filed by asOf (dei:EntityCommonStockSharesOutstanding).
function sharesOutAt(facts, asOf) {
  const rows = facts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []
  let best = null
  for (const f of rows) if (f.filed && f.filed <= asOf && f.val > 0 && (!best || f.filed > best.filed)) best = f
  return best?.val ?? null
}

// Form 4 (insiders) — the DERA quarterly bulk files.
console.log('\nForm 4 bulk files:')
const f345 = await loadForm345(new Set(companies))
console.log(`Form 4: ${f345.quarters.length} quarters loaded (${f345.quarters[0]} → ${f345.quarters[f345.quarters.length - 1]}), missing ${f345.missing.join(', ') || 'none'}; issuers with trades ${f345.trades.size}`)

// FINRA short interest, per symbol; skipped if the API refuses.
const shorts = new Map()
let finraOk = true
{
  const probe = await shortInterest('AAPL')
  if (!probe || !probe.length) { finraOk = false; console.log(`FINRA short interest unavailable (${JSON.stringify(finraStatus)}) — short signals skipped.`) }
  else {
    await mapLimit(companies, 4, async (tk) => { const s = await shortInterest(tk); if (s) shorts.set(tk, s) }, 100)
    const spans = [...shorts.values()].filter((s) => s.length).map((s) => s[0].date)
    console.log(`FINRA: ${shorts.size} symbols · earliest settlement ${spans.sort()[0] ?? '—'} · non-200 ${JSON.stringify(finraStatus)}`)
  }
}

// Stock-months.
const rows = []
for (const s of stocks) {
  if (s.fund) continue
  const facts = sec.facts.get(s.tk)
  const trades = f345.trades.get(s.tk) ?? []
  for (const m of s.months) {
    if (!m.out || m.t < '2021-04-01') continue // Form 4 window starts 2021q1
    const business = facts ? businessWeakness(annualFinancials(facts, m.t)) : null
    const weak = weaknessScore(m.price, business)
    const ins = insiderSignals(trades, m.t)
    const sh = finraOk ? shortSignals(shorts.get(s.tk), m.t, sharesOutAt(facts, m.t)) : { known: false }
    rows.push({ tk: s.tk, t: m.t, leader: m.leader, weak: weak.score, ins, sh, dropped: m.out.dropped, ret: m.out.ret })
  }
}
const train = rows.filter((r) => r.t < SPLIT), test = rows.filter((r) => r.t >= SPLIT)
console.log(`\nStock-months: ${rows.length} (train ${train.length}, test ${test.length}) · with any Form 4 history ${rows.filter((r) => r.ins.known).length} · with short data ${rows.filter((r) => r.sh.known).length}`)

const stats = (set, flag) => flagStats(set.map((r) => ({ ...r, flagged: !!flag(r) })))
const line = (name, s, v = '') => `  ${name.padEnd(34)} ${String(s.flagged).padStart(6)} ${pct(s.precision).padStart(8)} ${(s.lift == null ? '—' : s.lift.toFixed(2) + '×').padStart(7)} ${pct(s.recall).padStart(7)} ${pct(s.medianRet).padStart(9)} ${pct(s.medianAll).padStart(9)}  ${v}`
const header = `  ${'flag'.padEnd(34)} ${'months'.padStart(6)} ${'dropped'.padStart(8)} ${'lift'.padStart(7)} ${'caught'.padStart(7)} ${'6M median'.padStart(9)} ${'universe'.padStart(9)}`
const FLAGS = [
  ['I1 insider sell cluster', (r) => r.ins.sellCluster],
  ['I2 insider net selling', (r) => r.ins.netSelling],
  ['I1 or I2', (r) => r.ins.sellCluster || r.ins.netSelling],
  ['I3 insider buy cluster (mirror)', (r) => r.ins.buyCluster, true],
  ['S1 short interest rising', (r) => r.sh.shortRising],
  ['S2 heavily shorted', (r) => r.sh.shortHigh],
  ['S1 and S2', (r) => r.sh.shortRising && r.sh.shortHigh],
  ['I1 + weakness ≥ 3', (r) => r.ins.sellCluster && r.weak >= 3],
  ['I1 or I2, + weakness ≥ 3', (r) => (r.ins.sellCluster || r.ins.netSelling) && r.weak >= 3],
  ['S1 + weakness ≥ 3', (r) => r.sh.shortRising && r.weak >= 3],
  ['S2 + weakness ≥ 3', (r) => r.sh.shortHigh && r.weak >= 3],
  ['S1 + I1 or I2', (r) => r.sh.shortRising && (r.ins.sellCluster || r.ins.netSelling)],
  ['leader + I1', (r) => r.leader && r.ins.sellCluster],
  ['leader + I1 or I2', (r) => r.leader && (r.ins.sellCluster || r.ins.netSelling)],
  ['leader + S1', (r) => r.leader && r.sh.shortRising],
]
const report = { at: new Date().toISOString(), rows: rows.length, train: train.length, test: test.length, finra: finraOk, form4: { quarters: f345.quarters, missing: f345.missing, issuers: f345.trades.size }, test: {}, trainStats: {} }
for (const [name, set, key] of [['Test (2024 →)', test, 'test'], ['Train (before 2024)', train, 'trainStats']]) {
  console.log(`\n=== ${name}`)
  console.log(header)
  for (const [label, flag, mirror] of FLAGS) {
    const s = stats(set, flag)
    const v = key === 'test' ? insiderVerdict(s, { mirror: !!mirror }) : ''
    report[key][label] = { ...s, verdict: v || undefined }
    console.log(line(label, s, v ? `→ ${v.toUpperCase()}` : ''))
  }
}
console.log(`\nPass mark (test): lift ≥ ${INSIDER_PASS.lift}×, 6M median ≥ ${INSIDER_PASS.medianGap * 100} points under the universe, ≥ ${INSIDER_PASS.minFlagged} flagged months; the buy-cluster mirror: median ≥ 5 points over. Recall reported, not required.`)
console.log('Caveats: delisted names missing (hides failures); ~4.5 years; Form 4 symbols as filed; FINRA history as served; one bull market.')
writeFileSync('insider-test.json', JSON.stringify(report, null, 1))
console.log('Wrote insider-test.json')
