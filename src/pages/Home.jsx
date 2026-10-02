import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Calculator, ChevronRight, Plus, RefreshCw, Settings as SettingsIcon } from 'lucide-react'
import clsx from 'clsx'
import NotificationCenter from '../components/NotificationCenter'
import { useHoldings, isQuantity } from '../hooks/useHoldings'
import { todayYmd, timeStop, longTermFitsPlan } from '../utils/afterTax'

// Home — the LEAPS dashboard. One look at what needs attention today,
// pulled from the same numbers as Positions (useHoldings): net worth after
// tax, what needs action (targets hit, runner trails, time stops, a
// long-term date worth waiting for, stale prices), the next exit targets,
// goals and income. Every row links to Positions; nothing here edits.

const usd = (n) => (Number.isFinite(n) ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}` : '—')
const pctSigned = (r) => (Number.isFinite(r) ? `${r > 0.00005 ? '+' : r < -0.00005 ? '−' : ''}${Math.abs(r * 100).toFixed(1)}%` : '—')
const STALE_DAYS = 7
const DAY_MS = 86400000

const nameOf = (pos) => pos.ticker ?? pos.name ?? 'Holding'
const unitOf = (pos) => (pos.instrument_type === 'crypto' ? `$${pos.ticker}` : isQuantity(pos.instrument_type) ? 'share' : 'contract')
function qty(n, unit) {
  const s = Number(n).toLocaleString('en-US', { maximumFractionDigits: unit.startsWith('$') ? 8 : 2 })
  return unit.startsWith('$') ? `${s} ${unit}` : `${s} ${unit}${Number(n) === 1 ? '' : 's'}`
}
// What a target sells, as a count ("35 contracts", "0.1625 $BTC").
function sellCount(row, pos) {
  const unit = unitOf(pos)
  const units = isQuantity(pos.instrument_type) ? Number(pos.shares) : Number(pos.contracts)
  if (row.contracts != null) return qty(row.contracts, unit)
  return units > 0 ? qty(+(units * row.fraction).toFixed(unit.startsWith('$') ? 8 : 2), unit) : `${Math.round(row.fraction * 100)}%`
}
const gainLabel = (row) => `${Math.round(row.gain_pct * 100).toLocaleString('en-US')}% gain`
const isRoc = (pos) => pos.instrument_type === 'stock' && pos.details?.dividend_kind === 'roc'

export default function Home() {
  const navigate = useNavigate()
  const { federal, positions, plan, ready, results, summary, others } = useHoldings()
  const today = todayYmd()
  const loading = positions === null
  const hasHoldings = (positions?.length ?? 0) > 0

  // ── Net worth ────────────────────────────────────────────────
  const invested = summary?.after_tax_value ?? 0
  const after = invested + (others.cash ?? 0) + (others.realEstate ?? 0)
  const before = (summary?.current_value ?? 0) + (others.cashBefore ?? 0) + (others.realEstateBefore ?? 0)

  // ── Needs action, most urgent first ──────────────────────────
  const actions = useMemo(() => {
    const out = []
    for (const r of results) {
      const { pos, calc } = r
      if (!calc) continue
      const rows = r.custom?.length ? r.custom : r.ladder
      if (!isRoc(pos)) {
        // Time stop (options): act now, or the roll window is open.
        const stop = isQuantity(pos.instrument_type) ? null : timeStop(pos.expiration, today, plan)
        if (stop?.level === 'act') {
          out.push({ rank: 0, tone: 'red', pos, title: `${nameOf(pos)}: exit or roll now`,
            body: `${stop.dte} days to expiry — past your 6-month time stop.` })
        }
        // Targets the current value has reached.
        for (const row of rows ?? []) {
          if (!row.hit || row.contracts === 0) continue
          out.push({ rank: 1, tone: 'green', pos, title: `${nameOf(pos)} hit ${gainLabel(row)}`,
            body: <>Sell <span className="text-amber-300">{sellCount(row, pos)}</span>{row.after_tax_gain > 0 && <> · <span className="font-mono-tab text-green-400">+{usd(row.after_tax_gain)}</span> after taxes</>}</> })
        }
        // Runner trail — only once every target has hit.
        const runner = r.runner
        const units = isQuantity(pos.instrument_type) ? Number(pos.shares) : Number(pos.contracts)
        const unitNow = units > 0 ? calc.current_value / units : null
        if (runner?.trail_unit_value != null && unitNow != null && (rows ?? []).length > 0
          && rows.every((x) => x.hit) && unitNow <= runner.trail_unit_value) {
          out.push({ rank: 1, tone: 'amber', pos, title: `${nameOf(pos)}: runner trail hit`,
            body: `Down ${Math.round(runner.trail_pct * 100)}% from its peak — the plan sells the runner.` })
        }
        if (stop?.level === 'warn') {
          const months = Math.max(1, Math.round(stop.dte / 30.44))
          out.push({ rank: 2, tone: 'amber', pos, title: `${nameOf(pos)}: roll window open`,
            body: `${months} months to expiry. Exit or roll before 6 months are left.` })
        }
        // Long-term soon and worth waiting for.
        if (calc.is_long_term === false && calc.tax_saved_by_waiting > 0 && calc.days_until_long_term <= 60
          && longTermFitsPlan(calc.long_term_date, isQuantity(pos.instrument_type) ? null : pos.expiration, plan)) {
          out.push({ rank: 3, tone: 'green', pos, title: `${nameOf(pos)} goes long-term in ${calc.days_until_long_term} days`,
            body: <>Waiting saves about <span className="font-mono-tab text-green-400">{usd(calc.tax_saved_by_waiting)}</span> in tax.</> })
        }
      }
    }
    // Prices entered by hand go stale.
    const stale = (positions ?? []).filter((x) => x.instrument_type !== 'cash' && x.value_as_of
      && (Date.now() - new Date(x.value_as_of).getTime()) / DAY_MS > STALE_DAYS)
    if (stale.length) {
      out.push({ rank: 4, tone: 'neutral', title: `Update ${stale.length} price${stale.length === 1 ? '' : 's'}`,
        body: `${stale.slice(0, 3).map(nameOf).join(', ')}${stale.length > 3 ? '…' : ''} last priced over ${STALE_DAYS} days ago.` })
    }
    return out.sort((a, b) => a.rank - b.rank)
  }, [results, positions, plan, today])

  // ── Next exit targets: the closest unhit target per holding ──
  const nextUp = useMemo(() => results
    .filter((r) => r.calc && !isRoc(r.pos))
    .map((r) => {
      const row = (r.custom?.length ? r.custom : r.ladder)?.find((x) => !x.hit && x.contracts !== 0)
      if (!row || !(r.calc.current_value > 0)) return null
      return { r, row, needs: row.exit_value / r.calc.current_value - 1 }
    })
    .filter(Boolean)
    .sort((a, b) => a.needs - b.needs)
    .slice(0, 3), [results])

  // ── Goals ────────────────────────────────────────────────────
  const withGoal = results.filter((r) => r.calc?.target_progress != null && !isRoc(r.pos))
  const reached = withGoal.filter((r) => r.calc.target_progress >= 1)
  const closest = withGoal.filter((r) => r.calc.target_progress < 1).sort((a, b) => b.calc.target_progress - a.calc.target_progress)[0]

  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <header className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold">Home</h1>
        <div className="flex items-center gap-2">
          <NotificationCenter />
          <button type="button" onClick={() => navigate('/settings')} aria-label="Settings"
            className="lg:hidden relative w-11 h-11 bg-card border border-border rounded-xl flex items-center justify-center text-muted hover:text-fg transition-colors">
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>

      {loading ? (
        <div className="text-xs text-muted py-8 text-center">Loading…</div>
      ) : !hasHoldings ? (
        <section className="bg-card border border-amber-400/30 rounded-2xl p-5 mb-5">
          <h2 className="text-base font-semibold mb-1">Welcome to Cash Moves</h2>
          <p className="text-sm text-subtle mb-4">Add what you own to see it after tax, with an exit plan for every holding.</p>
          <Link to="/leaps?add=1" className="min-h-[44px] inline-flex items-center gap-1.5 px-4 rounded-lg bg-amber-400 text-bg text-sm font-semibold">
            <Plus size={14} /> Add your first holding
          </Link>
        </section>
      ) : (
        <>
          {/* Net worth after tax, with before tax beside it. */}
          <Link to="/leaps" className="block bg-card border border-amber-400/30 rounded-2xl p-5 mb-5 hover:bg-card-hover/40 transition">
            {!ready || !federal ? (
              <p className="text-sm text-subtle">Add your tax details in Settings to see your holdings after tax.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-muted mb-1 truncate">Net worth after tax</div>
                    <div className={clsx('text-2xl font-semibold font-mono-tab truncate', after >= 0 ? 'text-green-400' : 'text-rose-300')}>{usd(after)}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-muted mb-1 truncate">Before tax</div>
                    <div className="text-2xl font-semibold font-mono-tab text-amber-300 truncate">{usd(before)}</div>
                  </div>
                </div>
                {summary && (
                  <div className="mt-3 text-sm text-subtle flex items-center">
                    <span className="flex-1">
                      Investments <span className={clsx('font-mono-tab', summary.after_tax_gain < 0 ? 'text-rose-300' : 'text-green-400')}>{pctSigned(summary.after_tax_return_pct)}</span> after tax
                    </span>
                    <span className="text-xs text-muted inline-flex items-center">Positions <ChevronRight size={14} /></span>
                  </div>
                )}
              </>
            )}
          </Link>

          {ready && (
            <>
              {/* Needs action */}
              <section className="bg-card border border-border rounded-2xl p-5 mb-5">
                <h2 className="text-sm font-semibold mb-3">Needs action</h2>
                {actions.length === 0 ? (
                  <p className="text-sm text-subtle">Nothing today. Your plan is on track.</p>
                ) : (
                  <ol className="space-y-3">
                    {actions.map((a, i) => (
                      <li key={i}>
                        <Link to="/leaps" className="flex items-start gap-3 min-h-[44px]">
                          <span className={clsx('mt-1.5 h-2 w-2 rounded-full shrink-0', {
                            'bg-rose-400': a.tone === 'red', 'bg-green-400': a.tone === 'green',
                            'bg-amber-400': a.tone === 'amber', 'bg-subtle': a.tone === 'neutral',
                          })} aria-hidden />
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm text-fg">{a.title}</span>
                            <span className="block text-xs text-muted mt-0.5">{a.body}</span>
                          </span>
                          <ChevronRight size={14} className="mt-1 text-muted shrink-0" aria-hidden />
                        </Link>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {/* Next exit targets */}
              {nextUp.length > 0 && (
                <section className="bg-card border border-border rounded-2xl p-5 mb-5">
                  <h2 className="text-sm font-semibold mb-3">Next exit targets</h2>
                  <ol className="space-y-4">
                    {nextUp.map(({ r, row, needs }) => (
                      <li key={r.pos.id}>
                        <Link to="/leaps" className="block">
                          <div className="flex items-baseline gap-3">
                            <span className="flex-1 min-w-0 text-sm text-fg truncate">{nameOf(r.pos)} · {gainLabel(row)}</span>
                            <span className="text-sm font-mono-tab font-semibold text-fg">{usd(row.exit_value)}</span>
                          </div>
                          <div className="text-xs text-muted mt-0.5">
                            Needs <span className="font-mono-tab text-fg">{pctSigned(needs)}</span> from here · sell <span className="text-amber-300">{sellCount(row, r.pos)}</span>
                          </div>
                          <div className="mt-2 h-1.5 rounded bg-faint overflow-hidden">
                            <div className="h-full bg-amber-400" style={{ width: `${Math.round((row.progress ?? 0) * 100)}%` }} />
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {/* Goals + income */}
              {(withGoal.length > 0 || others.income > 0) && (
                <section className="bg-card border border-border rounded-2xl p-5 mb-5 grid grid-cols-2 gap-4">
                  {withGoal.length > 0 && (
                    <div className="min-w-0">
                      <div className="text-xs text-muted mb-1">After-tax goals</div>
                      <div className="text-sm font-mono-tab text-fg">{reached.length} of {withGoal.length} reached</div>
                      {closest && (
                        <div className="text-xs text-muted mt-0.5 truncate">
                          Closest: {nameOf(closest.pos)} · {Math.round(closest.calc.target_progress * 100)}%
                        </div>
                      )}
                    </div>
                  )}
                  {others.income > 0 && (
                    <div className="min-w-0">
                      <div className="text-xs text-muted mb-1">Income after tax</div>
                      <div className="text-sm font-mono-tab text-green-400">{usd(others.income)}/yr</div>
                      <div className="text-xs text-muted mt-0.5">≈ {usd(others.income / 12)}/mo</div>
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {/* Quick actions */}
          <div className="grid grid-cols-3 gap-2 mb-5">
            <QuickAction to="/leaps?add=1" icon={Plus} label="Add holding" />
            <QuickAction to="/leaps" icon={RefreshCw} label="Update prices" />
            <QuickAction to="/simulator" icon={Calculator} label="Simulator" />
          </div>

          <p className="text-xs text-muted">
            All tax figures are estimates, not tax advice. Consult a tax professional before acting on them.
          </p>
        </>
      )}
    </div>
  )
}

function QuickAction({ to, icon: Icon, label }) {
  return (
    <Link to={to} className="min-h-[64px] rounded-xl border border-border bg-card flex flex-col items-center justify-center gap-1 text-xs text-subtle hover:text-fg hover:border-amber-400/40 transition">
      <Icon size={16} className="text-amber-400" aria-hidden />
      {label}
    </Link>
  )
}
