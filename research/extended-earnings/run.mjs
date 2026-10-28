// Extended into earnings (PREREG.md): events from SEC 8-K Item 2.02, bars from
// Yahoo / the edge function, graded Extended vs Not extended, NOW compared.
// Runs on GitHub's runners (the dev sandbox can't reach SEC or Yahoo).
import { writeFileSync } from 'node:fs'
import { secJson, cikMap } from '../../scripts/lib/sec.mjs'
import { dailyBars, mapLimit, sources } from '../../scripts/lib/marketData.mjs'
import { CHART_TICKERS } from '../../src/lib/chartTickers.js'
import { edgarTiming } from '../preearnings-runup/lib.mjs'
import { RULES, featureSeries, lastCloseIndex, outcome, vsNormal, groupStats, verdict } from './lib.mjs'

const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
const share = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
let tickers = [...new Set(CHART_TICKERS.map((t) => (typeof t === 'string' ? t : t.ticker ?? t.symbol)).filter(Boolean))].filter((t) => /^[A-Z][A-Z0-9.]{0,5}$/.test(t))
if (process.env.TICKERS) tickers = process.env.TICKERS.split(',').map((s) => s.trim().toUpperCase())
if (!tickers.includes('NOW')) tickers.push('NOW')
console.log(`Universe: ${tickers.length} chart tickers (survivors)`)

const ciks = await cikMap()
async function reports(cik) {
  const rows = []
  const take = (b) => { for (let k = 0; k < (b?.form?.length ?? 0); k++) if (b.form[k] === '8-K' && String(b.items?.[k] ?? '').split(',').map((s) => s.trim()).includes('2.02')) rows.push(b.acceptanceDateTime[k]) }
  const j = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`)
  if (!j) return null
  take(j.filings?.recent)
  for (const f of j.filings?.files ?? []) { if (f.filingTo && f.filingTo < RULES.since) continue; take(await secJson(`https://data.sec.gov/submissions/${f.name}`)) }
  return rows.sort()
}

const spyBars = await dailyBars('SPY', { range: '10y' })
const spy = new Map(spyBars.map((b) => [b.t, b.c]))
const events = [], counts = { noCik: 0, noFilings: 0, noBars: 0, duringMarket: 0, duplicate: 0, noL: 0, warmup: 0, open: 0, used: 0 }
await mapLimit(tickers, 3, async (tk) => {
  const cik = ciks.get(tk)
  if (!cik) { counts.noCik++; return }
  const acc = await reports(cik)
  if (!acc) { counts.noFilings++; return }
  let bars
  try { bars = (await dailyBars(tk, { range: '10y' })).filter((b) => b.c > 0) } catch { counts.noBars++; return }
  if (bars.length < RULES.minBars + 10) { counts.noBars++; return }
  const f = featureSeries(bars)
  const prev = []
  let last = null
  for (const a of acc) {
    const e = edgarTiming(a)
    if (!e || e.date < '2015-01-01') continue
    if (e.timing === 'DMH') { counts.duringMarket++; continue }
    if (last && (Date.parse(e.date) - Date.parse(last)) / 86400e3 < RULES.gapDays) { counts.duplicate++; continue }
    last = e.date
    const L = lastCloseIndex(bars, e.date, e.timing)
    if (L < 0) { counts.noL++; continue }
    const out = outcome(bars, L, f, spy)
    const at = f.at(L)
    const row = { tk, date: e.date, timing: e.timing, t: bars[L].t, ...at, out, vsNormal: out ? vsNormal(prev, out.day1) : null }
    if (out) prev.push(out.day1)
    if (tk === 'NOW') events.push({ ...row, now: true })
    if (!out) { counts.open++; continue }
    if (L < RULES.minBars || bars[L].t < RULES.since || at.above200 == null) { counts.warmup++; continue }
    counts.used++
    events.push(row)
  }
}, 200)
console.log(`Events: ${JSON.stringify(counts)} · bars ${JSON.stringify(sources)}`)

const graded = events.filter((r) => !r.now)
const ext = graded.filter((r) => r.extended), not = graded.filter((r) => !r.extended)
const line = (name, g) => `  ${name.padEnd(34)} ${String(g.n).padStart(6)} ${pct(g.day1xMedian).padStart(8)} ${pct(g.day1xMean).padStart(8)} ${share(g.down).padStart(6)} ${pct(g.day5xMedian).padStart(8)} ${share(g.reach50).padStart(7)} ${share(g.reach20).padStart(7)} ${share(g.fell5).padStart(6)} ${(g.vsNormal ?? 0).toFixed(2).padStart(6)} ${share(g.bigMove).padStart(6)}`
const head = `  ${'group'.padEnd(34)} ${'n'.padStart(6)} ${'med 1d*'.padStart(8)} ${'avg 1d*'.padStart(8)} ${'down'.padStart(6)} ${'med 5d*'.padStart(8)} ${'to 50d'.padStart(7)} ${'to 20d'.padStart(7)} ${'≤−5%'.padStart(6)} ${'×norm'.padStart(6)} ${'≥1.5×'.padStart(6)}`

