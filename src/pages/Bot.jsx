import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useHoldings } from '../hooks/useHoldings'
import { todayYmd } from '../utils/afterTax'
import { dailyDecisions } from '../lib/holdingChecks'

// The LEAPS bot — what it checks every day and what it has done.
// Today's checks run the exit playbook on the app's numbers (the same
// checks as Home's Needs action), one decision per holding, from the
// last entered prices. History is the engine's append-only audit log
// (ldp_audit_log): trades, suggestions, skips and holds, newest first.
// Self-directed accounts only ever get suggestions.

const TONE_DOT = {
  red: 'bg-rose-400', green: 'bg-green-400', amber: 'bg-amber-400', neutral: 'bg-subtle',
}
const VERDICT_TONE = {
  red: 'text-rose-300 border-rose-400/40 bg-rose-400/10',
  green: 'text-green-300 border-green-400/40 bg-green-400/10',
  amber: 'text-amber-300 border-amber-400/40 bg-amber-400/10',
  neutral: 'text-subtle border-border bg-bg-elev',
}
const KIND_LABEL = { trade: 'Traded', suggestion: 'Suggested', skip: 'Skipped', hold: 'Held' }
const TIER_LABEL = { conservative: 'Conservative', moderate: 'Moderate', aggressive: 'Aggressive' }
const when = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export default function Bot() {
  const { user } = useAuth()
  const { positions, plan, ready, results } = useHoldings()
  const [risk, setRisk] = useState(undefined)
  const [log, setLog] = useState(null)
  const today = todayYmd()

  useEffect(() => {
    if (!user) return
    let live = true
    supabase.from('ldp_risk_profiles').select('tier, account_tier').eq('user_id', user.id).maybeSingle()
      .then(({ data }) => { if (live) setRisk(data ?? null) })
    supabase.from('ldp_audit_log').select('id, recorded_at, kind, action, ticker, sell_rule, permission_mode')
      .order('recorded_at', { ascending: false }).limit(50)
      .then(({ data, error }) => { if (live) setLog(error ? [] : data ?? []) })
    return () => { live = false }
  }, [user])

  const decisions = useMemo(() => (ready ? dailyDecisions(results, plan, today) : []), [ready, results, plan, today])
  const acting = decisions.filter((d) => d.kind !== 'hold').length
  const managed = risk?.account_tier === 'managed'

  return (
    <div className="px-4 py-4 pb-24 max-w-md mx-auto">
      <header className="flex items-center gap-2 mb-5">
        <Link to="/" aria-label="Back to Home" className="-ml-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted hover:text-fg">
          <ChevronLeft size={18} />
        </Link>
        <h1 className="text-lg font-semibold">LEAPS bot</h1>
      </header>

      {/* How it runs for this account. */}
      <section className="bg-card border border-amber-400/30 rounded-2xl p-5 mb-5">
        <div className="grid grid-cols-2 gap-4">
          <div className="min-w-0">
            <div className="text-xs text-muted mb-1">Mode</div>
            <div className="text-sm font-semibold text-fg">{managed ? 'Places trades' : 'Suggests only'}</div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted mb-1">Risk tier</div>
            <div className="text-sm font-semibold text-fg">{risk === undefined ? '…' : TIER_LABEL[risk?.tier] ?? 'Not set'}</div>
          </div>
        </div>
        <p className="mt-4 text-sm text-subtle">
          {managed
            ? 'It checks every holding daily and sells by your exit plan.'
            : 'It checks every holding daily against your exit plan and tells you what to do. You place the trades.'}
          {' '}Until your broker is connected, checks use your last entered prices.
        </p>
        {risk === null && (
          <Link to="/leaps/onboarding" className="mt-4 min-h-[44px] inline-flex items-center px-4 rounded-lg bg-amber-400 text-bg text-sm font-semibold">
            Set your risk profile
          </Link>
        )}
      </section>

      {/* Today's checks */}
      <section className="bg-card border border-border rounded-2xl p-5 mb-5">
        <div className="flex items-baseline gap-2 mb-3">
          <h2 className="flex-1 text-sm font-semibold">Today's checks</h2>
          {decisions.length > 0 && (
            <span className="text-xs text-muted">{acting === 0 ? 'Nothing to act on' : `${acting} to act on`}</span>
          )}
        </div>
        {positions === null ? (
          <p className="text-sm text-subtle">Loading…</p>
        ) : !ready ? (
          <p className="text-sm text-subtle">Add your tax details in Settings so the bot can check your holdings.</p>
        ) : decisions.length === 0 ? (
          <p className="text-sm text-subtle">No investments to check yet.</p>
        ) : (
          <ol className="space-y-3">
            {decisions.map((d) => (
              <li key={d.pos.id}>
                <Link to={`/leaps?open=${d.pos.id}`} className="flex items-start gap-3 min-h-[44px]">
                  <span className={clsx('mt-1.5 h-2 w-2 rounded-full shrink-0', TONE_DOT[d.tone])} aria-hidden />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-fg">{d.title}</span>
                    <span className="block text-xs text-muted mt-0.5">{d.body}</span>
                  </span>
                  <span className={clsx('shrink-0 mt-0.5 text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded-md border', VERDICT_TONE[d.tone])}>
                    {d.verdict}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* What the engine has recorded */}
      <section className="bg-card border border-border rounded-2xl p-5 mb-5">
        <h2 className="text-sm font-semibold mb-3">History</h2>
        {log === null ? (
          <p className="text-sm text-subtle">Loading…</p>
        ) : log.length === 0 ? (
          <p className="text-sm text-subtle">Nothing yet. Every trade, suggestion and hold the bot makes is recorded here for good.</p>
        ) : (
          <ol className="space-y-3">
            {log.map((e) => (
              <li key={e.id} className="flex items-start gap-3">
                <span className="w-16 shrink-0 text-xs text-muted pt-0.5">{when(e.recorded_at)}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-fg">{KIND_LABEL[e.kind] ?? e.kind} · {e.ticker}</span>
                  <span className="block text-xs text-muted mt-0.5">{e.action}{e.sell_rule ? ` · ${e.sell_rule.replace(/_/g, ' ')}` : ''}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Link to="/charts" className="flex items-center gap-2 min-h-[44px] text-sm text-subtle hover:text-fg">
        <span className="flex-1">See your holdings on Charts</span>
        <ChevronRight size={14} aria-hidden />
      </Link>
    </div>
  )
}
