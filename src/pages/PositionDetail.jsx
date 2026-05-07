import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, X, AlertTriangle, RefreshCw, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import Spinner from '../components/Spinner'

// Detail view for a single open_position. Shows entry, live mid, P&L,
// triggered alerts, and a "Close Position" flow that submits an inverse
// debit/credit spread to record the close (and hashes the outcome via
// the existing outcome flow when the position is linked to a signal).
//
// Manual close path (no broker call): user enters an exit credit and
// taps Save — we update the row to status='closed' and compute the
// realized P&L. This is the path most users will take if they're
// trading on Robinhood / outside the app.

export default function PositionDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [pos, setPos] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Auto-open the close form when arriving via OpenPositions row X.
  const [closeMode, setCloseMode] = useState(searchParams.get('close') === '1')
  const [exitCredit, setExitCredit] = useState('')
  const [closing, setClosing] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('open_positions')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }
    if (!data) {
      setError('Position not found.')
      return
    }
    setPos(data)
    if (data.last_mid_per_spread != null) {
      setExitCredit(String(data.last_mid_per_spread))
    }
  }

  useEffect(() => {
    if (id) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function handleClose() {
    if (!pos || !exitCredit) return
    const credit = Number(exitCredit)
    if (!Number.isFinite(credit) || credit < 0) {
      setError('Exit credit must be a positive number')
      return
    }
    setClosing(true)
    setError(null)

    const realized =
      (credit - pos.entry_debit_per_spread) * pos.contracts * 100
    const { error: updateErr } = await supabase
      .from('open_positions')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        exit_credit_per_spread: credit,
        realized_pnl: realized,
      })
      .eq('id', pos.id)
    setClosing(false)
    if (updateErr) {
      setError(updateErr.message)
      return
    }
    await load()
    setCloseMode(false)
  }

  if (loading) {
    return (
      <div className="px-4 lg:px-6 py-12 max-w-md lg:max-w-3xl mx-auto flex items-center justify-center gap-2">
        <Spinner size="md" />
        <span className="text-xs text-subtle">Loading position…</span>
      </div>
    )
  }

  if (error && !pos) {
    return (
      <div className="px-4 lg:px-6 py-6 max-w-md lg:max-w-3xl mx-auto space-y-3">
        <button
          onClick={() => navigate(-1)}
          className="text-xs text-subtle hover:text-fg inline-flex items-center gap-1"
        >
          <ArrowLeft size={12} /> Back
        </button>
        <p className="text-sm text-crimson">{error}</p>
      </div>
    )
  }

  if (!pos) return null

  const dte = daysUntil(pos.expiration)
  const pnl = pos.last_pnl_pct
  const pnlTone =
    pnl == null ? 'text-fg' : pnl >= 0 ? 'text-green-400' : 'text-crimson'
  const triggers = Object.entries(pos.triggers_fired || {})

  return (
    <div className="px-4 lg:px-6 py-5 max-w-md lg:max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 text-subtle hover:text-fg"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold leading-tight">{pos.ticker}</h1>
          <p className="text-xs text-subtle">
            {pos.strategy_type.replace(/_/g, ' ')} · {pos.contracts} contract
            {pos.contracts > 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={load}
          className="p-2 text-subtle hover:text-fg"
          aria-label="Refresh"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Spread
            </div>
            <div className="font-mono-tab text-base font-medium">
              ${formatStrike(pos.long_strike)} / ${formatStrike(pos.short_strike)}
            </div>
            <div className="text-[10px] text-subtle">
              {pos.expiration} · <span className={dte <= 21 ? 'text-amber-400' : ''}>{dte}d</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Live P&L
            </div>
            <div className={`text-2xl font-mono-tab font-semibold ${pnlTone}`}>
              {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}%` : '—'}
            </div>
            <div className="text-[10px] text-subtle">
              {pos.last_polled_at ? agoString(pos.last_polled_at) : 'awaiting first poll'}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-border">
          <Stat label="Entry debit" value={`$${fmt(pos.entry_debit_per_spread)}`} />
          <Stat label="Current mid" value={pos.last_mid_per_spread != null ? `$${fmt(pos.last_mid_per_spread)}` : '—'} />
          <Stat
            label="Total risk"
            value={`$${fmt(pos.entry_debit_per_spread * pos.contracts * 100)}`}
            tone="neg"
          />
          <Stat
            label="Live value"
            value={pos.last_mid_per_spread != null ? `$${fmt(pos.last_mid_per_spread * pos.contracts * 100)}` : '—'}
          />
        </div>

        <div className="text-[10px] text-muted">
          Source: {pos.last_poll_source ?? 'pending'}
          {pos.last_poll_source === 'yahoo' && ' (15-min delayed)'}
        </div>
      </div>

      {triggers.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            Triggers fired
          </div>
          {triggers.map(([type, ts]) => (
            <div key={type} className="flex items-center gap-2 text-xs">
              <AlertTriangle size={12} className="text-amber-400" />
              <span className="text-fg">{niceTriggerLabel(type)}</span>
              <span className="text-muted ml-auto">{agoString(ts)}</span>
            </div>
          ))}
        </div>
      )}

      {pos.thesis && (
        <div className="bg-card border border-border rounded-xl p-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            Thesis
          </div>
          <p className="text-xs text-subtle leading-relaxed">{pos.thesis}</p>
        </div>
      )}

      {pos.status === 'open' && !closeMode && (
        <button
          onClick={() => setCloseMode(true)}
          className="w-full bg-amber-400 hover:bg-amber-300 text-bg font-semibold rounded-xl py-3 text-sm transition"
        >
          Close Position
        </button>
      )}

      {pos.status === 'open' && closeMode && (
        <div className="bg-card border border-amber-400/40 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <X size={14} className="text-amber-400" />
            <h3 className="text-sm font-semibold">Close at exit credit</h3>
          </div>
          <p className="text-[11px] text-subtle leading-relaxed">
            Enter the credit per spread you received (or expect to receive)
            on close. Realized P&L is computed automatically across all{' '}
            {pos.contracts} contracts.
          </p>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">
              Exit credit per spread ($)
            </label>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={exitCredit}
              onChange={(e) => setExitCredit(e.target.value)}
              className={inputClass}
            />
          </div>
          {exitCredit && Number.isFinite(Number(exitCredit)) && (
            <PreviewRealized
              entry={pos.entry_debit_per_spread}
              exit={Number(exitCredit)}
              contracts={pos.contracts}
            />
          )}
          {error && (
            <div className="bg-red-950/30 border border-red-900/50 text-red-400 text-xs rounded p-2">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => setCloseMode(false)}
              className="flex-1 bg-bg-elev border border-border text-fg text-sm font-medium rounded-lg py-2"
            >
              Cancel
            </button>
            <button
              onClick={handleClose}
              disabled={closing || !exitCredit}
              className="flex-1 bg-amber-400 text-bg text-sm font-semibold rounded-lg py-2 hover:bg-amber-300 disabled:opacity-50"
            >
              {closing ? 'Closing…' : 'Confirm Close'}
            </button>
          </div>
        </div>
      )}

      {pos.status !== 'open' && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Check size={14} className="text-green-400" />
            <h3 className="text-sm font-semibold capitalize">{pos.status}</h3>
          </div>
          <Stat label="Closed at" value={pos.closed_at ? new Date(pos.closed_at).toLocaleString() : '—'} />
          <Stat label="Exit credit" value={pos.exit_credit_per_spread != null ? `$${fmt(pos.exit_credit_per_spread)}` : '—'} />
          <Stat
            label="Realized P&L"
            value={pos.realized_pnl != null ? `${pos.realized_pnl >= 0 ? '+' : ''}$${fmt(pos.realized_pnl)}` : '—'}
            tone={pos.realized_pnl != null && pos.realized_pnl >= 0 ? 'pos' : 'neg'}
          />
        </div>
      )}
    </div>
  )
}

function PreviewRealized({ entry, exit, contracts }) {
  const realized = (exit - entry) * contracts * 100
  const tone = realized >= 0 ? 'text-green-400' : 'text-crimson'
  return (
    <div className="bg-bg-elev border border-border rounded-md p-2 text-xs">
      <span className="text-muted">Realized P&L: </span>
      <span className={`font-mono-tab font-semibold ${tone}`}>
        {realized >= 0 ? '+' : ''}${fmt(realized)}
      </span>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const toneClass =
    tone === 'pos' ? 'text-green-400' : tone === 'neg' ? 'text-crimson' : 'text-fg'
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <span className={`font-mono-tab text-xs font-medium ${toneClass}`}>{value}</span>
    </div>
  )
}

const inputClass =
  'w-full bg-bg border border-border text-fg rounded-md py-1.5 px-2 text-sm focus:outline-none focus:border-amber-400/40'

function fmt(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(2)
}

function formatStrike(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n >= 1000 ? n.toFixed(0) : n.toFixed(1)
}

function daysUntil(date) {
  if (!date) return 0
  const d = new Date(date + 'T00:00:00Z').getTime()
  return Math.max(0, Math.ceil((d - Date.now()) / 86_400_000))
}

function agoString(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function niceTriggerLabel(type) {
  switch (type) {
    case 'position_stop_loss': return 'Stop loss (−50%)'
    case 'position_profit_50': return 'Profit +50%'
    case 'position_profit_100': return 'Profit +100%'
    case 'position_profit_200': return 'Profit +200%'
    case 'position_dte_21': return '21 DTE crossed'
    case 'position_expiring_tomorrow': return 'Expiring tomorrow'
    default: return type
  }
}
