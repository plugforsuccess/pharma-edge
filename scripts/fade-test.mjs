// The Fade Screen test (owner spec, 2026-10-26: "Go"). Research only, no DB
// writes. Pre-registered in docs/signal-engine/preregistration.md ("the Fade
// Screen test"): a universe built from SEC public-float frames (never
// hand-picked), pre-revenue by the annual revenue known on the day, liquid
// enough for puts; the six factors at each month's first close with the
// spec's weights (capital redirect = 0 until the 8-K feed exists); outcomes
// within 126 trading days — fell ≥ 40% / doubled / the 6-month return.
// Train < 2024 / test 2024 →; pass for score ≥ 70: fallers ≥ 2× base,
// doublers ≤ base, 6M median ≥ 10 points under the universe, ≥ 100 months.
import { writeFileSync } from 'node:fs'
import { FADE, FADE_PASS, fadeScore, forwardFade, fadeStats, fadeVerdict, revenueAt, sharesOutAt, raiseAfter, outcomeRates, financingEvents } from '../src/utils/fade.js'
import { filingsMap } from './lib/secFilings.mjs'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { publicFloatCiks, tickersFor, compactFactsFor } from './lib/secUniverse.mjs'
import { loadForm345 } from './lib/form345.mjs'
import { shortInterest, finraStatus } from './lib/finra.mjs'

