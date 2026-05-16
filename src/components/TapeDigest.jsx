import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, TrendingUp, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import clsx from 'clsx'

// "Since you were away" — the line between a dashboard and a tape.
//
// Surfaces deltas the user would otherwise have to reconstruct by
// reading every card: things that fired against their positions
// (alerts) and regime flips on the names they actually watch
// (scanner_reasoning trail). Both already exist server-side; this is
// purely a read-side roll-up keyed off the last time the user opened
// the Tape.
//
// "Last seen" is a per-user localStorage timestamp, deliberately NOT a
// DB column: this is a glanceable convenience, not an audited record,
// and a client-only marker keeps it zero-cost and private. Renders
// nothing when there's no prior-visit baseline or no deltas — same
// "empty = invisible" discipline as the rest of the Tape.

const LOOKBACK_HOURS = 24

function lastSeenKey(userId) {
  return `cm_tape_seen_${userId}`
}

export default function TapeDigest() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [alerts, setAlerts] = useState([])
  const [flips, setFlips] = useState([])
  const [sinceMs, setSinceMs] = useState(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false

    // Read the PRIOR visit's timestamp (the baseline the digest is
    // computed against), then immediately stamp this visit so the
    // next open compares against now. No prior value → first ever
    // visit, nothing to diff: render nothing.
    const key = lastSeenKey(user.id)
    const prior = Number(window.localStorage.getItem(key)) || null
    window.localStorage.setItem(key, String(Date.now()))
    if (!prior) return
    setSinceMs(prior)

    const priorIso = new Date(prior).toISOString()
    const lookbackIso = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString()

    async function load() {
      const [alertRes, wlRes] = await Promise.all([
        supabase
          .from('alerts')
          .select('id, alert_type, message, signal_id, sent_at')
          .eq('user_id', user.id)
          .gt('sent_at', priorIso)
          .order('sent_at', { ascending: false })
          .limit(6),
        supabase.from('watchlist').select('ticker').eq('user_id', user.id),
      ])
      if (cancelled) return
      setAlerts(alertRes.data ?? [])

      const tickers = Array.from(
        new Set((wlRes.data ?? []).map((r) => String(r.ticker).toUpperCase())),
      ).filter(Boolean)
      if (tickers.length === 0) {
        setFlips([])
        return
      }

      // Pull the scanner regime trail for watched names across the
      // lookback window, then per ticker diff the latest regime vs
      // the regime as-of the user's prior visit. Only a row at/before
      // the prior visit establishes a valid "from" — without one we
      // can't claim a flip (avoids false positives on names that only
      // started scanning after the user left).
      const { data: sr } = await supabase
        .from('scanner_reasoning')
        .select('ticker, regime, computed_at')
        .in('ticker', tickers)
        .gte('computed_at', lookbackIso)
        .order('computed_at', { ascending: true })
      if (cancelled) return

      const byTicker = new Map()
      for (const row of sr ?? []) {
        if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, [])
        byTicker.get(row.ticker).push(row)
      }
      const detected = []
      for (const [tk, rows] of byTicker) {
        const latest = rows[rows.length - 1]
        let baseline = null
        for (const r of rows) {
          if (new Date(r.computed_at).getTime() <= prior) baseline = r
          else break
        }
        if (baseline && latest && baseline.regime !== latest.regime) {
          detected.push({ ticker: tk, from: baseline.regime, to: latest.regime })
        }
      }
      setFlips(detected)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [user?.id])

  if (dismissed || sinceMs == null) return null
  if (alerts.length === 0 && flips.length === 0) return null

  const agoLabel = formatAgo(Date.now() - sinceMs)

  return (
    <section className="surface rounded-2xl p-4 mb-5 border border-amber-400/15">
      <div className="flex items-center justify-between mb-3">
        <p className="eyebrow text-[#f4cf8e]">Since you were away · {agoLabel}</p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="text-muted hover:text-fg transition-colors -mr-1"
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-2">
        {flips.map((f) => (
          <button
            key={`flip-${f.ticker}`}
            onClick={() => navigate(`/reasoning?t=${f.ticker}`)}
            className="w-full flex items-center gap-3 text-left bg-bg-elev/40 hover:bg-bg-elev rounded-xl p-3 transition"
          >
            <div className="w-7 h-7 shrink-0 rounded-lg bg-amber-400/10 flex items-center justify-center text-amber-400">
              <TrendingUp size={14} strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-fg text-sm font-semibold">
                {f.ticker} regime shifted
              </p>
              <p className="text-subtle text-[11px] mt-0.5">
                <RegimeTag r={f.from} /> → <RegimeTag r={f.to} /> on the 30-min scan
              </p>
            </div>
          </button>
        ))}

        {alerts.map((a) => (
          <button
            key={`alert-${a.id}`}
            onClick={() =>
              navigate(a.signal_id ? `/signal/${a.signal_id}` : '/settings')
            }
            className="w-full flex items-center gap-3 text-left bg-bg-elev/40 hover:bg-bg-elev rounded-xl p-3 transition"
          >
            <div className="w-7 h-7 shrink-0 rounded-lg bg-amber-400/10 flex items-center justify-center text-amber-400">
              <Bell size={13} strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-fg text-sm font-medium line-clamp-2">
                {a.message || prettyAlertType(a.alert_type)}
              </p>
              <p className="text-muted text-[10px] mt-0.5">
                {prettyAlertType(a.alert_type)} ·{' '}
                {new Date(a.sent_at).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </p>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

function RegimeTag({ r }) {
  const map = {
    A: 'text-green-400',
    B: 'text-[#f25068]',
    mixed: 'text-[#f4cf8e]',
  }
  return (
    <span className={clsx('font-semibold', map[r] || 'text-subtle')}>
      {r === 'mixed' ? 'Mixed' : `Regime ${r}`}
    </span>
  )
}

function prettyAlertType(t) {
  if (!t) return 'Alert'
  return String(t)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatAgo(ms) {
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) {
    const rem = mins % 60
    return rem === 0 ? `${hrs}h ago` : `${hrs}h ${rem}m ago`
  }
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
