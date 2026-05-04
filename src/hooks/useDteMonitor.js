import { useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Once-per-day-per-session check: scans active real-money signals with an
// expiry_date, and emits an in-app `stop_loss_triggered` alert when DTE drops
// below the 21-day floor (Rules.jsx says never under 21 DTE). Idempotent on
// (signal_id, alert_type, today) so refreshing doesn't spawn duplicates.
//
// NOTE: this is a DTE warning, not the real -50% option-price stop loss.
// The latter requires a live option price feed which is not yet wired up.
// `StopLossCheck` remains the manual decision tool until that lands.

const STORAGE_KEY = 'pharmaEdge:lastDteCheck'
const DTE_FLOOR = 21
const ALERT_TYPE = 'stop_loss_triggered'

export function useDteMonitor() {
  const { user } = useAuth()

  useEffect(() => {
    if (!user?.id) return

    const today = new Date().toISOString().slice(0, 10)
    const last = localStorage.getItem(STORAGE_KEY)
    if (last === today) return

    let cancelled = false
    ;(async () => {
      try {
        await runCheck(user.id, today)
        if (!cancelled) localStorage.setItem(STORAGE_KEY, today)
      } catch (err) {
        // Don't update the storage key — let it retry next mount.
        console.warn('useDteMonitor:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [user?.id])
}

async function runCheck(userId, today) {
  const { data: signals } = await supabase
    .from('signals')
    .select('id, ticker, expiry_date, logged_at')
    .eq('user_id', userId)
    .eq('status', 'active')
    .eq('trade_type', 'real')
    .not('expiry_date', 'is', null)

  if (!signals?.length) return

  const todayMs = Date.parse(`${today}T00:00:00Z`)
  for (const signal of signals) {
    if (!signal.expiry_date) continue
    const expiryMs = Date.parse(`${signal.expiry_date}T00:00:00Z`)
    const dte = Math.floor((expiryMs - todayMs) / 86_400_000)
    if (dte >= DTE_FLOOR) continue

    // Idempotency: skip if we've already logged a DTE-warning alert for this
    // signal today.
    const startOfDay = `${today}T00:00:00Z`
    const endOfDay = `${today}T23:59:59.999Z`
    const { data: existing } = await supabase
      .from('alerts')
      .select('id')
      .eq('user_id', userId)
      .eq('signal_id', signal.id)
      .eq('alert_type', ALERT_TYPE)
      .gte('sent_at', startOfDay)
      .lte('sent_at', endOfDay)
      .limit(1)
    if (existing?.length) continue

    await supabase.from('alerts').insert({
      user_id: userId,
      signal_id: signal.id,
      alert_type: ALERT_TYPE,
      sent_via: 'in_app',
      message: `${signal.ticker}: DTE has fallen to ${dte} day${dte === 1 ? '' : 's'} (rule floor is ${DTE_FLOOR}). Review the position.`,
    })
  }
}
