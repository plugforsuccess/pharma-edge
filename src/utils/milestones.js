// Milestone ledger (owner spec, 2026-10-26: the ledger "stands on its own;
// it never depended on the score"). A holder writes down what the company
// promised and when; later marks each one met, missed or delayed. The
// ledger then states the record — "3 of 5 met on time · 2 slipped, 94 days
// on average" — as facts about the company's promises, never a verdict.
// Rows: { title, due_date, status: 'pending' | 'met' | 'missed' | 'delayed',
//   resolved_on, new_due_date }. Pure; npm run milestones:check.

export const MILESTONE_STATUS = Object.freeze(['pending', 'met', 'missed', 'delayed'])
const DAY = 86400000
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)

// One row's reading on `today`.
export function milestoneState(row, today) {
  const st = row.status ?? 'pending'
  if (st === 'met') return { kind: 'met', late: row.resolved_on && row.due_date ? Math.max(0, days(row.due_date, row.resolved_on)) : 0 }
  if (st === 'missed') return { kind: 'missed' }
  if (st === 'delayed') return { kind: 'delayed', slip: row.new_due_date && row.due_date ? days(row.due_date, row.new_due_date) : null, due: row.new_due_date ?? row.due_date }
  const d = row.due_date ? days(today, row.due_date) : null
  return { kind: d != null && d < 0 ? 'overdue' : 'pending', daysLeft: d }
}

// The ledger's summary: counts, on-time rate, average slip, what's overdue.
export function ledgerSummary(rows, today) {
  const states = (rows ?? []).map((r) => ({ row: r, s: milestoneState(r, today) }))
  const met = states.filter((x) => x.s.kind === 'met')
  const onTime = met.filter((x) => x.s.late <= 0)
  const slips = states.filter((x) => x.s.kind === 'delayed' && x.s.slip != null).map((x) => x.s.slip)
    .concat(met.filter((x) => x.s.late > 0).map((x) => x.s.late))
  const missed = states.filter((x) => x.s.kind === 'missed')
  const overdue = states.filter((x) => x.s.kind === 'overdue').map((x) => x.row)
  const pending = states.filter((x) => x.s.kind === 'pending' || x.s.kind === 'delayed').map((x) => x.row)
  const resolved = met.length + missed.length + slips.length - met.filter((x) => x.s.late > 0).length
  return {
    total: states.length, met: met.length, onTime: onTime.length, missed: missed.length, delayed: states.filter((x) => x.s.kind === 'delayed').length,
    overdue, pending, resolved,
    slipAvg: slips.length ? Math.round(slips.reduce((a, b) => a + b, 0) / slips.length) : null,
    slipCount: slips.length,
  }
}

// The one line under the title: facts about the record so far.
export function ledgerLine(sum) {
  if (!sum.total) return null
  const parts = []
  if (sum.resolved) parts.push(`${sum.onTime} of ${sum.resolved} met on time`)
  if (sum.slipCount) parts.push(`${sum.slipCount} slipped${sum.slipAvg != null ? `, ${sum.slipAvg} days on average` : ''}`)
  if (sum.missed) parts.push(`${sum.missed} missed`)
  if (sum.overdue.length) parts.push(`${sum.overdue.length} past due with no word`)
  if (!parts.length) parts.push(`${sum.pending.length} promise${sum.pending.length === 1 ? '' : 's'} on the calendar`)
  return parts.join(' · ')
}
