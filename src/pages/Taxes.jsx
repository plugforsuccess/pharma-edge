import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { useHoldings } from '../hooks/useHoldings'
import RateBreakdown from '../components/RateBreakdown'
import { usd, nameOf } from '../lib/holdingChecks'

// Taxes — what you'd owe, and what timing can save. Everything comes from
// useHoldings (the same numbers as Portfolio and Home): the tax if every
// holding sold today (gains netted the way Schedule D does — an
// estimate), holdings about to turn long-term and what waiting saves,
// losses that could offset gains, tax on this year's income, and the
// rates behind it all.

const shortDate = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const ORDINARY_LOSS_LIMIT = 3000
const rate = (n) => (Number.isFinite(n) ? `${+(n * 100).toFixed(1)}%` : '—')

export default function Taxes() {
  const { federal, state, positions, ready, results, cashResults, realEstateResults, summary, breakdown, has1256 } = useHoldings()

  const sale = useMemo(() => {
    let st = 0
    let lt = 0
    let s1256 = 0
    let losses = 0
    for (const { calc } of results) {
      if (!calc) continue
      if (calc.gain < 0) losses += calc.gain
      else if (calc.tax_character === 'section_1256') s1256 += calc.gain
      else if (calc.is_long_term) lt += calc.gain
      else st += calc.gain
    }
    const reTax = realEstateResults.reduce((s, r) => s + (r.re?.estimated_tax ?? 0), 0)
    const investTax = summary?.netted?.estimated_tax ?? 0
    const gains = st + lt + s1256 + losses
    return { st, lt, s1256, losses, reTax, investTax, total: investTax + reTax, gains }
  }, [results, realEstateResults, summary])

  const soonLongTerm = useMemo(() => results
    .filter((r) => r.calc?.is_long_term === false && r.calc.gain > 0 && r.calc.tax_saved_by_waiting > 0)
    .sort((a, b) => a.calc.days_until_long_term - b.calc.days_until_long_term), [results])

  // A loss only cuts tax up to the gains it offsets (plus the $3,000
  // ordinary deduction); the rest carries forward. Biggest losses first.
  const lossRows = useMemo(() => {
    let room = Math.max(0, sale.st + sale.lt + sale.s1256) + ORDINARY_LOSS_LIMIT
    return results
      .filter((r) => r.calc && r.calc.gain < 0)
      .sort((a, b) => a.calc.gain - b.calc.gain)
      .map((r) => {
        const loss = -r.calc.gain
        const usable = Math.min(loss, room)
        room -= usable
        const ratePick = r.calc.is_long_term ? r.calc.long_term_rate : r.calc.short_term_rate
        return { r, loss, usable, offset: usable * ratePick }
      })
  }, [results, sale])

  const income = useMemo(() => {
    const div = results.reduce((s, r) => s + (r.dividend ? r.dividend.income - r.dividend.after_tax_income : 0), 0)
    const deferred = results.reduce((s, r) => s + (r.dividend?.deferred_tax ?? 0), 0)
    const cash = cashResults.reduce((s, r) => s + (r.cash.interest - r.cash.after_tax_interest), 0)
    return { div, cash, deferred, total: div + cash }
  }, [results, cashResults])

  const loading = positions === null

  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <header className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold">Taxes</h1>
      </header>

      {loading ? (
        <div className="text-xs text-muted py-8 text-center">Loading…</div>
      ) : !ready || !federal ? (
        <section className="bg-card border border-amber-400/30 rounded-2xl p-5">
          <p className="text-sm text-subtle mb-4">Add your tax details to see what you'd owe and what timing can save.</p>
          <Link to="/settings#tax" className="min-h-[44px] inline-flex items-center px-4 rounded-lg bg-amber-400 text-bg text-sm font-semibold">Add tax details</Link>
        </section>
      ) : (
        <>
          {/* If everything sold today */}
          <section className="bg-card border border-amber-400/30 rounded-2xl p-5 mb-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-muted mb-1 truncate">Tax if sold today</div>
                <div className="text-2xl font-semibold font-mono-tab text-fg truncate">{usd(sale.total)}</div>
              </div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-muted mb-1 truncate">Tax on income / yr</div>
                <div className="text-2xl font-semibold font-mono-tab text-fg truncate">{usd(income.total)}</div>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-hairline space-y-2">
              <Row label="Short-term gains" value={usd(sale.st)} />
              <Row label="Long-term gains" value={usd(sale.lt)} />
              {sale.s1256 > 0 && <Row label="§1256 gains (60/40)" value={usd(sale.s1256)} />}
              {sale.losses < 0 && <Row label="Losses (offset gains)" value={usd(sale.losses)} tone="text-rose-300" />}
              {sale.reTax > 0 && <Row label="Real estate tax at sale" value={usd(sale.reTax)} />}
            </div>
          </section>

          {/* Going long-term */}
          {soonLongTerm.length > 0 && (
            <section className="bg-card border border-border rounded-2xl p-5 mb-5">
              <h2 className="text-sm font-semibold mb-3">Waiting for long-term</h2>
              <ol className="space-y-3">
                {soonLongTerm.map(({ pos, calc }) => (
                  <li key={pos.id}>
                    <Link to="/leaps" className="block min-h-[44px]">
                      <div className="flex items-baseline gap-3 text-sm">
                        <span className="flex-1 min-w-0 truncate text-fg">{nameOf(pos)}</span>
                        <span className="font-mono-tab text-green-400">saves {usd(calc.tax_saved_by_waiting)}</span>
                      </div>
                      <div className="text-xs text-muted mt-0.5">
                        Long-term {shortDate(calc.long_term_date)} · {calc.days_until_long_term} days · {rate(calc.short_term_rate)} → {rate(calc.long_term_rate)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Losses */}
          {lossRows.length > 0 && (
            <section className="bg-card border border-border rounded-2xl p-5 mb-5">
              <h2 className="text-sm font-semibold mb-1">Losses you could use</h2>
              <p className="text-xs text-muted mb-3">Selling at a loss offsets gains. Buying it back within 30 days cancels the loss (wash sale).</p>
              <ol className="space-y-3">
                {lossRows.map(({ r, loss, usable, offset }) => (
                  <li key={r.pos.id}>
                    <Link to="/leaps" className="block min-h-[44px]">
                      <div className="flex items-baseline gap-3 text-sm">
                        <span className="flex-1 min-w-0 truncate text-fg">{nameOf(r.pos)}</span>
                        <span className="font-mono-tab text-rose-300">−{usd(loss)}</span>
                      </div>
                      <div className="text-xs text-muted mt-0.5">
                        {usable > 0
                          ? <>Could cut about <span className="font-mono-tab text-green-400">{usd(offset)}</span> of tax{usable < loss ? <> · {usd(loss - usable)} carries forward</> : null}</>
                          : 'No gains left to offset this year — the loss carries forward.'}
                      </div>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Income */}
          {(income.total > 0 || income.deferred > 0) && (
            <section className="bg-card border border-border rounded-2xl p-5 mb-5">
              <h2 className="text-sm font-semibold mb-3">Tax on income this year</h2>
              <div className="space-y-2">
                {income.div > 0 && <Row label="Dividends" value={usd(income.div)} />}
                {income.cash > 0 && <Row label="Cash interest" value={usd(income.cash)} />}
                {income.deferred > 0 && <Row label="Return of capital (due at sale)" value={usd(income.deferred)} tone="text-subtle" />}
              </div>
            </section>
          )}

          {breakdown && (
            <section className="bg-card border border-border rounded-2xl p-5 mb-5">
              <RateBreakdown rates={breakdown} state={state} taxYear={federal.tax_year} show1256={has1256} />
            </section>
          )}

          <p className="text-xs text-muted">
            All tax figures are estimates, not tax advice. Consult a tax professional before acting on them.
          </p>
        </>
      )}
    </div>
  )
}

function Row({ label, value, tone }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="flex-1 text-subtle">{label}</span>
      <span className={clsx('font-mono-tab', tone ?? 'text-fg')}>{value}</span>
    </div>
  )
}
