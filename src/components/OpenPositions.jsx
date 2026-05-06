import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, TrendingUp, TrendingDown, Clock, AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Open Positions card on the Home dashboard. Pulls from public.open_positions
// (RLS-scoped to the current user), shows live P&L from the monitor-positions
// cron, and links each row into PositionDetail (/position/:id) for the close
// flow.
//
// "+" button opens AddPositionModal so users can track trades placed outside
// the app (Robinhood, manual). For trades placed via place-order the row gets
// auto-created on fill.

export default function OpenPositions() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)

  async function refetch() {
    if (!user) return
    setLoading(true)
    const { data } = await supabase
      .from('open_positions')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'open')
      .order('updated_at', { ascending: false })
    setPositions(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  return (
    <>
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between border-b border-border">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Open Positions</h2>
            {positions.length > 0 && (
              <span className="text-xs text-subtle">{positions.length}</span>
            )}
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
          >
            <Plus size={12} />
            Add
          </button>
        </div>

        <div className="divide-y divide-border">
          {loading && (
            <div className="px-4 py-6 text-xs text-subtle">Loading…</div>
          )}
          {!loading && positions.length === 0 && (
            <div className="px-4 py-6 text-xs text-subtle leading-relaxed">
              No open positions tracked. Tap <strong className="text-fg">Add</strong>{' '}
              to start tracking a spread, or log a signal from{' '}
              <strong className="text-fg">Markets → Suggested Plays</strong>.
            </div>
          )}
          {!loading &&
            positions.map((p) => (
              <PositionRow
                key={p.id}
                p={p}
                onClick={() => navigate(`/position/${p.id}`)}
              />
            ))}
        </div>
      </div>

      {showAdd && (
        <AddPositionModal
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false)
            refetch()
          }}
        />
      )}
    </>
  )
}

function PositionRow({ p, onClick }) {
  const dte = daysUntil(p.expiration)
  const pnl = p.last_pnl_pct
  const pnlTone =
    pnl == null ? 'text-subtle' : pnl >= 0 ? 'text-green-400' : 'text-crimson'
  const PnlIcon = pnl != null && pnl < 0 ? TrendingDown : TrendingUp
  const showStopWarning = pnl != null && pnl <= -50
  const showDteWarning = dte <= 21

  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 hover:bg-bg-elev transition flex items-center gap-3"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-fg">{p.ticker}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted">
            {p.strategy_type.replace(/_/g, ' ')}
          </span>
        </div>
        <div className="text-[11px] font-mono-tab text-subtle">
          ${formatStrike(p.long_strike)} / ${formatStrike(p.short_strike)} · {p.contracts}c
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted mt-0.5">
          <Clock size={9} className={showDteWarning ? 'text-amber-400' : ''} />
          <span className={showDteWarning ? 'text-amber-400' : ''}>{dte}d</span>
          <span>·</span>
          <span>{p.expiration}</span>
          {showStopWarning && (
            <>
              <span>·</span>
              <AlertTriangle size={9} className="text-crimson" />
              <span className="text-crimson">stop</span>
            </>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className={`text-sm font-mono-tab font-semibold flex items-center gap-1 justify-end ${pnlTone}`}>
          <PnlIcon size={11} />
          {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}%` : '—'}
        </div>
        <div className="text-[10px] text-muted">
          {p.last_polled_at ? agoString(p.last_polled_at) : 'awaiting poll'}
        </div>
      </div>
    </button>
  )
}

function AddPositionModal({ onClose, onSaved }) {
  const { user } = useAuth()
  const [form, setForm] = useState({
    ticker: '',
    strategy_type: 'BULL_CALL',
    long_strike: '',
    short_strike: '',
    expiration: '',
    contracts: '1',
    entry_debit_per_spread: '',
    thesis: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function update(k, v) {
    setForm((p) => ({ ...p, [k]: v }))
  }

  async function save() {
    setError(null)
    if (!user) return setError('not logged in')
    if (!form.ticker || !form.long_strike || !form.short_strike || !form.expiration || !form.entry_debit_per_spread) {
      return setError('all fields required')
    }
    setSaving(true)
    const { error: insertError } = await supabase.from('open_positions').insert({
      user_id: user.id,
      ticker: form.ticker.toUpperCase(),
      strategy_type: form.strategy_type,
      long_strike: Number(form.long_strike),
      short_strike: Number(form.short_strike),
      expiration: form.expiration,
      contracts: Math.max(1, parseInt(form.contracts, 10) || 1),
      entry_debit_per_spread: Number(form.entry_debit_per_spread),
      thesis: form.thesis || null,
      source: 'manual',
    })
    setSaving(false)
    if (insertError) {
      setError(insertError.message)
      return
    }
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-full max-w-md bg-bg-elev border-t border-border rounded-t-2xl p-4 space-y-3 max-h-[85vh] overflow-y-auto"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="pt-1 flex justify-center">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>
        <h2 className="text-base font-semibold text-fg">Add Position</h2>
        <p className="text-xs text-subtle leading-relaxed">
          Track a spread you placed via Tastytrade, Robinhood, or anywhere else.
          Monitor will poll the spread mid every 5 min and alert at Wiley Edge thresholds.
        </p>

        <Field label="Ticker">
          <input
            type="text"
            value={form.ticker}
            onChange={(e) => update('ticker', e.target.value.toUpperCase())}
            placeholder="SPY"
            className={inputClass}
          />
        </Field>

        <Field label="Strategy">
          <select
            value={form.strategy_type}
            onChange={(e) => update('strategy_type', e.target.value)}
            className={inputClass}
          >
            <option value="BULL_CALL">Bull Call Spread</option>
            <option value="BEAR_PUT">Bear Put Spread</option>
            <option value="BULL_PUT_CREDIT">Bull Put Credit Spread</option>
            <option value="BEAR_CALL_CREDIT">Bear Call Credit Spread</option>
            <option value="IRON_CONDOR">Iron Condor</option>
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Long strike">
            <input
              type="number"
              step="0.5"
              value={form.long_strike}
              onChange={(e) => update('long_strike', e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Short strike">
            <input
              type="number"
              step="0.5"
              value={form.short_strike}
              onChange={(e) => update('short_strike', e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Expiration">
            <input
              type="date"
              value={form.expiration}
              onChange={(e) => update('expiration', e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Contracts">
            <input
              type="number"
              min="1"
              value={form.contracts}
              onChange={(e) => update('contracts', e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <Field label="Entry debit per spread ($)">
          <input
            type="number"
            step="0.01"
            value={form.entry_debit_per_spread}
            onChange={(e) => update('entry_debit_per_spread', e.target.value)}
            placeholder="2.50"
            className={inputClass}
          />
        </Field>

        <Field label="Thesis (optional)">
          <textarea
            rows="2"
            value={form.thesis}
            onChange={(e) => update('thesis', e.target.value)}
            placeholder="Why this trade?"
            className={inputClass + ' resize-none'}
          />
        </Field>

        {error && (
          <div className="bg-red-950/30 border border-red-900/50 text-red-400 text-xs rounded p-2">
            {error}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            onClick={onClose}
            className="flex-1 bg-card border border-border text-fg text-sm font-medium rounded-lg py-2 hover:border-border-hover"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 bg-amber-400 text-bg text-sm font-semibold rounded-lg py-2 hover:bg-amber-300 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save & Monitor'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputClass =
  'w-full bg-bg border border-border text-fg rounded-md py-1.5 px-2 text-sm focus:outline-none focus:border-amber-400/40'

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">
        {label}
      </label>
      {children}
    </div>
  )
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