// NOW: its values at its latest report, and its history.
const nowRows = events.filter((r) => r.now).sort((a, b) => a.t.localeCompare(b.t))
const nowLast = nowRows.at(-1)
console.log('\n=== NOW at its latest report (the comparison point)')
if (nowLast) console.log(`  report ${nowLast.date} ${nowLast.timing} · last close ${nowLast.t}: RSI ${nowLast.rsi?.toFixed(0)} · ${pct(nowLast.above20)} vs 20-day · ${pct(nowLast.above50)} vs 50-day · ${pct(nowLast.above200)} vs 200-day · app's Extended flag: ${nowLast.extended ? 'YES' : 'no'}${nowLast.out ? ` · next day ${pct(nowLast.out.day1)} (SPY-adj ${pct(nowLast.out.day1x)}) · reached 50-day ${nowLast.out.reach50 ? 'yes' : 'no'} · 20-day ${nowLast.out.reach20 ? 'yes' : 'no'}` : ' · outcome not complete yet (needs 5 sessions)'}`)
else console.log('  NOW: no report found')

console.log('\n=== Extended into earnings vs not (* = minus SPY; ×norm = move ÷ the stock\'s usual report move)')
console.log(head)
const v = verdict(ext, not)
console.log(line('Extended (app flag) — graded', v.E))
console.log(line('Not extended', v.N))
const matched = nowLast ? graded.filter((r) => r.above50 != null && r.above50 >= nowLast.above50 && r.above200 >= nowLast.above200) : []
console.log(line(`As extended as NOW (≥ ${pct(nowLast?.above50, 0)} / ${pct(nowLast?.above200, 0)}) — descriptive`, groupStats(matched)))
for (const [name, fn] of [['RSI ≥ 70', (r) => r.rsi >= 70], ['≥ 10% above 50-day', (r) => r.above50 >= 0.10], ['≥ 20% above 50-day', (r) => r.above50 >= 0.20], ['≥ 30% above 200-day', (r) => r.above200 >= 0.30], ['≥ 50% above 200-day', (r) => r.above200 >= 0.50], ['below the 50-day', (r) => r.above50 < 0]]) console.log(line(`  ${name}`, groupStats(graded.filter(fn))))
console.log('\n  by year (median next-day SPY-adjusted, extended vs not, n):')
for (const [y, s] of Object.entries(v.years ?? {})) console.log(`    ${y}  ${pct(s.ext).padStart(7)} vs ${pct(s.not).padStart(7)}   (${s.e} / ${s.n})${s.ext != null && s.not != null && s.ext < s.not ? '  ✓' : ''}`)
if (v.boot) console.log(`  mean difference (extended − not), clustered by week: ${pct(v.boot.diff, 2)} [${pct(v.boot.lo, 2)}, ${pct(v.boot.hi, 2)}]`)
if (v.checks) console.log(`  checks: ${Object.entries(v.checks).map(([k, b]) => `${k} ${b ? 'ok' : 'MISS'}`).join(' · ')} (years won ${v.won}/10)`)
console.log(`  → ${v.verdict.toUpperCase()}. Pass: ≥ ${RULES.pass.minN} extended; median ≥ 1.5 pts lower; down ≥ 8 pts more often; reached the 50-day ≥ 1.5×; interval below 0; ≥ 7 of 10 years.`)

console.log('\n=== NOW, every report')
for (const r of nowRows) console.log(`  ${r.date} ${r.timing}  RSI ${String(r.rsi?.toFixed(0) ?? '—').padStart(3)} · 50d ${pct(r.above50, 0).padStart(5)} · 200d ${pct(r.above200, 0).padStart(5)} · ${r.extended ? 'EXT' : '   '} → ${r.out ? `${pct(r.out.day1).padStart(7)} next day · ${pct(r.out.day5).padStart(7)} 5d · to 50-day ${r.out.reach50 ? 'yes' : 'no '}` : 'open'}`)
const nowG = groupStats(nowRows.filter((r) => r.out && r.extended)), nowN = groupStats(nowRows.filter((r) => r.out && !r.extended))
console.log(`  NOW extended: n ${nowG.n} · median next day ${pct(nowG.day1Median)} · down ${share(nowG.down)}   not extended: n ${nowN.n} · ${pct(nowN.day1Median)} · down ${share(nowN.down)}`)

const ranked = [...matched].sort((a, b) => a.out.day1x - b.out.day1x)
console.log(`\n  as extended as NOW — worst 10 / best 10 next days: ${ranked.slice(0, 10).map((r) => `${r.tk} ${r.date} ${pct(r.out.day1, 0)}`).join(' · ')}  |  ${ranked.slice(-10).map((r) => `${r.tk} ${r.date} ${pct(r.out.day1, 0)}`).join(' · ')}`)
writeFileSync('results.json', JSON.stringify({ rules: RULES.version, at: new Date().toISOString(), counts, now: nowLast, verdict: v, matched: groupStats(matched), nowRows }, null, 1))
console.log('wrote results.json')
