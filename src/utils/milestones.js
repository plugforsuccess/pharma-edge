// Milestone ledger (owner spec v2, 2026-10-26): each dated promise
// management has made, where it stands, and how many times the date has
// moved. "Slips are facts, not points." The ledger states the record; it
// never feeds a score. Rows: { title, due_date (first promised),
// current_due (null = due_date), slips, status: 'pending' | 'met' | 'missed'
// | 'unmentioned', resolved_on, source, evidence }. Pure; npm run milestones:check.

export const MILESTONE_STATUS = Object.freeze(['pending', 'met', 'missed', 'unmentioned'])
const DAY = 86400000
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)
export const dueOf = (row) => row.current_due ?? row.due_date
const quarterOf = (d) => `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`

// One row's reading on `today`.
export function milestoneState(row, today) {
  const st = row.status ?? 'pending'
  const due = dueOf(row)
  if (st === 'met') return { kind: 'met', late: row.resolved_on && due ? Math.max(0, days(due, row.resolved_on)) : 0 }
  if (st === 'missed') return { kind: 'missed' }
  const d = due ? days(today, due) : null
  if (st === 'unmentioned') return { kind: 'unmentioned', daysLeft: d }
  return { kind: d != null && d < 0 ? 'overdue' : 'pending', daysLeft: d }
}

// The card's header facts: the next dated promise, what's due this quarter,
// what's past due with no evidence, and the record so far.
export function ledgerSummary(rows, today) {
  const states = (rows ?? []).map((r) => ({ row: r, s: milestoneState(r, today) }))
  const open = states.filter((x) => x.s.kind === 'pending' || x.s.kind === 'overdue' || x.s.kind === 'unmentioned')
  const met = states.filter((x) => x.s.kind === 'met')
  const missed = states.filter((x) => x.s.kind === 'missed')
  const overdue = states.filter((x) => x.s.kind === 'overdue').map((x) => x.row)
  const unmentioned = states.filter((x) => x.s.kind === 'unmentioned').map((x) => x.row)
  const upcoming = open.filter((x) => x.s.daysLeft != null && x.s.daysLeft >= 0).sort((a, b) => a.s.daysLeft - b.s.daysLeft)
  const next = upcoming[0] ? { row: upcoming[0].row, daysLeft: upcoming[0].s.daysLeft } : null
  const q = quarterOf(today)
  const dueThisQuarter = open.filter((x) => quarterOf(dueOf(x.row)) === q).map((x) => x.row)
  const slipped = states.filter((x) => (x.row.slips ?? 0) > 0)
  const slipDays = states.flatMap((x) => ((x.row.slips ?? 0) > 0 && x.row.current_due ? [days(x.row.due_date, x.row.current_due)] : []))
  return {
    total: states.length, met: met.length, onTime: met.filter((x) => x.s.late <= 0).length, missed: missed.length,
    overdue, unmentioned, next, dueThisQuarter, open: open.map((x) => x.row),
    slipped: slipped.length, slipDaysAvg: slipDays.length ? Math.round(slipDays.reduce((a, b) => a + b, 0) / slipDays.length) : null,
    resolved: met.length + missed.length,
  }
}

const short = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

// Header lines: [what's next, what's due / past due, the record]. Facts only.
export function ledgerLines(sum) {
  if (!sum.total) return []
  const out = []
  if (sum.next) out.push(`Next: ${sum.next.row.title} · due ${short(dueOf(sum.next.row))}${sum.next.daysLeft === 0 ? ' (today)' : ` (${sum.next.daysLeft} days)`}`)
  const due = []
  if (sum.dueThisQuarter.length) due.push(`${sum.dueThisQuarter.length} due this quarter`)
  if (sum.overdue.length) due.push(`${sum.overdue.length} past due, unconfirmed`)
  if (sum.unmentioned.length) due.push(`${sum.unmentioned.length} not mentioned on the last call`)
  if (due.length) out.push(due.join(' · '))
  const rec = []
  if (sum.resolved) rec.push(`${sum.onTime} of ${sum.resolved} met on time`)
  if (sum.slipped) rec.push(`${sum.slipped} date${sum.slipped === 1 ? '' : 's'} moved${sum.slipDaysAvg != null ? `, ${sum.slipDaysAvg} days on average` : ''}`)
  if (sum.missed) rec.push(`${sum.missed} missed`)
  if (rec.length) out.push(rec.join(' · '))
  if (!out.length) out.push(`${sum.open.length} promise${sum.open.length === 1 ? '' : 's'} on the calendar`)
  return out
}

// The day before a call: which rows the call must confirm (open, due by the
// end of this quarter). The day after: which are still unconfirmed.
export function callChecklist(rows, today) {
  const sum = ledgerSummary(rows, today)
  const q = quarterOf(today)
  return sum.open.filter((r) => quarterOf(dueOf(r)) <= q).map((r) => ({ title: r.title, due: dueOf(r), slips: r.slips ?? 0 }))
}
