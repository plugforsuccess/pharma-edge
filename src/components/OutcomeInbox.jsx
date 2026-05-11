import { useCallback, useEffect, useState } from 'react'
import { CheckCircle, AlertCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import LogOutcomeModal from './LogOutcomeModal'

// Outcome inbox.
//
// When a position fully closes, the
// signals_autoclose_on_position_close trigger transitions
// signals.status from 'active' to 'closed'. But the canonical
// public-record contract still requires an OUTCOME row to capture
// what actually happened (thesis_correct, P&L, notes) — without
// that, the closed signal is a dangling reference: hash-anchored,
// publicly visible, but with no resolution attached.
//
// This card lives at the top of the dashboard's right rail (above
// OpenPositions). It surfaces every closed signal that doesn't yet
// have an outcomes row, prompting the user to log the result on
// their next visit. Hides itself when the inbox is empty.
//
// Idempotent re-runs of the close trigger are safe — once an
// outcomes row exists, the signal drops off this list.

export default function OutcomeInbox() {
  const { user } = useAuth()
  const [pending, setPending] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeSignal, setActiveSignal] = useState(null)

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    setError(null)
    try {
      // Pull every closed signal for this user along with its outcome
      // (if any). The !left embed ensures signals with no outcome row
      // still come back — we filter to those client-side. Cheaper than
      // a NOT EXISTS subquery and keeps the query as one round-trip.
      const { data, error: err } = await supabase
        .from('signals')
        .select('id, ticker, strategy_type, logged_at, expiration, long_strike, short_strike, status, outcomes(id)')
        .eq('user_id', user.id)
        .eq('status', 'closed')
        .order('logged_at', { ascending: false })
        .limit(20)
      if (err) throw err
      const awaiting = (data ?? []).filter((s) => !s.outcomes || s.outcomes.length === 0)
      setPending(awaiting)
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => { load() }, [load])

  // Realtime: a new outcomes row OR a new signal close lands → refresh.
  // Filter on user_id so we don't burn cycles on other users' events.
  useEffect(() => {
    if (!user) return
    const ch = supabase
      .channel(`outcome-inbox:${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'outcomes', filter: `user_id=eq.${user.id}` },
        () => load(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'signals', filter: `user_id=eq.${user.id}` },
        () => load(),
      )
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [user, load])

  if (loading) return null  // silent on first load; avoids flicker
  if (error) {
    return (
      <div className="bg-card border border-crimson/40 rounded-xl p-3 mb-4 text-[11px] text-crimson flex items-start gap-2">
        <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
        <div>Outcome inbox: {error}</div>
      </div>
    )
  }
  if (pending.length === 0) return null

  return (
    <>
      <div className="bg-card border border-amber-400/30 rounded-xl overflow-hidden mb-4">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-amber-400" />
            <h2 className="text-sm font-semibold">Log outcome</h2>
            <span className="text-xs text-subtle">{pending.length}</span>
          </div>
          <span className="text-[10px] uppercase tracking-wider text-muted">
            closed, awaiting result
          </span>
        </div>
        <div className="divide-y divide-border">
          {pending.map((s) => {
            const strikes =
              Number.isFinite(Number(s.long_strike)) && Number.isFinite(Number(s.short_strike))
                ? `${Number(s.long_strike)}/${Number(s.short_strike)}`
                : null
            return (
              <button
                key={s.id}
                onClick={() => setActiveSignal(s)}
                className="w-full px-4 py-3 flex items-baseline justify-between gap-2 hover:bg-bg/30 transition text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg">{s.ticker}</div>
                  <div className="text-[10px] text-subtle truncate">
                    {(s.strategy_type ?? '').replace(/_/g, ' ')}
                    {strikes && ` · ${strikes}`}
                    {s.expiration && ` · exp ${s.expiration}`}
                  </div>
                </div>
                <span className="text-[11px] text-amber-400 font-medium shrink-0">
                  Log →
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {activeSignal && (
        <LogOutcomeModal
          signal={activeSignal}
          onClose={() => setActiveSignal(null)}
          onComplete={() => {
            setActiveSignal(null)
            // Realtime sub will refetch; load() here is a belt-and-
            // suspenders refresh for the case where realtime is slow.
            load()
          }}
        />
      )}
    </>
  )
}
