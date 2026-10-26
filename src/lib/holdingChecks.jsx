import { isQuantity } from '../hooks/useHoldings'
import { timeStop, longTermFitsPlan } from '../utils/afterTax'

// The daily checks the LEAPS bot runs, on the app's own numbers
// (useHoldings results). Home shows what needs action; the Bot view shows
// one decision per holding. Same order as the engine's sell rules
// (ldp/rules.py): time stop → targets → runner trail → roll window →
// wait for long-term → hold. A broken thesis is the user's call.
// Facts against the user's own plan, never instructions (owner, 2026-10-19:
// no investment-adviser activity): "reached your +100% target", "your plan
// sells 7 contracts here" — not "Sell 7 contracts".

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
    out.push({ rank: 0, kind: 'exit', tone: 'red', pos, title: `${nameOf(pos)}: past your time stop`,
      body: `${stop.dte} days to expiry. Your plan exits or rolls with 6 months left.` })
  }
  for (const row of rows) {
    if (!row.hit || row.contracts === 0) continue
    out.push({ rank: 1, kind: 'sell', tone: 'green', pos, title: `${nameOf(pos)} reached your ${gainLabel(row)} target`,
      body: <>Your plan sells <span className="text-amber-300">{sellCount(row, pos)}</span> here{row.after_tax_gain > 0 && <> · <span className="font-mono-tab text-green-400">+{usd(row.after_tax_gain)}</span> after taxes if sold</>}</> })
  }
  // Runner trail — only once every target has hit.
  const runner = r.runner
  const units = isQuantity(pos.instrument_type) ? Number(pos.shares) : Number(pos.contracts)
  const unitNow = units > 0 ? calc.current_value / units : null
  if (runner?.trail_unit_value != null && unitNow != null && rows.length > 0
    && rows.every((x) => x.hit) && unitNow <= runner.trail_unit_value) {
    out.push({ rank: 1, kind: 'sell', tone: 'amber', pos, title: `${nameOf(pos)}: runner trail reached`,
      body: `Down ${Math.round(runner.trail_pct * 100)}% from its peak — the level where your plan sells the runner.` })
  }
  if (stop?.level === 'warn') {
    const months = Math.max(1, Math.round(stop.dte / 30.44))
    out.push({ rank: 2, kind: 'roll', tone: 'amber', pos, title: `${nameOf(pos)}: roll window open`,
      body: `${months} months to expiry. Your plan exits or rolls with 6 months left.` })
  }
  if (calc.is_long_term === false && calc.tax_saved_by_waiting > 0 && calc.days_until_long_term <= 60
    && longTermFitsPlan(calc.long_term_date, isQuantity(pos.instrument_type) ? null : pos.expiration, plan)) {
    out.push({ rank: 3, kind: 'wait', tone: 'green', pos, title: `${nameOf(pos)} goes long-term in ${calc.days_until_long_term} days`,
      body: <>Selling after that date would cost about <span className="font-mono-tab text-green-400">{usd(calc.tax_saved_by_waiting)}</span> less in tax.</> })
  }
  return out
}

// A promise slipped (owner, 2026-10-26: "kill on a slip lives in my head,
// not in the app"): ledger rows marked missed / not mentioned / date moved
// in the last 7 days become a row on Home that states the fact and the
// user's own slip rule back to them (Settings → On a slip). The app never
// supplies the rule.
export const SLIP_WINDOW_DAYS = 7
export function slipActions(slipRows, positions, slipRule, now = Date.now()) {
  const out = []
  for (const m of slipRows ?? []) {
    const age = (now - new Date(m.updated_at ?? m.created_at).getTime()) / DAY_MS
    if (!(age <= SLIP_WINDOW_DAYS)) continue
    const what = m.status === 'missed' ? 'missed' : m.status === 'unmentioned' ? 'not mentioned on the last call' : (m.slips ?? 0) > 0 ? `date moved ${m.slips}×` : null
    if (!what) continue
    const pos = (positions ?? []).find((p) => p.id === m.position_id) ?? (positions ?? []).find((p) => String(p.ticker ?? '').toUpperCase() === m.ticker && !p.closed_at)
    out.push({ rank: 1, kind: 'slip', tone: m.status === 'missed' ? 'red' : 'amber', pos,
      title: `${m.ticker}: ${m.title} — ${what}`,
      body: slipRule ? `Your rule: ${slipRule}` : 'You have no slip rule yet — write one in Settings → On a slip.' })
  }
  return out
}

// Home: everything that needs action today, plus stale prices.
export function needsAction(results, positions, plan, today, now = Date.now()) {
  const out = results.flatMap((r) => checksFor(r, plan, today))
  const stale = (positions ?? []).filter((x) => x.instrument_type !== 'cash' && x.value_as_of
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
      return { pos, kind: 'hold', tone: 'neutral', verdict: 'No plan', title: nameOf(pos),
        body: 'Income holding — no exit plan.' }
    }
    const [first] = checksFor(r, plan, today).sort((a, b) => a.rank - b.rank)
    if (first) {
      const verdict = { exit: 'Time stop', sell: 'Target reached', roll: 'Roll window', wait: 'Long-term soon' }[first.kind]
      return { ...first, verdict }
    }
    const next = exitRows(r).find((x) => !x.hit && x.contracts !== 0)
    const needs = next && calc.current_value > 0 ? next.exit_value / calc.current_value - 1 : null
    return { pos, kind: 'hold', tone: 'neutral', verdict: 'On plan', title: nameOf(pos),
      body: next
        ? <>Next: {gainLabel(next)} at <span className="font-mono-tab text-fg">{usd(next.exit_value)}</span> · needs <span className="font-mono-tab text-fg">{pctSigned(needs)}</span></>
        : 'No target left — the runner rides its trail.' }
  })
}
