// The jump record (owner, 2026-11-14: "Yes build it. Make sure we include the earnings
// dates in your reporting"): what scripts/tape-scan.mjs logs each night for a fresh jump
// on the pre-revenue scan, and how the record is summarised. Earnings come from the SEC
// (8-K item 2.02, "results of operations") and the earnings calendar. Pure;
// npm run jumprecord:check.
import { jumpPath, QUARTER_MONTHS } from './shortWindow.js'

export const JUMP_RECORD = Object.freeze({ freshDays: 7, reportBefore: 3, reportAfter: 1, quarterDays: 91, summaryMonths: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6] })
const DAY = 86400e3
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)

// filings: [{ form, date, items }] → the 8-K 2.02 filed from `reportBefore` days before the
// jump to `reportAfter` after it (an after-the-close report is filed the evening before).
export function reportOnJump(filings, jumpDate, p = JUMP_RECORD) {
  const lo = addDays(jumpDate, -p.reportBefore), hi = addDays(jumpDate, p.reportAfter)
  const hit = (filings ?? []).filter((f) => f.form === '8-K' && (f.items ?? []).includes('2.02') && f.date >= lo && f.date <= hi)
  return hit.length ? hit[hit.length - 1].date : null
}

// The next report after `after`: the earliest calendar date, else the latest 8-K 2.02
// plus a quarter (estimated), stepped forward until it lands after `after`.
export function nextReport(calendar, filings, after, p = JUMP_RECORD) {
  const cal = (calendar ?? []).filter((d) => d > after).sort()
  if (cal.length) return { date: cal[0], est: false }
  const last = (filings ?? []).filter((f) => f.form === '8-K' && (f.items ?? []).includes('2.02')).map((f) => f.date).sort().pop()
  if (!last) return { date: null, est: false }
  let d = addDays(last, p.quarterDays)
  while (d <= after) d = addDays(d, p.quarterDays)
  return { date: d, est: true }
}

export const isFresh = (catalyst, asOf, p = JUMP_RECORD) => !!(catalyst?.event && asOf && daysBetween(catalyst.event, asOf) <= p.freshDays)

// bars: daily, through the latest close → { path: { "0.25": { ret, low } … }, last } from the jump close.
export function recordPath(bars, jumpDate) {
  const e = (bars ?? []).findIndex((b) => b.t === jumpDate)
  if (e < 0) return null
  const p = jumpPath(bars, e) ?? {}
  return { path: Object.fromEntries(Object.entries(p).map(([m, x]) => [String(m), { ret: +x.ret.toFixed(4), low: +x.lowSoFar.toFixed(4) }])), last: bars[bars.length - 1].c }
}

const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }

// rows: jump_record rows → per summary month { n, ret, below, down20, low20 } for all / earnings / other.
export function recordSummary(rows, p = JUMP_RECORD) {
  const one = (set) => Object.fromEntries(p.summaryMonths.map((m) => {
    const xs = set.map((r) => r.path?.[String(m)]).filter(Boolean)
    const shr = (f) => (xs.length ? xs.filter(f).length / xs.length : null)
    return [m, { n: xs.length, ret: med(xs.map((x) => x.ret)), below: shr((x) => x.ret < 0), down20: shr((x) => x.ret <= -0.2), low20: shr((x) => x.low <= -0.2) }]
  }))
  return { n: rows.length, all: one(rows), earnings: one(rows.filter((r) => r.earnings_jump)), other: one(rows.filter((r) => !r.earnings_jump)) }
}

export const monthLabel = (m) => (m < 1 ? `${Math.round(m * 4)}W` : `${m}M`)
export { QUARTER_MONTHS }
