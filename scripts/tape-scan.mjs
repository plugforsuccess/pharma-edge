// The tape scan (owner, 2026-10-26: "Build"). Every pre-revenue small cap
// (the Fade test's SEC-built universe: public float $100M–$2B in a
// mid-year frame 2022–2025, annual revenue known today < $25M or none,
// listed) gets the same two facts the holding card shows — the latest
// heavy-volume jump and whether it held, short interest vs ~30 days
// earlier with the price over that span — plus cash, burn and JV spend as
// plain numbers → ticker_risks (scan = true). No score, no tier; the list
// page (/charts/tape) shows the names with both facts lit. DRY_RUN=true
// reports only. Data: SEC companyfacts, Yahoo / the price-history edge
// function, FINRA short interest.
import { createClient } from '@supabase/supabase-js'
import { riskRow, holdingRiskFacts, cashLine } from '../src/utils/holdingRisks.js'
import { revenueAt, sharesOutAt } from '../src/utils/fade.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { shortInterest, finraStatus } from './lib/finra.mjs'
import { publicFloatCiks, tickersFor, compactFactsFor } from './lib/secUniverse.mjs'
import { secStatus } from './lib/sec.mjs'
import { isFund } from '../src/utils/quality.js'

const DRY = /^(1|true)$/i.test(process.env.DRY_RUN ?? '')
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })
const U = { floatMin: 100e6, floatMax: 2e9, revenueMax: 25e6, advMin: 1e6, years: [2022, 2023, 2024, 2025] }
const today = new Date().toISOString().slice(0, 10)

// 1. Universe from SEC.
const floats = await publicFloatCiks({ years: U.years, min: U.floatMin, max: U.floatMax })
const byCik = await tickersFor(new Set(floats.keys()))
let entries = [...byCik].map(([cik, ticker]) => ({ cik, ticker })).filter((e) => !isFund(e.ticker))
if (process.env.TICKERS) { const want = new Set(process.env.TICKERS.split(',').map((s) => s.trim().toUpperCase())); entries = entries.filter((e) => want.has(e.ticker)) }
console.log(`${floats.size} filers in range · ${entries.length} with a listed ticker${DRY ? ' · DRY RUN' : ''}`)
const { fin, failed: finFailed } = await compactFactsFor(entries)
const preRev = entries.filter((e) => { const f = fin.get(e.ticker); if (!f) return false; const r = revenueAt(f, today); return r == null || r < U.revenueMax })
console.log(`SEC facts: ${fin.size} · failed ${finFailed} · status ${JSON.stringify(secStatus)} · pre-revenue today: ${preRev.length}`)

// 2. Bars (liquid names only) and FINRA.
const bars = new Map()
let done = 0, failed = 0
await mapLimit(preRev, Number(process.env.CONCURRENCY) || 6, async ({ ticker }) => {
  try {
    const b = await dailyBars(ticker, { range: '1y' })
    if (b && b.length >= 80) {
      const i = b.length - 1
      let s = 0; for (let k = i - 19; k <= i; k++) s += (b[k].v ?? 0) * b[k].c
      if (s / 20 >= U.advMin) bars.set(ticker, b)
    }
  } catch { failed++ }
  if (++done % 100 === 0) console.log(`  bars ${done}/${preRev.length} · ${failed} failed`)
})
console.log(`${bars.size} liquid pre-revenue tickers with bars · ${failed} failed · Yahoo ${sources.yahoo} / edge ${sources.edge}`)
const shorts = new Map()
await mapLimit([...bars.keys()], 3, async (tk) => { const s = await shortInterest(tk); if (s?.length) shorts.set(tk, s) }, 150)
console.log(`FINRA: ${shorts.size} symbols · non-200 ${JSON.stringify(finraStatus)}`)

// 3. Rows.
const rows = []
for (const [tk, b] of bars) {
  const f = fin.get(tk) ?? null
  const asOf = b[b.length - 1].t
  const row = riskRow({ bars: b, shorts: shorts.get(tk) ?? [], fin: f, sharesOut: f ? sharesOutAt(f, asOf) : null, asOf })
  rows.push({ ticker: tk, ...row, spark: b.slice(-63).map((x) => +x.c.toFixed(4)), scan: true, updated_at: new Date().toISOString() })
}
const lit = rows.map((r) => ({ r, n: holdingRiskFacts(r).length })).filter((x) => x.n === 2)
const one = rows.filter((r) => holdingRiskFacts(r).length === 1).length
console.log(`${rows.length} rows · both facts lit ${lit.length} · one fact ${one}`)
for (const { r } of lit.sort((a, b) => (b.r.catalyst?.sessionsBelow ?? 0) - (a.r.catalyst?.sessionsBelow ?? 0)).slice(0, 25)) {
  console.log(`  ${r.ticker.padEnd(6)} ${holdingRiskFacts(r).map((x) => x.text).join(' · ')} · ${cashLine(r) ?? 'no cash line'}`)
}

// 4. Write.
if (DRY) { console.log('dry run — nothing written'); process.exit(0) }
for (let k = 0; k < rows.length; k += 200) {
  const { error } = await db.from('ticker_risks').upsert(rows.slice(k, k + 200), { onConflict: 'ticker' })
  if (error) { console.error('upsert failed', error.message); process.exit(1) }
}
// Names that left the universe keep their last row but drop out of the scan list.
const keep = rows.map((r) => r.ticker)
const { error: e2 } = await db.from('ticker_risks').update({ scan: false }).eq('scan', true).not('ticker', 'in', `(${keep.join(',')})`)
if (e2) console.warn('scan flag cleanup failed', e2.message)
console.log(`wrote ${rows.length} ticker_risks rows (scan)`)
