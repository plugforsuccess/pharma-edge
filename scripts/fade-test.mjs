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
import { FADE, FADE_PASS, fadeScore, shortsCovering, catalystHeld, forwardFade, fadeStats, fadeVerdict, revenueAt, sharesOutAt, raiseAfter, outcomeRates, financingEvents } from '../src/utils/fade.js'
import { filingsMap, exitFilingsFor } from './lib/secFilings.mjs'
import { straddleTrade, straddleStats, straddleVerdict, STRADDLE } from '../src/utils/straddle.js'
import { catalystRow, shortsRow, HOLDING_RISK } from '../src/utils/holdingRisks.js'
import { exitOf, exitStats } from '../src/utils/delisted.js'
import { putTrade, spreadTrade, shortTrade, bearStats, bearVerdict, JUMP_BEAR, listEntries } from '../src/utils/jumpBear.js'
import { eventFlags, listedFlags, jumpOutcome, countedJumps, wasListed, jumpStats, secondJumpVerdict, SECOND_JUMP, SECOND_JUMP_PASS } from '../src/utils/secondJump.js'
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
// Survivorship, sized: filers that sat in the float range in some year but have no listed ticker today
// are the delisted / acquired / gone-dark set the test cannot see.
const gone = floats.size - entries.length
console.log(`Survivorship: ${gone} of ${floats.size} (${(gone / floats.size * 100).toFixed(0)}%) float-range filers have no listed ticker today — the fallers the test cannot see are among them; every faller rate below is a floor.`)
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
const { filings, sics, ok: flOk, failed: flFailed } = await filingsMap(stocks.map((s) => ({ cik: cikOf.get(s.tk), ticker: s.tk })))
console.log(`SEC submissions: ${flOk} · failed ${flFailed}`)
// Follow-up variants (pre-registered 2026-10-26, second addendum). Binary-prone industries by SEC SIC code: the
// proxy for "a dated binary inside the window" (no PDUFA / certification / delivery calendar exists in the data).
const BINARY_SIC = new Set(['2834', '2835', '2836', '8731', '3711', '3713', '3714', '3721', '3724', '3728', '3760'])
const binaryProne = (tk) => BINARY_SIC.has(sics.get(tk) ?? '')
// Two-factor score: shorts pressing + failed catalyst only, rescaled to 100.
const score2 = (f) => (f.shorts + f.catalyst) * 2
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
    const inv = { cover: shortsCovering(sh, s.bars, i).on, held: catalystHeld(s.bars, i).on }
    const row = { tk: s.tk, t: b.t, i, scanLit: false, score: sc.score, tier: sc.tier, inv, score2: score2(Object.fromEntries(Object.entries(sc.factors).map(([k, v]) => [k, v.points]))), binary: binaryProne(s.tk), sic: sics.get(s.tk) ?? null, f: Object.fromEntries(Object.entries(sc.factors).map(([k, v]) => [k, v.points])), known: { shorts: !!sc.factors.shorts.known, runway: !!sc.factors.runway.known, redirect: !!fl }, siPct, raised: !!raiseAfter(fl, b.t, RAISE_DAYS), out: forwardFade(s.bars, i) }
    const cr = catalystRow(s.bars, i), shr = shortsRow(sh, s.bars, i, so)
    row.scanLit = !!(cr && cr.sessionsBelow >= HOLDING_RISK.belowSessions && shr && shr.siChange >= HOLDING_RISK.siRise && shr.priceChange != null && shr.priceChange <= -HOLDING_RISK.priceDrop)
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
const report = { at: new Date().toISOString(), universe: { floats: floats.size, listed: entries.length, unlisted: gone, preRevenue: preRev.length, withBars: stocks.length, finra: finraOk, form4: f345.quarters.length }, rows: rows.length, train: train.length, test: test.length, test_: {}, train_: {} }
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
const act = test.filter((r) => r.score >= 70)
// By calendar year (owner, 2026-10-26: "none of the results has been seen in a down year" — 2022 is in the data).
console.log('\n=== By year, score ≥ 70 vs the universe (2022 was a down year)')
console.log(`  ${'year'.padEnd(6)} ${'months'.padStart(7)} ${'flagged'.padStart(8)} ${'fell'.padStart(7)} ${'base'.padStart(7)} ${'doubled'.padStart(8)} ${'base'.padStart(7)} ${'median'.padStart(8)} ${'universe'.padStart(9)}`)
report.byYear = {}
for (const y of [...new Set(rows.map((r) => r.t.slice(0, 4)))].sort()) {
  const set = rows.filter((r) => r.t.startsWith(y))
  const s = stats(set, (r) => r.score >= 70)
  report.byYear[y] = s
  console.log(`  ${y.padEnd(6)} ${String(set.length).padStart(7)} ${String(s.flagged).padStart(8)} ${pct(s.fellRate).padStart(7)} ${pct(s.baseFell).padStart(7)} ${pct(s.doubledRate).padStart(8)} ${pct(s.baseDoubled).padStart(7)} ${pct(s.medianRet).padStart(8)} ${pct(s.medianAll).padStart(9)}`)
}
// Follow-up variants (owner, 2026-10-26, after the first result). Same four conditions on each.
console.log('\n=== Follow-up variants (test, 2024 →) — same pass mark on each')
console.log(header)
report.variants = {}
const nb = test.filter((r) => !r.binary)
console.log(`  binary-prone industries (SIC ${[...BINARY_SIC].join(' ')}): ${pct(test.filter((r) => r.binary).length / Math.max(1, test.length), 0)} of test months · SIC known ${pct(test.filter((r) => r.sic).length / Math.max(1, test.length), 0)}`)
for (const [label, set, flag] of [
  ['A  score ≥ 70, not binary-prone', nb, (r) => r.score >= 70],
  ['A\' score ≥ 70, binary-prone', test.filter((r) => r.binary), (r) => r.score >= 70],
  ['B  2-factor ≥ 70 (cat 25 + SI ≥ 10)', test, (r) => r.score2 >= 70],
  ['B\' 2-factor = 100 (both full)', test, (r) => r.score2 === 100],
  ['C  2-factor ≥ 70, not binary-prone', nb, (r) => r.score2 >= 70],
  ['C\' 2-factor = 100, not binary-prone', nb, (r) => r.score2 === 100],
]) {
  const s = stats(set, flag)
  const v = fadeVerdict(s)
  report.variants[label] = { ...s, verdict: v }
  console.log(line(label, s, `→ ${v.toUpperCase()}`))
}
// D — the long-side inverse (pre-registered: doublers ≥ 2× base, fallers ≤ base, 6M median ≥ 10 points ABOVE the universe, ≥ 100 months).
console.log('\n=== D  Long-side inverse (test, 2024 →) — pass: doublers ≥ 2× base, fallers ≤ base, median ≥ +10 pts vs universe, ≥ 100 months')
console.log(header)
report.inverse = {}
const inverseVerdict = (s) => (s.flagged < FADE_PASS.minFlagged ? 'inconclusive' : s.doubledRate >= FADE_PASS.lift * s.baseDoubled && s.fellRate <= s.baseFell && s.medianRet - s.medianAll >= FADE_PASS.medianGap ? 'pass' : 'fail')
for (const [label, set, flag] of [
  ['D  held + covering', test, (r) => r.inv.held && r.inv.cover],
  ['D1 catalyst held alone', test, (r) => r.inv.held],
  ['D2 shorts covering alone', test, (r) => r.inv.cover],
  ['D\' held + covering, not binary-prone', nb, (r) => r.inv.held && r.inv.cover],
  ['D  held + covering (train)', train, (r) => r.inv.held && r.inv.cover],
]) {
  const s = stats(set, flag)
  const v = inverseVerdict(s)
  report.inverse[label] = { ...s, verdict: v }
  console.log(line(label, s, `→ ${v.toUpperCase()}`))
}
// Where the actionable doublers sit, by SIC.
{
  const bySic = new Map()
  for (const r of act) { const k = r.sic ?? '?'; const o = bySic.get(k) ?? { n: 0, d: 0, f: 0 }; o.n++; if (r.doubled) o.d++; if (r.fell) o.f++; bySic.set(k, o) }
  const top = [...bySic].sort((a, b) => b[1].n - a[1].n).slice(0, 10)
  console.log('  actionable months by SIC (n · doubled · fell): ' + top.map(([k, o]) => `${k}${BINARY_SIC.has(k) ? '*' : ''} ${o.n}·${o.d}·${o.f}`).join(' | ') + '  (* binary-prone)')
  report.actBySic = Object.fromEntries(bySic)
}
// The straddle test (pre-registered 2026-10-26): long volatility on both-lit months vs the universe.
{
  const barsOf = new Map(stocks.map((s) => [s.tk, s.bars]))
  const both = (r) => r.f.catalyst > 0 && r.f.shorts === 25
  const sets = [['universe (control)', (r) => true], ["B' both facts lit (test def.)", both], ['scan definition (as shipped)', (r) => r.scanLit]]
  console.log(`\n=== Straddle test — ATM call + put, ${STRADDLE.horizon} sessions, σ = premium × RV60, ${STRADDLE.slip * 100}% slip per fill`)
  console.log(`  ${'set'.padEnd(30)} ${'prem'.padStart(5)} ${'exit'.padEnd(8)} ${'n'.padStart(5)} ${'avg'.padStart(7)} ${'median'.padStart(7)} ${'win'.padStart(6)} ${'lost½'.padStart(6)} ${'hit'.padStart(5)} ${'days'.padStart(5)}`)
  report.straddle = {}
  for (const period of [['test', test], ['train', train]]) {
    console.log(`  — ${period[0]}`)
    const cache = new Map()
    const tradeFor = (r, prem, target) => { const k = `${r.tk}|${r.i}|${prem}|${target}`; if (!cache.has(k)) cache.set(k, straddleTrade(barsOf.get(r.tk), r.i, { premium: prem, target })); return cache.get(k) }
    for (const prem of STRADDLE.premiums) for (const [exitName, target] of [['expiry', null], ['2× target', STRADDLE.target]]) {
      const uni = straddleStats(period[1].map((r) => tradeFor(r, prem, target)))
      for (const [name, flag] of sets) {
        const st = name.startsWith('universe') ? uni : straddleStats(period[1].filter(flag).map((r) => tradeFor(r, prem, target)))
        const primary = period[0] === 'test' && prem === STRADDLE.premium && target == null && name.startsWith("B'")
        const v = primary ? straddleVerdict(st, uni) : ''
        report.straddle[`${period[0]}|${name}|${prem}|${exitName}`] = { ...st, verdict: v || undefined }
        if (st.n) console.log(`  ${name.padEnd(30)} ${String(prem).padStart(5)} ${exitName.padEnd(8)} ${String(st.n).padStart(5)} ${pct(st.avg).padStart(7)} ${pct(st.median).padStart(7)} ${pct(st.win, 0).padStart(6)} ${pct(st.lostHalf, 0).padStart(6)} ${pct(st.hitRate, 0).padStart(5)} ${String(st.medDays).padStart(5)}${v ? `  → ${v.toUpperCase()} (primary)` : ''}`)
      }
    }
  }
  console.log(`  Pass (test, premium ${STRADDLE.premium}, hold to expiry, B'): avg > 0, avg ≥ universe + 10 pts, median > universe median, ≥ 100 trades. Premium 1.0 is optimistic for these names.`)
}
// The second jump (pre-registered 2026-10-27): the next jump on a listed stock vs jumps elsewhere vs any day.
{
  const listedJ = [], otherJ = [], anyDay = []
  for (const s of stocks) {
    const sh = shorts.get(s.tk) ?? []
    const ev = eventFlags(s.bars)
    const lst = listedFlags(s.bars, ev, sh)
    const okAt = (i) => { if (i < 252) return false; const rev = revenueAt(s.fin, s.bars[i].t); return (rev == null || rev < U.revenueMax) && adv(s.bars, i) >= U.advMin }
    for (const e of countedJumps(ev, 252)) {
      if (!okAt(e)) continue
      const out = jumpOutcome(s.bars, e)
      if (!out) continue
      const so = sharesOutAt(s.fin, s.bars[e - 1].t)
      const cur = sh.filter((x) => x.date <= s.bars[e - 1].t).pop()
      const siPct = so && cur ? cur.shares / so : null
      const row = { tk: s.tk, e, t: s.bars[e].t, jump: s.bars[e].c / s.bars[e - 1].c - 1, siPct, out }
      ;(wasListed(lst, e) ? listedJ : otherJ).push(row)
    }
    s.bars.forEach((b, i) => { if (monthStarts.has(b.t) && okAt(i)) { const out = jumpOutcome(s.bars, i); if (out) anyDay.push({ tk: s.tk, t: b.t, out }) } })
  }
  const H = SECOND_JUMP.horizon
  const fmt = (name, st) => `  ${name.padEnd(34)} ${String(st.n).padStart(5)} ${SECOND_JUMP.holds.map((h) => pct(st.holds[h].median).padStart(8)).join('')} ${pct(st.holds[H].avg).padStart(8)} ${pct(st.holds[H].win, 0).padStart(6)} ${pct(st.target.median).padStart(8)} ${pct(st.target.hitRate, 0).padStart(6)} ${pct(st.fell, 0).padStart(6)} ${pct(st.doubled, 0).padStart(6)}`
  console.log(`\n=== Second jump — shares bought the open after a jump (≥ 10% on ≥ 3× volume), one per stock per ${SECOND_JUMP.gap} sessions`)
  console.log(`  ${'set'.padEnd(34)} ${'n'.padStart(5)} ${SECOND_JUMP.holds.map((h) => `med ${h}`.padStart(8)).join('')} ${'avg 126'.padStart(8)} ${'up126'.padStart(6)} ${'+40% ex'.padStart(8)} ${'hit'.padStart(6)} ${'fell40'.padStart(6)} ${'dbl'.padStart(6)}`)
  report.secondJump = {}
  for (const [pname, inP] of [['test', (r) => r.t >= SPLIT], ['train', (r) => r.t < SPLIT]]) {
    console.log(`  — ${pname}`)
    const L = jumpStats(listedJ.filter(inP).map((r) => r.out)), A = jumpStats(otherJ.filter(inP).map((r) => r.out)), B = jumpStats(anyDay.filter(inP).map((r) => r.out))
    const hi = jumpStats(listedJ.filter(inP).filter((r) => r.siPct != null && r.siPct >= SECOND_JUMP.siHigh).map((r) => r.out))
    const lo = jumpStats(listedJ.filter(inP).filter((r) => r.siPct != null && r.siPct < SECOND_JUMP.siHigh).map((r) => r.out))
    const v = pname === 'test' ? secondJumpVerdict(L, A, B) : ''
    console.log(fmt('listed: second jump', L) + (v ? `  → ${v.toUpperCase()} (primary)` : ''))
    console.log(fmt('  short ≥ 15% of shares', hi)); console.log(fmt('  short < 15% of shares', lo))
    console.log(fmt('control A: jumps not listed', A)); console.log(fmt('control B: any day', B))
    report.secondJump[pname] = { listed: L, siHigh: hi, siLow: lo, unlisted: A, anyDay: B, verdict: v || undefined }
  }
  console.log('  by year (126-session median · fell 40% · n):')
  report.secondJump.byYear = {}
  for (const y of [...new Set(listedJ.concat(otherJ).map((r) => r.t.slice(0, 4)))].sort()) {
    const L = jumpStats(listedJ.filter((r) => r.t.startsWith(y)).map((r) => r.out)), A = jumpStats(otherJ.filter((r) => r.t.startsWith(y)).map((r) => r.out))
    report.secondJump.byYear[y] = { listed: L, unlisted: A }
    console.log(`  ${y}  listed ${pct(L.holds[H].median).padStart(7)} · ${pct(L.fell, 0).padStart(4)} · ${String(L.n).padStart(4)}    not listed ${pct(A.holds[H].median).padStart(7)} · ${pct(A.fell, 0).padStart(4)} · ${String(A.n).padStart(5)}`)
  }
  const best = [...listedJ].filter((r) => r.t >= SPLIT).sort((a, b) => b.out.ret[H] - a.out.ret[H])
  console.log('  listed second jumps, test — best 8 and worst 8 (126 sessions):')
  for (const r of best.slice(0, 8).concat(best.slice(-8))) console.log(`    ${r.tk.padEnd(6)} ${r.t}  jump ${pct(r.jump, 0).padStart(5)}  ${pct(r.out.ret[H], 0).padStart(6)}${r.siPct != null ? `  short ${pct(r.siPct, 0)}` : ''}`)
  report.secondJump.examples = best.slice(0, 20).concat(best.slice(-20)).map((r) => ({ tk: r.tk, t: r.t, jump: r.jump, siPct: r.siPct, ret126: r.out.ret[H] }))
  // The bear side (pre-registered 2026-10-27): long put, put spread, short shares on the same entries.
  {
    const barsOf = new Map(stocks.map((s) => [s.tk, s.bars]))
    const isTest = (r) => r.t >= SPLIT
    const variants = []
    for (const prem of JUMP_BEAR.premiums) for (const h of JUMP_BEAR.put.horizons) variants.push({ name: `long put ${h}d · prem ${prem}`, kind: 'put', primary: prem === JUMP_BEAR.premium && h === JUMP_BEAR.put.primary, fn: (b, e) => putTrade(b, e, { premium: prem, horizon: h }) })
    for (const prem of JUMP_BEAR.premiums) variants.push({ name: `put spread 63d · prem ${prem}`, kind: 'spread', primary: prem === JUMP_BEAR.premium, fn: (b, e) => spreadTrade(b, e, { premium: prem }) })
    for (const borrow of JUMP_BEAR.short.borrows) for (const stop of JUMP_BEAR.short.stops) variants.push({ name: `short · borrow ${borrow * 100}% · stop ${stop == null ? 'none' : `+${stop * 100}%`}`, kind: 'short', primary: borrow === JUMP_BEAR.short.primary.borrow && stop === JUMP_BEAR.short.primary.stop, fn: (b, e) => shortTrade(b, e, { borrow, stop }) })
    const line2 = (name, st, v = '') => `  ${name.padEnd(40)} ${String(st.n).padStart(5)} ${pct(st.avg).padStart(8)} ${pct(st.median).padStart(8)} ${pct(st.win, 0).padStart(5)} ${pct(st.lostHalf, 0).padStart(6)} ${pct(st.worst, 0).padStart(7)} ${pct(st.best, 0).padStart(7)}${st.stopped != null ? ` ${pct(st.stopped, 0).padStart(6)}` : ''}${st.skipped ? `  skipped ${st.skipped}` : ''}${v}`
    console.log('\n=== Bear side of the second jump — entered at the open after the jump (test, 2024 →)')
    console.log(`  ${'variant'.padEnd(40)} ${'n'.padStart(5)} ${'avg'.padStart(8)} ${'median'.padStart(8)} ${'win'.padStart(5)} ${'lost½'.padStart(6)} ${'worst'.padStart(7)} ${'best'.padStart(7)} ${'stop'.padStart(6)}`)
    report.secondJump.bear = {}
    for (const v of variants) {
      const L = listedJ.filter(isTest).map((r) => ({ t: r.t, trade: v.fn(barsOf.get(r.tk), r.e) }))
      const A = otherJ.filter(isTest).map((r) => ({ t: r.t, trade: v.fn(barsOf.get(r.tk), r.e) }))
      const Tr = listedJ.filter((r) => !isTest(r)).map((r) => ({ t: r.t, trade: v.fn(barsOf.get(r.tk), r.e) }))
      const vd = bearVerdict(L)
      const yrs = Object.entries(vd.years).map(([y, st]) => `${y} ${pct(st.avg, 0)} (${st.n})`).join(' · ')
      console.log(line2(v.name + (v.primary ? ' *' : ''), vd.all, v.primary ? `  → ${vd.verdict.toUpperCase()} (primary ${v.kind})${yrs ? `  ${yrs}` : ''}` : ''))
      const sa = bearStats(A.map((r) => r.trade)), st = bearStats(Tr.map((r) => r.trade))
      console.log(line2('    control A: jumps not listed', sa))
      console.log(line2('    train (< 2024) listed', st))
      report.secondJump.bear[v.name] = { kind: v.kind, primary: v.primary, ...vd, unlisted: sa, train: st }
    }
    console.log('  * = primary. Pass per instrument: avg > 0 and median > 0 after costs, ≥ 100 trades, avg > 0 in each of 2024, 2025, 2026.')
  }
  console.log(`  Pass (test): ≥ ${SECOND_JUMP_PASS.minN} listed jumps, 126-session median ≥ control A + ${SECOND_JUMP_PASS.medianGap * 100} pts, fell-40% rate ≤ control B.`)
}
// The bear side on list entry (pre-registered 2026-10-28): put / spread / short the day a stock lands on the list.
{
  const entries = [], control = []
  for (const s of stocks) {
    const okAt = (i) => { if (i < 252) return false; const rev = revenueAt(s.fin, s.bars[i].t); return (rev == null || rev < U.revenueMax) && adv(s.bars, i) >= U.advMin }
    const lst = listedFlags(s.bars, eventFlags(s.bars), shorts.get(s.tk) ?? [])
    for (const e of listEntries(lst)) if (okAt(e)) entries.push({ tk: s.tk, e, t: s.bars[e].t, bars: s.bars, px: s.bars[e].c, adv: adv(s.bars, e) })
    s.bars.forEach((b, i) => { if (monthStarts.has(b.t) && okAt(i)) control.push({ tk: s.tk, e: i, t: b.t, bars: s.bars }) })
  }
  const isTest = (r) => r.t >= SPLIT
  const H = SECOND_JUMP.horizon
  console.log(`\n=== Bear side on list entry — the day a stock lands on the list, entered at the next open (${entries.length} entries; test ${entries.filter(isTest).length})`)
  report.listBear = { stock: {} }
  for (const [pname, inP] of [['test', isTest], ['train', (r) => !isTest(r)]]) {
    const st = jumpStats(entries.filter(inP).map((r) => jumpOutcome(r.bars, r.e)).filter(Boolean))
    const cs = jumpStats(control.filter(inP).map((r) => jumpOutcome(r.bars, r.e)).filter(Boolean))
    report.listBear.stock[pname] = { entries: st, control: cs }
    console.log(`  stock after list entry (${pname}): n ${st.n} · median ${SECOND_JUMP.holds.map((h) => `${h}d ${pct(st.holds[h].median)}`).join(' / ')} · fell 40% ${pct(st.fell, 0)} · doubled ${pct(st.doubled, 0)}   control: 126d ${pct(cs.holds[H].median)} · fell ${pct(cs.fell, 0)} · dbl ${pct(cs.doubled, 0)}`)
  }
  const variants = []
  for (const prem of JUMP_BEAR.premiums) for (const h of JUMP_BEAR.put.horizons) variants.push({ name: `long put ${h}d · prem ${prem}`, kind: 'put', primary: prem === JUMP_BEAR.premium && h === JUMP_BEAR.put.primary, fn: (b, e, p) => putTrade(b, e, { premium: prem, horizon: h, p }) })
  for (const prem of JUMP_BEAR.premiums) variants.push({ name: `put spread 63d · prem ${prem}`, kind: 'spread', primary: prem === JUMP_BEAR.premium, fn: (b, e, p) => spreadTrade(b, e, { premium: prem, p }) })
  for (const borrow of JUMP_BEAR.short.borrows) for (const stop of JUMP_BEAR.short.stops) variants.push({ name: `short · borrow ${borrow * 100}% · stop ${stop == null ? 'none' : `+${stop * 100}%`}`, kind: 'short', primary: borrow === JUMP_BEAR.short.primary.borrow && stop === JUMP_BEAR.short.primary.stop, fn: (b, e, p) => shortTrade(b, e, { borrow, stop, p }) })
  const line2 = (name, st, v = '') => `  ${name.padEnd(40)} ${String(st.n).padStart(5)} ${pct(st.avg).padStart(8)} ${pct(st.median).padStart(8)} ${pct(st.win, 0).padStart(5)} ${pct(st.lostHalf, 0).padStart(6)} ${pct(st.worst, 0).padStart(7)} ${pct(st.best, 0).padStart(7)}${st.stopped != null ? ` ${pct(st.stopped, 0).padStart(6)}` : ''}${st.skipped ? `  skipped ${st.skipped}` : ''}${v}`
  console.log(`  ${'variant'.padEnd(40)} ${'n'.padStart(5)} ${'avg'.padStart(8)} ${'median'.padStart(8)} ${'win'.padStart(5)} ${'lost½'.padStart(6)} ${'worst'.padStart(7)} ${'best'.padStart(7)} ${'stop'.padStart(6)}`)
  report.listBear.variants = {}
  // Addendum 1: the graded primary is the options-tradeable subset (close ≥ $3, 20-day $ volume ≥ $10M).
  const TRADEABLE = { px: 3, adv: 10e6 }, tradeable = (r) => r.px >= TRADEABLE.px && r.adv >= TRADEABLE.adv
  console.log(`  options-tradeable subset (close ≥ $${TRADEABLE.px}, 20-day $ volume ≥ $${TRADEABLE.adv / 1e6}M): ${entries.filter(tradeable).length} entries, test ${entries.filter(isTest).filter(tradeable).length}; $5M tier test ${entries.filter(isTest).filter((r) => r.px >= 3 && r.adv >= 5e6).length}`)
  for (const [pname, inP] of [['test', isTest]]) {
    const st = jumpStats(entries.filter(inP).filter(tradeable).map((r) => jumpOutcome(r.bars, r.e)).filter(Boolean))
    report.listBear.stock.tradeable = st
    console.log(`  stock after list entry, tradeable (${pname}): n ${st.n} · median ${SECOND_JUMP.holds.map((h) => `${h}d ${pct(st.holds[h].median)}`).join(' / ')} · fell 40% ${pct(st.fell, 0)} · doubled ${pct(st.doubled, 0)}`)
  }
  const sets = [['TRADEABLE (graded)', tradeable], ['$5M tier', (r) => r.px >= 3 && r.adv >= 5e6], ['all list entries', () => true]]
  const slips = [JUMP_BEAR.slip, 0.05]
  for (const [setName, inSet] of sets) for (const slip of slips) {
  if (slip !== JUMP_BEAR.slip && setName !== 'TRADEABLE (graded)') continue
  console.log(`  — ${setName} · slippage ${slip * 100}% per fill`)
  const pp = { ...JUMP_BEAR, slip }
  const testRows = entries.filter(isTest).filter(inSet)
  for (const v0 of variants) {
    const v = { ...v0, primary: v0.primary && setName === 'TRADEABLE (graded)', fn: (b, e) => v0.fn(b, e, pp) }
    const L = testRows.map((r) => ({ t: r.t, tk: r.tk, trade: v.fn(r.bars, r.e) }))
    const C = control.filter(isTest).map((r) => ({ t: r.t, trade: v.fn(r.bars, r.e) }))
    const Tr = entries.filter((r) => !isTest(r)).map((r) => ({ t: r.t, trade: v.fn(r.bars, r.e) }))
    const vd = bearVerdict(L), cs = bearStats(C.map((r) => r.trade)), st = bearStats(Tr.map((r) => r.trade))
    const verdict = vd.verdict === 'pass' && !(vd.all.avg > cs.avg) ? 'fail' : vd.verdict
    const yrs = Object.entries(vd.years).map(([y, x]) => `${y} ${pct(x.avg, 0)} (${x.n})`).join(' · ')
    console.log(line2(v.name + (v.primary ? ' *' : ''), vd.all, v.primary ? `  → ${verdict.toUpperCase()} (primary ${v.kind})${yrs ? `  ${yrs}` : ''}` : ''))
    console.log(line2('    control: any day', cs))
    console.log(line2('    train (< 2024)', st))
    const ranked = L.filter((r) => r.trade && Number.isFinite(r.trade.ret)).sort((a, b) => b.trade.ret - a.trade.ret)
    report.listBear.variants[`${setName}|${slip}|${v.name}`] = { kind: v.kind, primary: v.primary, verdict, ...vd, control: cs, train: st, best: ranked.slice(0, 8).map((r) => [r.tk, r.t, r.trade.ret]), worst: ranked.slice(-8).map((r) => [r.tk, r.t, r.trade.ret]) }
    if (v.primary) { console.log(`    best: ${ranked.slice(0, 6).map((r) => `${r.tk} ${r.t} ${pct(r.trade.ret, 0)}`).join(' · ')}`); console.log(`    worst: ${ranked.slice(-6).map((r) => `${r.tk} ${r.t} ${pct(r.trade.ret, 0)}`).join(' · ')}`) }
  }
  }
  console.log('  * = primary. Pass per instrument: avg > 0 and median > 0 after costs, ≥ 100 trades, avg > 0 in 2024, 2025, 2026 each, avg above the any-day control; graded on the tradeable subset at 2% slippage, 5% shown beside it.')
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

// Delisted names from SEC filings (list-entry bear addendum 1, descriptive).
{
  const goneCiks = [...floats.keys()].filter((c) => !byCik.has(c))
  console.log(`\n=== Delisted float-range filers (no listed ticker today): ${goneCiks.length} — SEC exit filings since 2019`)
  const { fin: goneFin } = await compactFactsFor(goneCiks.map((cik) => ({ cik, ticker: `CIK${cik}` })), { log: () => {} })
  const exits = []
  await mapLimit(goneCiks, 2, async (cik) => {
    const got = await exitFilingsFor(cik)
    if (!got) return
    const last = floats.get(cik).last
    const f = goneFin.get(`CIK${cik}`), rev = f ? revenueAt(f, `${last}-12-31`) : undefined
    exits.push({ cik, name: got.name, preRev: f ? (rev == null || rev < U.revenueMax) : null, ...exitOf(got.rows, last) })
  }, 300)
  const yrs = (d) => (d == null ? '—' : `${Math.round(d)}d (${(d / 365.25).toFixed(1)}y)`)
  report.delisted = {}
  for (const [name, set] of [['all', exits], ['pre-revenue', exits.filter((e) => e.preRev)]]) {
    const st = exitStats(set)
    report.delisted[name] = st
    console.log(`  ${name}: ${st.n} with filings · ${Object.entries(st.by).map(([k, n]) => `${k} ${n}`).join(' · ')}`)
    console.log(`    exchange notice (8-K 3.01) → delisting: n ${st.noticeToDelist.n} · median ${yrs(st.noticeToDelist.median)} · middle half ${yrs(st.noticeToDelist.p25)}–${yrs(st.noticeToDelist.p75)} · avg ${yrs(st.noticeToDelist.avg)}`)
    console.log(`    mid-year float filing → delisting: n ${st.floatToDelist.n} · median ${yrs(st.floatToDelist.median)} · middle half ${yrs(st.floatToDelist.p25)}–${yrs(st.floatToDelist.p75)} · avg ${yrs(st.floatToDelist.avg)}`)
    for (const reason of ['bankruptcy', 'acquired', 'delisted, other']) { const sub = exitStats(set.filter((e) => e.reason === reason)); console.log(`    ${reason.padEnd(16)} n ${String(sub.n).padStart(4)} · float → delisting median ${yrs(sub.floatToDelist.median)} · notice → delisting median ${yrs(sub.noticeToDelist.median)} (n ${sub.noticeToDelist.n})`) }
  }
  console.log('  examples (pre-revenue, bankruptcy or delisted-other, latest first): ' + exits.filter((e) => e.preRev && (e.reason === 'bankruptcy' || e.reason === 'delisted, other')).sort((a, b) => b.delisted.localeCompare(a.delisted)).slice(0, 12).map((e) => `${e.name} ${e.delisted}`).join(' · '))
}
writeFileSync('fade-test.json', JSON.stringify(report, null, 1))
console.log('Wrote fade-test.json')
