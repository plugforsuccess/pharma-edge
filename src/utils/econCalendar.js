// Scheduled US economic releases and Fed meetings (owner, 2026-10-19:
// "risks signaled by government … and economic news and alerts"). Pure
// parsers for the agencies' own calendars; scripts/econ-calendar.mjs fetches
// and stores them in econ_events. Never typed in by hand.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const monthIndex = (name) => MONTHS.findIndex((m) => m.startsWith(String(name).toLowerCase().slice(0, 3)))
const ymd = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

// BLS / BEA release names → our kinds.
export const RELEASES = Object.freeze([
  [/consumer price index/i, 'cpi', 'Consumer Price Index (inflation)'],
  [/employment situation/i, 'jobs', 'Jobs report (Employment Situation)'],
  [/producer price index/i, 'ppi', 'Producer Price Index'],
  [/job openings and labor turnover/i, 'jolts', 'Job openings (JOLTS)'],
  [/gross domestic product|^gdp/i, 'gdp', 'GDP'],
  [/personal income and outlays/i, 'pce', 'PCE inflation (Personal Income and Outlays)'],
])
const kindOf = (summary) => RELEASES.find(([re]) => re.test(summary)) ?? null

// iCalendar text → [{ kind, event_date, event_time, title, source }] for the
// releases above. Handles folded lines and DTSTART with or without a TZID.
export function parseIcs(text, source) {
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '')
  const out = []
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const summary = (block.match(/\nSUMMARY[^:]*:(.*)/) ?? [])[1]?.trim()
    const start = (block.match(/\nDTSTART[^:]*:(\d{8})(?:T(\d{2})(\d{2})\d{0,2}(Z?))?/) ?? [])
    if (!summary || !start[1]) continue
    const k = kindOf(summary)
    if (!k) continue
    const d = start[1]
    let date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
    let time = start[2] ? `${start[2]}:${start[3]}` : null
    // BEA's feed is in UTC ("…T123000Z") — shown and alerted in Eastern time.
    if (start[4] === 'Z') ({ date, time } = utcToEastern(`${date}T${time}:00Z`))
    out.push({ kind: k[1], event_date: date, event_time: time, title: summary.replace(/\\,/g, ',').slice(0, 140), source })
  }
  return out
}

// An ISO UTC instant → { date, time } on the America/New_York clock.
export function utcToEastern(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

// FRED's release-dates API (fallback when bls.gov refuses the runner) →
// the BLS releases we track. FRED gives dates only; BLS publishes these at
// fixed times (8:30 am ET, JOLTS 10:00 am ET).
export const FRED_RELEASES = Object.freeze({
  10: ['cpi', 'Consumer Price Index', '08:30'],
  50: ['jobs', 'Employment Situation', '08:30'],
  46: ['ppi', 'Producer Price Index', '08:30'],
  192: ['jolts', 'Job Openings and Labor Turnover Survey', '10:00'],
})
export function parseFredDates(body) {
  const out = []
  for (const r of body?.release_dates ?? []) {
    const k = FRED_RELEASES[r.release_id]
    if (!k || !/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '')) continue
    out.push({ kind: k[0], event_date: r.date, event_time: k[2], title: k[1], source: 'bls' })
  }
  return [...new Map(out.map((e) => [`${e.kind}:${e.event_date}`, e])).values()]
}

// The Fed's FOMC calendar page → one 'fomc' event per meeting, on its last
// day (the decision, 2:00 pm ET). Each year's panel starts "<year> FOMC
// Meetings"; meetings read month "January" / "Apr/May" and dates "27-28" /
// "30-1" / "16-17*".
export function parseFomc(html) {
  const out = []
  const text = String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
  const parts = text.split(/(\d{4}) FOMC Meetings/)
  for (let i = 1; i < parts.length; i += 2) {
    const year = Number(parts[i])
    const body = parts[i + 1] ?? ''
    const re = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?))? (\d{1,2})-(\d{1,2})\*?/g
    let m
    while ((m = re.exec(body))) {
      const first = monthIndex(m[1])
      const last = m[2] ? monthIndex(m[2]) : first
      const endDay = Number(m[4])
      if (first < 0 || last < 0 || !(endDay >= 1 && endDay <= 31)) continue
      const y = last < first ? year + 1 : year
      out.push({ kind: 'fomc', event_date: ymd(y, last, endDay), event_time: '14:00', title: 'Fed interest-rate decision (FOMC)', source: 'fed' })
    }
  }
  // One per meeting: the page repeats meetings (statements / minutes rows)
  // and can list a meeting's days more than one way, so dates within 3 days
  // collapse into one — the Wednesday (decision day) when there is one, else
  // the latest. Meetings are at least 5 weeks apart.
  const dates = [...new Set(out.map((e) => e.event_date))].sort()
  const clusters = []
  for (const d of dates) {
    const last = clusters[clusters.length - 1]
    if (last && (Date.parse(d) - Date.parse(last[last.length - 1])) / 86400e3 <= 3) last.push(d)
    else clusters.push([d])
  }
  return clusters.map((c) => {
    const pick = c.filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 3).pop() ?? c[c.length - 1]
    return { kind: 'fomc', event_date: pick, event_time: '14:00', title: 'Fed interest-rate decision (FOMC)', source: 'fed' }
  })
}
