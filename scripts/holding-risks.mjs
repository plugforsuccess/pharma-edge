// Nightly risk facts for every ticker a user holds or has starred (owner,
// 2026-10-26): the latest heavy-volume jump and whether it held, short
// interest vs the settlement ~30 days earlier and the price over that span,
// and cash runway from the latest 10-Q / 10-K. Facts, never a verdict —
// src/utils/holdingRisks.js builds the row and the card copy. Writes one
// ticker_risks row per ticker (service role). DRY_RUN=true reports only.
//
// Data: bars from Yahoo / the price-history edge function, FINRA short
// interest (scripts/lib/finra.mjs), SEC companyfacts (scripts/lib/sec.mjs).
import { createClient } from '@supabase/supabase-js'
import { riskRow, holdingRiskFacts, cashLine } from '../src/utils/holdingRisks.js'
import { sharesOutAt } from '../src/utils/fade.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { shortInterest, finraStatus } from './lib/finra.mjs'
import { cikMap, secStatus } from './lib/sec.mjs'
import { compactFactsFor } from './lib/secUniverse.mjs'
import { isFund } from '../src/utils/quality.js'
import { callChecklist } from '../src/utils/milestones.js'

const DRY = /^(1|true)$/i.test(process.env.DRY_RUN ?? '')
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })
const TICKER = /^[A-Z][A-Z0-9.-]{0,5}$/

// 1. Tickers: open share / option holdings + every starred ticker.
const [{ data: pos, error: e1 }, { data: wl, error: e2 }, { data: pub }] = await Promise.all([
  db.from('leaps_positions').select('ticker').is('closed_at', null).in('instrument_type', ['stock', 'equity_option', 'index_option_1256']),
  db.from('watchlist').select('ticker'),
  db.from('holding_milestones').select('ticker').eq('published', true),
])
if (e1 || e2) { console.error('load failed', e1?.message ?? e2?.message); process.exit(1) }
// Funds (SPY, sector ETFs, USO …) are skipped: short interest on an ETF is
// creation / redemption noise and there is no cash runway to read.
const tickers = [...new Set([...(pos ?? []), ...(wl ?? []), ...(pub ?? [])].map((r) => String(r.ticker ?? '').trim().toUpperCase()).filter((t) => TICKER.test(t) && !isFund(t)))].sort()
if (process.env.TICKERS) tickers.splice(0, tickers.length, ...process.env.TICKERS.split(',').map((s) => s.trim().toUpperCase()))
console.log(`${tickers.length} tickers (${(pos ?? []).length} holding rows, ${(wl ?? []).length} starred, ${(pub ?? []).length} published ledger rows)${DRY ? ' · DRY RUN' : ''}`)
if (!tickers.length) process.exit(0)

// 2. Bars, FINRA, SEC.
const bars = new Map()
await mapLimit(tickers, 4, async (tk) => { try { const b = await dailyBars(tk, { range: '1y' }); if (b?.length >= 80) bars.set(tk, b) } catch (e) { console.log(`  ${tk}: ${e.message}`) } })
console.log(`bars: ${bars.size} of ${tickers.length} (Yahoo ${sources.yahoo} / edge ${sources.edge})`)
const shorts = new Map()
await mapLimit([...bars.keys()], 3, async (tk) => { const s = await shortInterest(tk); if (s?.length) shorts.set(tk, s) }, 150)
console.log(`FINRA: ${shorts.size} symbols · non-200 ${JSON.stringify(finraStatus)}`)
const ciks = await cikMap()
const entries = [...bars.keys()].map((tk) => ({ ticker: tk, cik: ciks.get(tk) })).filter((e) => e.cik)
const { fin, failed: finFailed } = await compactFactsFor(entries)
console.log(`SEC facts: ${fin.size} of ${entries.length} with a CIK · failed ${finFailed} · status ${JSON.stringify(secStatus)}`)

// 3. Rows.
const rows = []
for (const [tk, b] of bars) {
  const f = fin.get(tk) ?? null
  const asOf = b[b.length - 1].t
  const row = riskRow({ bars: b, shorts: shorts.get(tk) ?? [], fin: f, sharesOut: f ? sharesOutAt(f, asOf) : null, asOf })
  rows.push({ ticker: tk, ...row })
  const facts = holdingRiskFacts(row)
  const jvTag = f?.jv?.length ? [...new Set(f.jv.map((x) => x.tag))].join(',') : f?.jvGeneric?.length ? 'PaymentsToAcquireInvestments (equity-method filer)' : null
  console.log(`  ${tk.padEnd(6)} ${cashLine(row) ?? 'no cash / burn'}${jvTag ? ` · JV tag ${jvTag}` : ''}${facts.length ? ` · ${facts.map((x) => x.text).join(' · ')}` : ''}`)
}
console.log(`${rows.length} rows · ${rows.filter((r) => holdingRiskFacts(r).length).length} with at least one fact`)

// 4. Earnings-call alerts for ledgers (owner spec v2): the day before a call,
// which rows it must confirm; the day after, which are still unconfirmed.
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10)
const today = new Date().toISOString().slice(0, 10)
const alertsOut = []
{
  const { data: ms } = await db.from('holding_milestones').select('user_id, ticker, title, due_date, current_due, slips, status')
  const byKey = new Map()
  for (const m of ms ?? []) { const k = `${m.user_id}|${m.ticker}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(m) }
  if (byKey.size) {
    const { data: ec } = await db.from('earnings_calendar').select('ticker, earnings_date').in('ticker', [...new Set([...byKey.values()].flat().map((m) => m.ticker))]).gte('earnings_date', shift(today, -2)).lte('earnings_date', shift(today, 2))
    for (const [k, list] of byKey) {
      const [user_id, ticker] = k.split('|')
      const e = (ec ?? []).find((x) => x.ticker === ticker)
      if (!e) continue
      const rows = callChecklist(list, today)
      if (!rows.length) continue
      const names = rows.map((r) => r.title).join('; ')
      if (e.earnings_date === shift(today, 1)) alertsOut.push({ user_id, alert_type: 'milestone_call_tomorrow', ticker, event_date: e.earnings_date, sent_via: 'in_app', message: `${ticker} reports tomorrow. Promises the call should confirm: ${names}.` })
      else if (e.earnings_date === shift(today, -1)) alertsOut.push({ user_id, alert_type: 'milestone_call_check', ticker, event_date: e.earnings_date, sent_via: 'in_app', message: `${ticker} reported yesterday. Still unconfirmed on your ledger: ${names}. Mark each met, moved, missed or not mentioned.` })
    }
  }
  console.log(`call alerts: ${alertsOut.length}`)
  for (const a of alertsOut) console.log(`  ${a.alert_type} ${a.ticker}: ${a.message}`)
}

// 5. Write.
if (DRY) { console.log('dry run — nothing written'); process.exit(0) }
for (const a of alertsOut) {
  const { error } = await db.from('alerts').upsert(a, { onConflict: 'user_id,alert_type,ticker,event_date', ignoreDuplicates: true })
  if (error) console.warn('alert insert failed', error.message)
}
for (let k = 0; k < rows.length; k += 200) {
  const { error } = await db.from('ticker_risks').upsert(rows.slice(k, k + 200).map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: 'ticker' })
  if (error) { console.error('upsert failed', error.message); process.exit(1) }
}
console.log(`wrote ${rows.length} ticker_risks rows`)
