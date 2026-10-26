// npm run milestones:check — src/utils/milestones.js
import { milestoneState, ledgerSummary, ledgerLines, callChecklist } from '../src/utils/milestones.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const today = '2026-10-26'
const rows = [
  { title: 'FAA certification basis', due_date: '2026-03-31', status: 'met', resolved_on: '2026-03-20', slips: 0 },
  { title: 'Supplier agreement', due_date: '2026-06-30', status: 'met', resolved_on: '2026-08-15', slips: 0 },
  { title: 'First customer delivery', due_date: '2026-06-30', current_due: '2026-12-15', status: 'pending', slips: 1 },
  { title: 'Kubota units delivered', due_date: '2026-09-30', status: 'pending', slips: 0 },
  { title: 'UL certification', due_date: '2026-12-31', status: 'pending', slips: 0 },
  { title: 'Partnership', due_date: '2026-05-01', status: 'missed', slips: 0 },
  { title: 'Middle East site', due_date: '2026-11-30', status: 'unmentioned', slips: 0 },
]
ok('met early = on time', milestoneState(rows[0], today).late === 0)
ok('met late counts the days', milestoneState(rows[1], today).late === 46)
ok('a moved date reads from current_due', milestoneState(rows[2], today).kind === 'pending' && milestoneState(rows[2], today).daysLeft === 50)
ok('past due and pending → overdue', milestoneState(rows[3], today).kind === 'overdue')
ok('unmentioned keeps its date', milestoneState(rows[6], today).kind === 'unmentioned' && milestoneState(rows[6], today).daysLeft === 35)
const s = ledgerSummary(rows, today)
ok('next = the soonest open promise', s.next.row.title === 'Middle East site' && s.next.daysLeft === 35)
ok('due this quarter counts open rows in Q4 (moved date included)', s.dueThisQuarter.map((r) => r.title).sort().join('|') === 'First customer delivery|Middle East site|UL certification')
ok('past due, unmentioned, record', s.overdue.length === 1 && s.unmentioned.length === 1 && s.resolved === 3 && s.onTime === 1 && s.missed === 1 && s.slipped === 1 && s.slipDaysAvg === 168)
const lines = ledgerLines(s)
ok('header lines', lines[0] === 'Next: Middle East site · due Nov 30 (35 days)' && lines[1] === '3 due this quarter · 1 past due, unconfirmed · 1 not mentioned on the last call' && lines[2] === '1 of 3 met on time · 1 date moved, 168 days on average · 1 missed')
ok('empty ledger → no lines', ledgerLines(ledgerSummary([], today)).length === 0)
ok('only future pending → next + calendar', ledgerLines(ledgerSummary([rows[4]], today)).join(' | ') === 'Next: UL certification · due Dec 31 (66 days) | 1 due this quarter')
ok('call checklist = open rows due by quarter end', callChecklist(rows, today).map((x) => x.title).sort().join('|') === 'First customer delivery|Kubota units delivered|Middle East site|UL certification')
ok('no verdict words', !/\b(sell|buy|hold|exit)\b/i.test(lines.join(' ')))
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