const SPLIT = '2024-01-01'
const U = { floatMin: 100e6, floatMax: 2e9, revenueMax: 25e6, advMin: 1e6, years: [2022, 2023, 2024, 2025] }
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`)

// 1. Universe from SEC.
console.log('Universe: public float $100M–$2B in any mid-year frame 2022–2025')
const floats = await publicFloatCiks({ years: U.years, min: U.floatMin, max: U.floatMax })
const byCik = await tickersFor(new Set(floats.keys()))
let entries = [...byCik].map(([cik, ticker]) => ({ cik, ticker }))
if (process.env.TICKERS) { const want = new Set(process.env.TICKERS.split(',').map((s) => s.trim().toUpperCase())); entries = entries.filter((e) => want.has(e.ticker)) }
console.log(`${floats.size} filers in range · ${entries.length} with a listed ticker`)
const { fin, ok: finOk, failed: finFailed } = await compactFactsFor(entries)
console.log(`SEC facts: ${finOk} · failed ${finFailed}`)
const today = new Date().toISOString().slice(0, 10)
const preRev = entries.filter((e) => { const f = fin.get(e.ticker); if (!f) return false; const r = revenueAt(f, today); return r == null || r < U.revenueMax })
console.log(`Pre-revenue today (annual revenue < $25M or none): ${preRev.length}`)

// 2. Bars (survivors only — stated).
const spyBars = await dailyBars('SPY')
const dates = spyBars.map((b) => b.t)
const monthStarts = new Set(dates.filter((t, i) => i > 0 && t.slice(0, 7) !== dates[i - 1].slice(0, 7)))
const stocks = []
let done = 0, failed = 0
await mapLimit(preRev, Number(process.env.CONCURRENCY) || 6, async ({ ticker }) => {
  try { const bars = await dailyBars(ticker); if (bars && bars.length >= 300) stocks.push({ tk: ticker, bars, fin: fin.get(ticker) }) } catch { failed++ }
  if (++done % 100 === 0) console.log(`  bars ${done}/${preRev.length} · ${failed} failed`)
})
console.log(`${stocks.length} tickers with ≥ 300 bars · ${failed} failed · bars from Yahoo ${sources.yahoo} / edge ${sources.edge}`)

// 3. Form 4 + FINRA.
console.log('\nForm 4 bulk files:')
const f345 = await loadForm345(new Set(stocks.map((s) => s.tk)))
console.log(`Form 4: ${f345.quarters.length} quarters, issuers with trades ${f345.trades.size}`)
const shorts = new Map()
const probe = await shortInterest('AAPL')
const finraOk = !!(probe && probe.length)
if (!finraOk) console.log(`FINRA unavailable (${JSON.stringify(finraStatus)}) — factor 1 scores 0 everywhere.`)
else { await mapLimit(stocks.map((s) => s.tk), 3, async (tk) => { const s = await shortInterest(tk); if (s) shorts.set(tk, s) }, 150); console.log(`FINRA: ${shorts.size} of ${stocks.length} symbols · non-200 ${JSON.stringify(finraStatus)}`) }

// 3b. SEC submissions: shelves, supplements, 8-K 3.02 (factor 5 + the raise outcome).
const cikOf = new Map(entries.map((e) => [e.ticker, e.cik]))
const { filings, ok: flOk, failed: flFailed } = await filingsMap(stocks.map((s) => ({ cik: cikOf.get(s.tk), ticker: s.tk })))
console.log(`SEC submissions: ${flOk} · failed ${flFailed}`)
const RAISE_DAYS = 183 // ≈ 126 trading days

// 4. Stock-months, point in time.
const adv = (bars, i) => { let s = 0; for (let k = i - 19; k <= i; k++) s += (bars[k].v ?? 0) * bars[k].c; return s / 20 }
const rows = [], todayRows = []
for (const s of stocks) {
  const trades = f345.trades.get(s.tk) ?? []
  const sh = shorts.get(s.tk) ?? []
  const fl = filings.get(s.tk) ?? null
  s.bars.forEach((b, i) => {
    const last = i === s.bars.length - 1
    if (!monthStarts.has(b.t) && !last) return
    if (i < 252) return
    const rev = revenueAt(s.fin, b.t)
    if (!(rev == null || rev < U.revenueMax) || adv(s.bars, i) < U.advMin) return
    const sc = fadeScore({ bars: s.bars, i, shorts: sh, trades, fin: s.fin, filings: fl })
    const so = sharesOutAt(s.fin, b.t)
    const siPct = so && sc.factors.shorts.known ? (sh.filter((x) => x.date <= b.t).pop()?.shares ?? 0) / so : null
    const row = { tk: s.tk, t: b.t, score: sc.score, tier: sc.tier, f: Object.fromEntries(Object.entries(sc.factors).map(([k, v]) => [k, v.points])), known: { shorts: !!sc.factors.shorts.known, runway: !!sc.factors.runway.known, redirect: !!fl }, siPct, raised: !!raiseAfter(fl, b.t, RAISE_DAYS), out: forwardFade(s.bars, i) }
    if (last) todayRows.push(row)
    if (monthStarts.has(b.t) && row.out) rows.push({ ...row, fell: row.out.fell, doubled: row.out.doubled, ret: row.out.ret })
  })
}
const train = rows.filter((r) => r.t < SPLIT), test = rows.filter((r) => r.t >= SPLIT)
const base = (set) => fadeStats(set.map((r) => ({ ...r, flagged: false })))
console.log(`\nStock-months: ${rows.length} (train ${train.length}, test ${test.length}) · tickers ${new Set(rows.map((r) => r.tk)).size}`)
console.log(`Base rates — fell 40% within 6 months: train ${pct(base(train).baseFell)} / test ${pct(base(test).baseFell)} · doubled: train ${pct(base(train).baseDoubled)} / test ${pct(base(test).baseDoubled)}`)
console.log(`Factor coverage (test months): short interest known ${pct(test.filter((r) => r.known.shorts).length / Math.max(1, test.length), 0)} · runway known ${pct(test.filter((r) => r.known.runway).length / Math.max(1, test.length), 0)} · filings known ${pct(test.filter((r) => r.known.redirect).length / Math.max(1, test.length), 0)} · any Form 4 trades ${pct(test.filter((r) => f345.trades.has(r.tk)).length / Math.max(1, test.length), 0)}`)

const stats = (set, flag) => fadeStats(set.map((r) => ({ ...r, flagged: !!flag(r) })))
const header = `  ${'flag'.padEnd(26)} ${'months'.padStart(6)} ${'fell 40%'.padStart(9)} ${'base'.padStart(6)} ${'doubled'.padStart(8)} ${'base'.padStart(6)} ${'caught'.padStart(7)} ${'6M median'.padStart(9)} ${'universe'.padStart(9)}`
const line = (name, s, v = '') => `  ${name.padEnd(26)} ${String(s.flagged).padStart(6)} ${pct(s.fellRate).padStart(9)} ${pct(s.baseFell).padStart(6)} ${pct(s.doubledRate).padStart(8)} ${pct(s.baseDoubled).padStart(6)} ${pct(s.recallFell).padStart(7)} ${pct(s.medianRet).padStart(9)} ${pct(s.medianAll).padStart(9)}  ${v}`
const FLAGS = [
  ['score ≥ 70 (actionable)', (r) => r.score >= 70, true],
  ['score ≥ 50 (watch)', (r) => r.score >= 50],
  ['score ≥ 30 (caution)', (r) => r.score >= 30],
  ['1 shorts pressing (25)', (r) => r.f.shorts === 25],
  ['1 shorts up only (10)', (r) => r.f.shorts === 10],
  ['2 failed catalyst', (r) => r.f.catalyst > 0],
  ['3 runway < 3 q (15)', (r) => r.f.runway === 15],
  ['3 runway < 5 q (any)', (r) => r.f.runway > 0],
  ['4 CEO / CFO sale (15)', (r) => r.f.insider === 15],
  ['4 any officer sale', (r) => r.f.insider > 0],
  ['5 shelf / ATM on file (10)', (r) => r.f.redirect > 0],
  ['6 trend break', (r) => r.f.trend > 0],
  ['3 + 5 (runway + shelf)', (r) => r.f.runway > 0 && r.f.redirect > 0],
  ['3 + 4 (runway + insider)', (r) => r.f.runway > 0 && r.f.insider > 0],
  ['1 + 2 (shorts + catalyst)', (r) => r.f.shorts === 25 && r.f.catalyst > 0],
]
const report = { at: new Date().toISOString(), universe: { floats: floats.size, listed: entries.length, preRevenue: preRev.length, withBars: stocks.length, finra: finraOk, form4: f345.quarters.length }, rows: rows.length, train: train.length, test: test.length, test_: {}, train_: {} }
for (const [name, set, key] of [['Test (2024 →)', test, 'test_'], ['Train (before 2024)', train, 'train_']]) {
  console.log(`\n=== ${name}`)
  console.log(header)
  for (const [label, flag, primary] of FLAGS) {
    const s = stats(set, flag)
    const v = key === 'test_' && primary ? fadeVerdict(s) : ''
    report[key][label] = { ...s, verdict: v || undefined }
    console.log(line(label, s, v ? `→ ${v.toUpperCase()}` : ''))
  }
}
// Dilution: did a raise (8-K 3.02 or 424B5) follow within 6 months?
console.log('\n=== Raised within 6 months (test, 2024 →) — pre-set reading: runway < 5 q ≥ 2× base, runway + shelf ≥ 3×')
console.log(`  ${'flag'.padEnd(26)} ${'months'.padStart(6)} ${'raised'.padStart(8)} ${'base'.padStart(6)} ${'lift'.padStart(6)} ${'caught'.padStart(7)}`)
report.raise = {}
for (const [label, flag] of [['3 runway < 5 q (any)', (r) => r.f.runway > 0], ['3 runway < 3 q (15)', (r) => r.f.runway === 15], ['5 shelf / ATM on file', (r) => r.f.redirect > 0], ['3 + 5 (runway + shelf)', (r) => r.f.runway > 0 && r.f.redirect > 0], ['score ≥ 50', (r) => r.score >= 50], ['score ≥ 70', (r) => r.score >= 70]]) {
  const set = test.map((r) => ({ ...r, flagged: !!flag(r) }))
  const o = outcomeRates(set, 'raised')
  const lift = o.base ? o.rate / o.base : null
  report.raise[label] = { flagged: set.filter((r) => r.flagged).length, ...o, lift }
  console.log(`  ${label.padEnd(26)} ${String(set.filter((r) => r.flagged).length).padStart(6)} ${pct(o.rate).padStart(8)} ${pct(o.base).padStart(6)} ${(lift == null ? '—' : lift.toFixed(2) + '×').padStart(6)} ${pct(o.recall).padStart(7)}`)
}
// Lead time: for each raise on test, the month start before it — was the runway flag lit, since when, and what the stock did.
{
  const byTk = new Map()
  for (const r of rows) { if (!byTk.has(r.tk)) byTk.set(r.tk, []); byTk.get(r.tk).push(r) }
  const barsOf = new Map(stocks.map((s) => [s.tk, s.bars]))
  const leads = []
  for (const s of stocks) {
    const fl = filings.get(s.tk); if (!fl) continue
    const ev = financingEvents(fl, '2099-01-01')
    for (const d of [...new Set(ev.raises)].filter((d) => d >= SPLIT)) {
      const ms = (byTk.get(s.tk) ?? []).filter((r) => r.t < d)
      const prior = ms[ms.length - 1]; if (!prior) continue
      let first = prior, k = ms.length - 1
      while (k > 0 && ms[k - 1].f.runway > 0 && prior.f.runway > 0) { first = ms[k - 1]; k-- }
      const bars = barsOf.get(s.tk)
      const iFirst = bars.findIndex((b) => b.t === first.t), iPre = bars.findIndex((b) => b.t >= d) - 1
      const move = iFirst >= 0 && iPre > iFirst ? bars[iPre].c / bars[iFirst].c - 1 : null
      const week = iPre >= 0 && iPre + 5 < bars.length ? bars[iPre + 5].c / bars[iPre].c - 1 : null
      leads.push({ tk: s.tk, raise: d, priorScore: prior.score, runwayLit: prior.f.runway > 0, shelf: prior.f.redirect > 0, leadDays: prior.f.runway > 0 ? Math.round((Date.parse(d) - Date.parse(first.t)) / 86400e3) : null, move, week })
    }
  }
  const med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
  const lit = leads.filter((l) => l.runwayLit)
  console.log(`\nRaises on test: ${leads.length} · runway flag lit at the prior month start: ${lit.length} (${pct(leads.length ? lit.length / leads.length : null, 0)}) · with a shelf too: ${leads.filter((l) => l.runwayLit && l.shelf).length}`)
  console.log(`  median lead from the first runway-flag month to the raise: ${med(lit.map((l) => l.leadDays))} days · stock move over that lead (median): ${pct(med(lit.map((l) => l.move)))} · raise week (day before → +5 sessions, median, all raises): ${pct(med(leads.map((l) => l.week)))}`)
  console.log(`  prior-month score ≥ 70 before the raise: ${leads.filter((l) => l.priorScore >= 70).length} · ≥ 50: ${leads.filter((l) => l.priorScore >= 50).length}`)
  report.leads = leads
}
// Squeeze-guard context: among actionable months, how many were > 25% of shares out short.
const act = test.filter((r) => r.score >= 70)
console.log(`\nActionable months with short interest > 25% of shares outstanding: ${act.filter((r) => r.siPct > 0.25).length} of ${act.length}`)

// AIRJ, if it is in the universe: the month-by-month score.
const airj = rows.filter((r) => r.tk === 'AIRJ').concat(todayRows.filter((r) => r.tk === 'AIRJ'))
if (airj.length) { console.log('\nAIRJ by month (score · factors · 6M outcome):'); for (const r of airj.slice(-16)) console.log(`  ${r.t}  ${String(r.score).padStart(3)}  ${JSON.stringify(r.f)}  ${r.out ? `fell ${pct(r.out.maxFall, 0)} / rose ${pct(r.out.maxRise, 0)} / 6M ${pct(r.out.ret, 0)}` : 'open'}`) }
else console.log('\nAIRJ not in the universe this run (float frame / revenue / bars).')

// Today's highest scores (no outcome yet).
todayRows.sort((a, b) => b.score - a.score)
console.log('\nHighest Fade Scores today (survivors; no outcome yet):')
for (const r of todayRows.slice(0, 15)) console.log(`  ${r.tk.padEnd(6)} ${String(r.score).padStart(3)} ${r.tier.padEnd(10)} ${JSON.stringify(r.f)}${r.siPct != null ? ` · short ${pct(r.siPct, 0)} of shares` : ''}`)
report.today = todayRows.slice(0, 40)
report.airj = airj

console.log(`\nPass mark (test, score ≥ 70): fallers ≥ ${FADE_PASS.lift}× base, doublers ≤ base, 6M median ≥ ${FADE_PASS.medianGap * 100} points under the universe, ≥ ${FADE_PASS.minFlagged} months. Outcome window ${FADE.horizon} trading days; fall ${FADE.fall * 100}%, rise ${FADE.rise * 100}%.`)
console.log('Caveats: survivors only (delisted names missing — hides the fallers); factor 5 = shelf / supplement only (no acquisition reading); a 424B5 also marks an ATM start; no milestone ledger (factor 2 is the mechanical event test); FINRA short interest is bi-monthly and lags; one bull market.')
writeFileSync('fade-test.json', JSON.stringify(report, null, 1))
console.log('Wrote fade-test.json')
