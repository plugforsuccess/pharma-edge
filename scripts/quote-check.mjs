// The real-quote check (owner, 2026-11-16). Every night after the tape scan:
// for each stock on the Stopped believing scan (ticker_risks.scan), price the
// short-window test's bear call spread with the formula and with real quotes
// (option-chain edge function → Yahoo; GitHub runners get 429 from Yahoo's
// option chains directly) → quote_checks. Prints the night's reading: real
// credit vs the formula's. DRY_RUN=true prints only.
import { createClient } from '@supabase/supabase-js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { spreadQuote, quoteSummary, QUOTE_CHECK } from '../src/utils/quoteCheck.js'

const DRY = /^(1|true)$/i.test(process.env.DRY_RUN ?? '')
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

const { data: scan, error } = await db.from('ticker_risks').select('ticker, catalyst').eq('scan', true).limit(2000)
if (error) { console.error('ticker_risks read failed', error.message); process.exit(1) }
let tickers = scan.map((r) => r.ticker)
if (process.env.TICKERS) { const want = new Set(process.env.TICKERS.split(',').map((s) => s.trim().toUpperCase())); tickers = tickers.filter((t) => want.has(t)) }
const catOf = new Map(scan.map((r) => [r.ticker, r.catalyst]))
const { data: recs } = await db.from('jump_record').select('ticker, jump_date, earnings_jump').in('ticker', tickers.slice(0, 1000))
const ernOf = new Map((recs ?? []).map((r) => [`${r.ticker}|${r.jump_date}`, r.earnings_jump]))
console.log(`${tickers.length} scanned stocks${DRY ? ' · DRY RUN' : ''}`)

// Real chains, 30 tickers a call.
const chains = new Map(), failed = []
for (let k = 0; k < tickers.length; k += 30) {
  const batch = tickers.slice(k, k + 30)
  try {
    const resp = await fetch(`${url}/functions/v1/option-chain`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers: batch, days: QUOTE_CHECK.days }), signal: AbortSignal.timeout(120000) })
    const body = await resp.json().catch(() => null)
    if (!resp.ok || !body?.success) { failed.push(`batch ${k / 30}: ${resp.status} ${body?.error ?? ''}`); continue }
    for (const c of body.chains) chains.set(c.ticker, c)
    failed.push(...body.failed)
  } catch (e) { failed.push(`batch ${k / 30}: ${e.message}`) }
}
console.log(`chains: ${chains.size} · failed ${failed.length}${failed.length ? ` (${failed.slice(0, 5).join(' | ')})` : ''}`)
if (tickers.length >= 20 && chains.size < tickers.length * 0.2) { console.error('Too few chains — the option source is failing; nothing written.'); process.exit(1) }

// Bars for the formula's vol.
const rows = []
await mapLimit([...chains.keys()], 6, async (tk) => {
  let bars = null
  try { bars = await dailyBars(tk, { range: '1y' }) } catch { /* no bars */ }
  const asOf = bars?.at(-1)?.t ?? new Date().toISOString().slice(0, 10)
  const q = bars && bars.length > 70 ? spreadQuote(bars, chains.get(tk)) : { ok: false, reason: 'no bars' }
  const cat = catOf.get(tk)
  const below = cat?.sessionsBelow ?? null
  const signal = cat?.event ? { jump_date: cat.event, jump: cat.jump, sessions_below: below, earnings_jump: ernOf.get(`${tk}|${cat.event}`) ?? null, e3: below != null && below >= 3, e5: below != null && below >= 5 } : {}
  rows.push({ ticker: tk, asOf, q, signal })
})
const summary = quoteSummary(rows.map((r) => r.q))
const f = (x, d = 2) => (x == null ? '—' : x.toFixed(d))
const pc = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
console.log(`\n=== Real quotes vs the formula — ${rows.length} stocks, ${summary.withChain} with a chain, ${summary.quoted} quoted on both legs`)
console.log(`  real credit at the mid ÷ formula credit (median): ${f(summary.midVsModel)}`)
console.log(`  real credit at bid/ask (natural) ÷ formula (median): ${f(summary.naturalVsModel)}`)
console.log(`  real implied vol ÷ formula vol (median): ${f(summary.ivVsModel)}`)
console.log(`  credit as a share of width — formula ${f(summary.modelOfWidth)} · real mid ${f(summary.midOfWidth)}`)
console.log(`  natural credit above zero: ${pc(summary.naturalPositive)} · passes the practical checks (OI both legs, gap ≤ 20% of credit, credit ≥ 20% of width): ${pc(summary.tradeable)}`)
for (const r of rows.filter((x) => x.q.quoted).sort((a, b) => (b.signal.e3 ? 1 : 0) - (a.signal.e3 ? 1 : 0)).slice(0, 15)) {
  const q = r.q
  console.log(`  ${r.ticker.padEnd(6)} $${f(q.spot)} ${q.expiry} ${q.k1}/${q.k2} · formula ${f(q.model)} · mid ${f(q.realMid)} · natural ${f(q.realNatural)} · iv ${q.iv1 ? Math.round(q.iv1 * 100) + '%' : '—'} vs ${Math.round(q.modelVol * 100)}%${r.signal.e3 ? ` · E3 signal${r.signal.earnings_jump === false ? ' (non-earnings)' : ''}` : ''}`)
}
console.log(`bars from Yahoo ${sources.yahoo} / edge ${sources.edge}`)
if (DRY) { console.log('dry run — nothing written'); process.exit(0) }
const out = rows.map(({ ticker, asOf, q, signal }) => ({
  as_of: asOf, ticker, source: 'yahoo', spot: q.spot ?? null, expiry: q.expiry ?? null, dte: q.dte ?? null, k1: q.k1 ?? null, k2: q.k2 ?? null, width: q.width ?? null,
  model_vol: q.modelVol ?? null, iv1: q.iv1 ?? null, model_credit: q.model ?? null, real_mid: q.realMid ?? null, real_natural: q.realNatural ?? null, gap: q.gap ?? null,
  bid1: q.bid1 ?? null, ask1: q.ask1 ?? null, bid2: q.bid2 ?? null, ask2: q.ask2 ?? null, oi1: q.oi1 ?? null, oi2: q.oi2 ?? null, quoted: !!q.quoted, reason: q.ok ? null : q.reason, signal,
}))
for (let k = 0; k < out.length; k += 200) {
  const { error: e } = await db.from('quote_checks').upsert(out.slice(k, k + 200), { onConflict: 'as_of,ticker,source' })
  if (e) { console.error('quote_checks upsert failed', e.message); process.exit(1) }
}
console.log(`wrote ${out.length} quote_checks rows`)
