// npm run milestones:check — src/utils/milestones.js
import { milestoneState, ledgerSummary, ledgerLine } from '../src/utils/milestones.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const today = '2026-10-26'
const rows = [
  { title: 'Phase 2 readout', due_date: '2026-03-31', status: 'met', resolved_on: '2026-03-20' },
  { title: 'FDA meeting', due_date: '2026-06-30', status: 'met', resolved_on: '2026-08-15' },
  { title: 'First delivery', due_date: '2026-09-30', status: 'delayed', new_due_date: '2027-01-15' },
  { title: 'Plant opening', due_date: '2026-10-01', status: 'pending' },
  { title: 'Q3 guidance', due_date: '2026-12-15', status: 'pending' },
  { title: 'Partnership', due_date: '2026-05-01', status: 'missed' },
]
ok('met early = on time', milestoneState(rows[0], today).late === 0)
ok('met late counts the days', milestoneState(rows[1], today).late === 46)
ok('delayed carries the slip', milestoneState(rows[2], today).slip === 107 && milestoneState(rows[2], today).due === '2027-01-15')
ok('past due and pending → overdue', milestoneState(rows[3], today).kind === 'overdue')
ok('future pending', milestoneState(rows[4], today).kind === 'pending' && milestoneState(rows[4], today).daysLeft === 50)
const s = ledgerSummary(rows, today)
ok('summary counts', s.total === 6 && s.met === 2 && s.onTime === 1 && s.missed === 1 && s.delayed === 1 && s.overdue.length === 1 && s.pending.length === 2)
ok('resolved = met + missed + delayed', s.resolved === 4)
ok('slips average the late met and the delay', s.slipCount === 2 && s.slipAvg === Math.round((46 + 107) / 2))
ok('the line states facts', ledgerLine(s) === '1 of 4 met on time · 2 slipped, 77 days on average · 1 missed · 1 past due with no word')
ok('empty ledger → no line', ledgerLine(ledgerSummary([], today)) === null)
ok('only pending → calendar line', ledgerLine(ledgerSummary([rows[4]], today)) === '1 promise on the calendar')
ok('no verdict words', !/\b(sell|buy|hold|exit)\b/i.test(ledgerLine(s)))
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
