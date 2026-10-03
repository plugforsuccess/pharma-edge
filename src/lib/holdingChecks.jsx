import { isQuantity } from '../hooks/useHoldings'
import { timeStop, longTermFitsPlan } from '../utils/afterTax'

// The daily checks the LEAPS bot runs, on the app's own numbers
// (useHoldings results). Home shows what needs action; the Bot view shows
// one decision per holding. Same order as the engine's sell rules
// (ldp/rules.py): time stop → targets → runner trail → roll window →
// wait for long-term → hold. A broken thesis is the user's call.

export const usd = (n) => (Number.isFinite(n) ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}` : '—')
export const pctSigned = (r) => (Number.isFinite(r) ? `${r > 0.00005 ? '+' : r < -0.00005 ? '−' : ''}${Math.abs(r * 100).toFixed(1)}%` : '—')
export const STALE_DAYS = 7
const DAY_MS = 86400000

export const nameOf = (pos) => pos.ticker ?? pos.name ?? 'Holding'
const unitOf = (pos) => (pos.instrument_type === 'crypto' ? `$${pos.ticker}` : isQuantity(pos.instrument_type) ? 'share' : 'contract')
function qty(n, unit) {
  const s = Number(n).toLocaleString('en-US', { maximumFractionDigits: unit.startsWith('$') ? 8 : 2 })
  return unit.startsWith('$') ? `${s} ${unit}` : `${s} ${unit}${Number(n) === 1 ? '' : 's'}`
}
// What a target sells, as a count ("35 contracts", "0.1625 $BTC").
export function sellCount(row, pos) {
  const unit = unitOf(pos)
  const units = isQuantity(pos.instrument_type) ? Number(pos.shares) : Number(pos.contracts)
  if (row.contracts != null) return qty(row.contracts, unit)
  return units > 0 ? qty(+(units * row.fraction).toFixed(unit.startsWith('$') ? 8 : 2), unit) : `${Math.round(row.fraction * 100)}%`
}
export const gainLabel = (row) => `${Math.round(row.gain_pct * 100).toLocaleString('en-US')}% gain`
export const isRoc = (pos) => pos.instrument_type === 'stock' && pos.details?.dividend_kind === 'roc'
export const exitRows = (r) => (r.custom?.length ? r.custom : r.ladder) ?? []

// Every check that fires for one holding, most urgent first.
function checksFor(r, plan, today) {
  const { pos, calc } = r
  const out = []
  if (!calc || isRoc(pos)) return out
  const rows = exitRows(r)
  const stop = isQuantity(pos.instrument_type) ? null : timeStop(pos.expiration, today, plan)
  if (stop?.level === 'act') {
    out.push({ rank: 0, kind: 'exit', tone: 'red', pos, title: `${nameOf(pos)}: exit or roll now`,
      body: `${stop.dte} days to expiry — past your 6-month time stop.` })
  }
  for (const row of rows) {
    if (!row.hit || row.contracts === 0) continue
    out.push({ rank: 1, kind: 'sell', tone: 'green', pos, title: `${nameOf(pos)} hit ${gainLabel(row)}`,
      body: <>Sell <span className="text-amber-300">{sellCount(row, pos)}</span>{row.after_tax_gain > 0 && <> · <span className="font-mono-tab text-green-400">+{usd(row.after_tax_gain)}</span> after taxes</>}</> })
  }
  // Runner trail — only once every target has hit.
  const runner = r.runner
  const units = isQuantity(pos.instrument_type) ? Number(pos.shares) : Number(pos.contracts)
  const unitNow = units > 0 ? calc.current_value / units : null
  if (runner?.trail_unit_value != null && unitNow != null && rows.length > 0
    && rows.every((x) => x.hit) && unitNow <= runner.trail_unit_value) {
    out.push({ rank: 1, kind: 'sell', tone: 'amber', pos, title: `${nameOf(pos)}: runner trail hit`,
      body: `Down ${Math.round(runner.trail_pct * 100)}% from its peak — the plan sells the runner.` })
  }
  if (stop?.level === 'warn') {
    const months = Math.max(1, Math.round(stop.dte / 30.44))
    out.push({ rank: 2, kind: 'roll', tone: 'amber', pos, title: `${nameOf(pos)}: roll window open`,
      body: `${months} months to expiry. Exit or roll before 6 months are left.` })
  }
  if (calc.is_long_term === false && calc.tax_saved_by_waiting > 0 && calc.days_until_long_term <= 60
    && longTermFitsPlan(calc.long_term_date, isQuantity(pos.instrument_type) ? null : pos.expiration, plan)) {
    out.push({ rank: 3, kind: 'wait', tone: 'green', pos, title: `${nameOf(pos)} goes long-term in ${calc.days_until_long_term} days`,
      body: <>Waiting saves about <span className="font-mono-tab text-green-400">{usd(calc.tax_saved_by_waiting)}</span> in tax.</> })
  }
  return out
}

// Home: everything that needs action today, plus stale prices.
export function needsAction(results, positions, plan, today, now = Date.now()) {
  const out = results.flatMap((r) => checksFor(r, plan, today))
  // Cash, car values and debt balances don't move with the market.
  const stale = (positions ?? []).filter((x) => !['cash', 'vehicle', 'debt'].includes(x.instrument_type) && x.value_as_of
    && (now - new Date(x.value_as_of).getTime()) / DAY_MS > STALE_DAYS)
  if (stale.length) {
    out.push({ rank: 4, kind: 'stale', tone: 'neutral', title: `Update ${stale.length} price${stale.length === 1 ? '' : 's'}`,
      body: `${stale.slice(0, 3).map(nameOf).join(', ')}${stale.length > 3 ? '…' : ''} last priced over ${STALE_DAYS} days ago.` })
  }
  return out.sort((a, b) => a.rank - b.rank)
}

// Bot view: one decision per holding — the first check that fires, else
// hold (with the next target, or why there's no plan).
export function dailyDecisions(results, plan, today) {
  return results.filter((r) => r.calc).map((r) => {
    const { pos, calc } = r
    if (isRoc(pos)) {
      return { pos, kind: 'hold', tone: 'neutral', verdict: 'Hold', title: nameOf(pos),
        body: 'Income holding — no exit plan. Payouts keep coming.' }
    }
    const [first] = checksFor(r, plan, today).sort((a, b) => a.rank - b.rank)
    if (first) {
      const verdict = { exit: 'Exit or roll', sell: 'Sell', roll: 'Roll window', wait: 'Wait' }[first.kind]
      return { ...first, verdict }
    }
    const next = exitRows(r).find((x) => !x.hit && x.contracts !== 0)
    const needs = next && calc.current_value > 0 ? next.exit_value / calc.current_value - 1 : null
    return { pos, kind: 'hold', tone: 'neutral', verdict: 'Hold', title: nameOf(pos),
      body: next
        ? <>Next: {gainLabel(next)} at <span className="font-mono-tab text-fg">{usd(next.exit_value)}</span> · needs <span className="font-mono-tab text-fg">{pctSigned(needs)}</span></>
        : 'No target left — the runner rides its trail.' }
  })
}
