// Earnings events with timing from two sources (PREREG §2), plus aligned daily bars.
// Source 1: SEC EDGAR 8-K Item 2.02 acceptance time. Source 2: Nasdaq's earnings
// calendar for the same date (time-pre-market / time-after-hours). Writes events.json
// and bars.json. Runs on GitHub's runners (the dev sandbox can't reach either host).
import { writeFileSync } from 'node:fs'
import { secJson, cikMap } from '../../scripts/lib/sec.mjs'
import { dailyBars, mapLimit } from '../../scripts/lib/marketData.mjs'
import { RULES, edgarTiming, confirm, sessionsFor } from './lib.mjs'

const SINCE = '2016-01-01'
const tickers = (process.env.TICKERS || RULES.universe.join(',')).split(',')
const ciks = await cikMap()

async function itemFilings(cik) {
  const rows = []
  const take = (b) => { for (let k = 0; k < (b?.form?.length ?? 0); k++) if (b.form[k] === '8-K' && String(b.items?.[k] ?? '').split(',').map((s) => s.trim()).includes('2.02')) rows.push({ filed: b.filingDate[k], acceptance: b.acceptanceDateTime[k], accession: b.accessionNumber[k] }) }
  const j = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`)
  if (!j) return null
  take(j.filings?.recent)
  for (const f of j.filings?.files ?? []) { if (f.filingTo && f.filingTo < SINCE) continue; take(await secJson(`https://data.sec.gov/submissions/${f.name}`)) }
  return rows.filter((r) => r.filed >= SINCE).sort((a, b) => a.acceptance.localeCompare(b.acceptance))
}

const nasdaqCache = new Map(), nasdaqStatus = {}, nasdaqSamples = []
async function nasdaqDay(date) {
  if (nasdaqCache.has(date)) return nasdaqCache.get(date)
  let out = null
  for (let a = 0; a < 3 && out == null; a++) {
    try {
      const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15', Accept: 'application/json', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' }, signal: AbortSignal.timeout(15000) })
      nasdaqStatus[r.status] = (nasdaqStatus[r.status] ?? 0) + 1
      if (r.ok) { const j = await r.json(); out = new Map((j?.data?.rows ?? []).map((x) => [String(x.symbol).toUpperCase(), x.time])); if (nasdaqSamples.length < 6) nasdaqSamples.push({ date, keys: Object.keys(j?.data ?? {}), rows: (j?.data?.rows ?? []).length, sample: (j?.data?.rows ?? []).slice(0, 2), message: j?.message ?? j?.status ?? null }) }
    } catch { nasdaqStatus.error = (nasdaqStatus.error ?? 0) + 1 }
    if (out == null) await new Promise((r) => setTimeout(r, 1500 * (a + 1)))
  }
  nasdaqCache.set(date, out)
  return out
}
const nasdaqTiming = (t) => (t === 'time-pre-market' ? 'BMO' : t === 'time-after-hours' ? 'AMC' : null)

// Bars first: sessions from SPY; every ticker aligned to them.
const spy = await dailyBars('SPY', { range: '10y' })
const sessions = spy.map((b) => b.t)
const align = (bars) => { const m = new Map(bars.map((b) => [b.t, b])); return { c: sessions.map((d) => m.get(d)?.c ?? null), o: sessions.map((d) => m.get(d)?.o ?? null) } }
const vixBars = await dailyBars('^VIX', { range: '10y' }).catch(() => [])
const closes = {}, opens = {}
await mapLimit(tickers, 4, async (tk) => { try { const a = align(await dailyBars(tk, { range: '10y' })); closes[tk] = a.c; opens[tk] = a.o } catch (e) { console.log(`bars ${tk}: ${e.message}`) } })

const events = [], hours = new Array(24).fill(0), counts = {}
for (const tk of tickers) {
  const cik = ciks.get(tk)
  if (!cik) { console.log(`${tk}: no CIK`); continue }
  const rows = await itemFilings(cik)
  if (!rows) { console.log(`${tk}: submissions failed`); continue }
  let lastDate = null
  for (const r of rows) {
    const e = edgarTiming(r.acceptance)
    if (!e) continue
    hours[Math.floor(e.minutes / 60)]++
    if (lastDate && (Date.parse(e.date) - Date.parse(lastDate)) / 86400e3 < 20) { counts.duplicate = (counts.duplicate ?? 0) + 1; continue }
    lastDate = e.date
    const nd = await nasdaqDay(e.date)
    const second = nd ? (nasdaqTiming(nd.get(tk)) ? { date: e.date, timing: nasdaqTiming(nd.get(tk)) } : null) : null
    const c = confirm(e, second)
    const s = c.date ? sessionsFor(sessions, c.date, c.timing) : null
    counts[c.status] = (counts[c.status] ?? 0) + 1
    events.push({ tk, ...c, acceptance: r.acceptance, accession: r.accession, L: s ? sessions[s.L] : null, after: s ? sessions[s.after] : null })
  }
}
console.log(`events: ${events.length} · ${JSON.stringify(counts)} · Nasdaq HTTP ${JSON.stringify(nasdaqStatus)}`)
console.log(`Nasdaq samples: ${JSON.stringify(nasdaqSamples).slice(0, 2500)}`)
console.log(`8-K 2.02 acceptance hour (Eastern): ${hours.map((n, h) => (n ? `${h}h ${n}` : '')).filter(Boolean).join(' · ')}`)
const conf = events.filter((e) => e.status === 'confirmed')
console.log(`confirmed: ${conf.length} (${conf.filter((e) => e.timing === 'AMC').length} AMC, ${conf.filter((e) => e.timing === 'BMO').length} BMO) · in-sample ${conf.filter((e) => e.L && e.L < RULES.oosFrom).length} · held out ${conf.filter((e) => e.L && e.L >= RULES.oosFrom).length}`)
for (const tk of ['NOW', 'NVDA', 'JPM']) console.log(`  ${tk}: ${events.filter((e) => e.tk === tk).slice(-4).map((e) => `${e.date} ${e.timing ?? ''} ${e.status}`).join(' | ')}`)
writeFileSync('events.json', JSON.stringify({ rules: RULES.version, built: new Date().toISOString(), sources: ['SEC EDGAR 8-K Item 2.02 acceptanceDateTime', 'api.nasdaq.com earnings calendar time field'], counts, nasdaqStatus, events }, null, 1))
writeFileSync('bars.json', JSON.stringify({ sessions, closes, opens, vix: align(vixBars).c }))
console.log('wrote events.json, bars.json')
