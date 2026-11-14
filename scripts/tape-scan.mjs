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
import { revenueAt, sharesOutAt, quarterlyOcfAt } from '../src/utils/fade.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { shortInterest, finraStatus } from './lib/finra.mjs'
import { publicFloatCiks, tickersFor, compactFactsFor } from './lib/secUniverse.mjs'
import { secStatus } from './lib/sec.mjs'
import { isFund } from '../src/utils/quality.js'
import { filingsFor } from './lib/secFilings.mjs'
import { reportOnJump, nextReport, isFresh, recordPath } from '../src/utils/jumpRecord.js'

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
// Pre-revenue = annual revenue under $25M or no revenue tag — and not generating
// operating cash: banks and lenders file no plain revenue tag (LDI slipped in
// on the first dry run, generating $520M a quarter), so a company whose latest
// quarter's operating cash flow is above +$2.5M is out whatever its tags say.
const OCF_MAX = 2.5e6
const preRev = entries.filter((e) => {
  const f = fin.get(e.ticker); if (!f) return false
  const r = revenueAt(f, today); if (!(r == null || r < U.revenueMax)) return false
  const q = quarterlyOcfAt(f, today); return !(q != null && q > OCF_MAX)
})
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

// 4. The jump record: log each fresh jump once (with whether it came on an
// earnings report, SEC 8-K item 2.02, and the next report date), then fill the
// path from the jump close for every record still inside 6 months.
const cikOf = new Map(entries.map((e) => [e.ticker, e.cik]))
const since = new Date(Date.now() - 200 * 86400e3).toISOString().slice(0, 10)
const { data: openRecs, error: recErr } = await db.from('jump_record').select('ticker, jump_date, next_report, next_report_est').gte('jump_date', since)
if (recErr) console.warn('jump_record read failed', recErr.message)
const have = new Set((openRecs ?? []).map((r) => `${r.ticker}|${r.jump_date}`))
const fresh = rows.filter((r) => isFresh(r.catalyst, r.as_of) && !have.has(`${r.ticker}|${r.catalyst.event}`))
const calTickers = [...new Set([...fresh.map((r) => r.ticker), ...(openRecs ?? []).map((r) => r.ticker)])]
const cal = new Map()
for (let k = 0; k < calTickers.length; k += 200) {
  const { data } = await db.from('earnings_calendar').select('ticker, earnings_date').in('ticker', calTickers.slice(k, k + 200))
  for (const x of data ?? []) { if (!cal.has(x.ticker)) cal.set(x.ticker, []); cal.get(x.ticker).push(x.earnings_date) }
}
const inserts = []
for (const r of fresh) {
  const c = r.catalyst, b = bars.get(r.ticker)
  const fl = cikOf.get(r.ticker) ? (await filingsFor(cikOf.get(r.ticker), { since: '2025-01-01' }).catch(() => null))?.rows ?? [] : []
  const rep = reportOnJump(fl, c.event), nx = nextReport(cal.get(r.ticker), fl, c.event), rp = recordPath(b, c.event)
  inserts.push({ ticker: r.ticker, jump_date: c.event, jump_close: c.level, jump_pct: +c.jump.toFixed(4), logged_on: today, earnings_jump: !!rep, report_date: rep, next_report: nx.date, next_report_est: nx.est, si_pct: r.shorts?.siPct ?? null, cash: r.runway?.cash ?? null, burn: r.runway?.burn ?? null, path: rp?.path ?? {}, last_close: rp?.last ?? null })
}
console.log(`jump record: ${inserts.length} new fresh jumps · ${openRecs?.length ?? 0} open records`)
for (const x of inserts) console.log(`  ${x.ticker.padEnd(6)} ${x.jump_date} +${(x.jump_pct * 100).toFixed(0)}% · ${x.earnings_jump ? `on earnings (8-K ${x.report_date})` : 'not on earnings'} · next report ${x.next_report ?? 'unknown'}${x.next_report_est ? ' (est.)' : ''}`)
const updates = []
for (const o of openRecs ?? []) {
  let b = bars.get(o.ticker)
  if (!b) { try { b = await dailyBars(o.ticker, { range: '1y' }) } catch { b = null } }
  const rp = b ? recordPath(b, o.jump_date) : null
  if (!rp) continue
  const nx = o.next_report && !o.next_report_est ? { date: o.next_report, est: false } : (() => { const c = nextReport(cal.get(o.ticker), [], o.jump_date); return c.date ? c : { date: o.next_report, est: o.next_report_est } })()
  updates.push({ key: o, set: { path: rp.path, last_close: rp.last, next_report: nx.date, next_report_est: nx.est, updated_at: new Date().toISOString() } })
}

// 5. Write.
if (DRY) { console.log(`dry run — nothing written (would update ${updates.length} jump records)`); process.exit(0) }
if (inserts.length) {
  const { error } = await db.from('jump_record').upsert(inserts, { onConflict: 'ticker,jump_date', ignoreDuplicates: true })
  if (error) console.warn('jump_record insert failed', error.message)
}
for (const u of updates) {
  const { error } = await db.from('jump_record').update(u.set).eq('ticker', u.key.ticker).eq('jump_date', u.key.jump_date)
  if (error) console.warn('jump_record update failed', u.key.ticker, error.message)
}
console.log(`jump record: wrote ${inserts.length} · updated ${updates.length}`)
for (let k = 0; k < rows.length; k += 200) {
  const { error } = await db.from('ticker_risks').upsert(rows.slice(k, k + 200), { onConflict: 'ticker' })
  if (error) { console.error('upsert failed', error.message); process.exit(1) }
}
// Names that left the universe keep their last row but drop out of the scan list.
const keep = rows.map((r) => r.ticker)
const { error: e2 } = await db.from('ticker_risks').update({ scan: false }).eq('scan', true).not('ticker', 'in', `(${keep.join(',')})`)
if (e2) console.warn('scan flag cleanup failed', e2.message)
console.log(`wrote ${rows.length} ticker_risks rows (scan)`)
