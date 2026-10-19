// Economic calendar (owner, 2026-10-19): fetch the Fed's FOMC calendar and
// the BLS / BEA release schedules, parse them (src/utils/econCalendar.js) and
// upsert econ_events. Each source is independent — one failing logs and the
// rest still land. Run by .github/workflows/econ-calendar.yml.
//   node scripts/econ-calendar.mjs           fetch + write
//   node scripts/econ-calendar.mjs --dry-run fetch + print only

import { parseIcs, parseFomc, parseFredDates } from '../src/utils/econCalendar.js'

const DRY = process.argv.includes('--dry-run')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const SOURCES = [
  { name: 'fed', urls: ['https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'], parse: (t) => parseFomc(t) },
  // bls.gov refuses GitHub's runners (403); FRED's release dates are the
  // fallback, when the free FRED_API_KEY secret is set.
  { name: 'bls', urls: ['https://www.bls.gov/schedule/news_release/bls.ics', ...(process.env.FRED_API_KEY ? [fredUrl()] : [])],
    parse: (t, url) => (url.includes('stlouisfed') ? parseFredDates(JSON.parse(t)) : parseIcs(t, 'bls')) },
  { name: 'bea', urls: ['https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics', 'https://apps.bea.gov/calendar/ics/bea-release-schedule.ics'], parse: (t) => parseIcs(t, 'bea') },
]

function fredUrl() {
  const start = new Date().toISOString().slice(0, 10)
  return `https://api.stlouisfed.org/fred/releases/dates?file_type=json&realtime_start=${start}&realtime_end=9999-12-31&include_release_dates_with_no_data=true&sort_order=asc&limit=1000&api_key=${process.env.FRED_API_KEY}`
}

async function get(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/calendar,*/*', 'Accept-Language': 'en-US,en;q=0.9' } })
  if (!resp.ok) throw new Error(`${resp.status}`)
  return resp.text()
}

const today = new Date().toISOString().slice(0, 10)
const horizon = new Date(Date.now() + 200 * 86400e3).toISOString().slice(0, 10)
const events = []
for (const src of SOURCES) {
  let done = false
  for (const url of src.urls) {
    try {
      const got = src.parse(await get(url), url).filter((e) => e.event_date >= today && e.event_date <= horizon)
      const shown = url.replace(/api_key=[^&]+/, 'api_key=…')
      console.log(`${src.name}: ${got.length} upcoming events from ${shown}`)
      events.push(...got.map((e) => ({ ...e, url: shown })))
      done = true
      break
    } catch (e) { console.log(`${src.name}: ${url.replace(/api_key=[^&]+/, 'api_key=…')} failed (${e.message})`) }
  }
  if (!done) console.log(`${src.name}: no calendar this run`)
}
// One per (kind, date).
const rows = [...new Map(events.map((e) => [`${e.kind}:${e.event_date}`, e])).values()].sort((a, b) => a.event_date.localeCompare(b.event_date))
for (const e of rows.slice(0, 25)) console.log(`  ${e.event_date} ${e.event_time ?? '     '} ${e.kind.padEnd(5)} ${e.title}`)
if (DRY || !rows.length) { console.log(DRY ? 'dry run — nothing written' : 'nothing to write'); process.exit(rows.length || DRY ? 0 : 1) }

const { createClient } = await import('@supabase/supabase-js')
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const now = new Date().toISOString()
const { error } = await db.from('econ_events').upsert(rows.map((e) => ({ ...e, updated_at: now })), { onConflict: 'kind,event_date' })
if (error) throw new Error(`econ_events: ${error.message}`)
console.log(`Wrote ${rows.length} econ events.`)
