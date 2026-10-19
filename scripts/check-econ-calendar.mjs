// npm run econcalendar:check — src/utils/econCalendar.js
import { parseIcs, parseFomc } from '../src/utils/econCalendar.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name, cond) } }

const ics = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'DTSTART;TZID=US-Eastern:20261015T083000', 'SUMMARY:Consumer Price Index for September 2026', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;TZID=US-Eastern:20261106T083000', 'SUMMARY:Employment Situation for Oct', ' ober 2026', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261020', 'SUMMARY:Usual Weekly Earnings', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20261029T083000', 'SUMMARY:Gross Domestic Product\\, 3rd Quarter 2026 (Advance Estimate)', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')
const ev = parseIcs(ics, 'bls')
ok('keeps the releases we track, drops the rest', ev.map((e) => e.kind).join(',') === 'cpi,jobs,gdp')
ok('date + time', ev[0].event_date === '2026-10-15' && ev[0].event_time === '08:30')
ok('folded line joined', ev[1].title === 'Employment Situation for October 2026')
ok('escaped comma', ev[2].title.startsWith('Gross Domestic Product, 3rd'))

const html = `<h4><a>2026 FOMC Meetings</a></h4>
  <div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">27-28</div>
  <div class="fomc-meeting__month"><strong>March</strong></div><div class="fomc-meeting__date">17-18*</div>
  <div class="fomc-meeting__month"><strong>Apr/May</strong></div><div class="fomc-meeting__date">28-29</div>
  <div class="fomc-meeting__month"><strong>December</strong></div><div class="fomc-meeting__date">8-9*</div>
  <h4><a>2027 FOMC Meetings</a></h4>
  <div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">26-27</div>`
const f = parseFomc(html)
ok('fomc: one per meeting, last day', f.map((e) => e.event_date).join(',') === '2026-01-28,2026-03-18,2026-05-29,2026-12-09,2027-01-27')
ok('fomc: 2pm ET', f.every((e) => e.event_time === '14:00' && e.kind === 'fomc'))
ok('fomc: Dec/Jan rolls the year', parseFomc('2026 FOMC Meetings Dec/Jan 31-1')[0]?.event_date === '2027-01-01')
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
