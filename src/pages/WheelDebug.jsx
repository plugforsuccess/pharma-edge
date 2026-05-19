import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, XCircle, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'

// /wheel-debug — Wheel Strategy First Slice debug surface (build
// prompt §14 item 6). Proves the regime/wall/strike decision logic
// works end-to-end against live data before any real UI investment.
// Admin-gated in App.jsx like /flow — internal tool, not a shipped
// user screen. Language is mechanical, never advisory.

const fmtNum = (n, d = 2) =>
  n == null || !Number.isFinite(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-US', { maximumFractionDigits: d })

const fmtUsd = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  return `$${fmtNum(v, 0)}`
}

function Row({ label, value, mono = true }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/60 last:border-0">
      <span className="text-subtle text-xs">{label}</span>
      <span className={`text-fg text-sm ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

const CONDITION_LABELS = {
  net_gex_positive: 'net GEX > 0 (dealers long gamma)',
  pin_ok: 'pin probability ≥ 35',
  spot_above_put_wall: 'spot above put wall',
  spot_below_call_wall: 'spot below call wall',
  expected_move_ok: 'expected move < 0.8 × nearest-wall distance',
  iv_rank_ok: 'IV rank ≥ 30',
}

export default function WheelDebug() {
  const [ticker, setTicker] = useState('NOW')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  async function run(e) {
    e?.preventDefault?.()
    setLoading(true)
    setError(null)
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke('wheel-setups-now', {
        body: { ticker: ticker.trim().toUpperCase() },
      })
      if (invokeErr) throw new Error(invokeErr.message || 'request failed')
      if (!data?.success) throw new Error(data?.error || 'no data returned')
      setResult(data.data)
    } catch (err) {
      setError(err.message || String(err))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const d = result
  const isA = d?.regime === 'A'

  return (
    <div className="max-w-md mx-auto px-4 py-5 w-full">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-subtle text-xs mb-4 hover:text-fg"
      >
        <ArrowLeft size={14} /> Back
      </Link>

      <h1 className="text-fg text-lg font-semibold tracking-tight">Wheel Setup — Debug</h1>
      <p className="text-muted text-xs mt-1 mb-5">
        First-slice decision engine. Regime / walls / strikes only — sizing, premium,
        catalysts and persistence land in Phase 1.
      </p>

      <form onSubmit={run} className="flex gap-2 mb-5">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="NOW"
          className="flex-1 bg-card border border-border rounded-lg px-3 py-2 text-fg text-sm font-mono outline-none focus:border-border-hover"
        />
        <button
          type="submit"
          disabled={loading}
          className="inline-flex items-center gap-1.5 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-bg font-semibold text-sm px-4 py-2 rounded-lg"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Run
        </button>
      </form>

      {error && (
        <div className="bg-card border border-red-800 rounded-lg p-3 text-red-400 text-sm mb-5">
          {error}
        </div>
      )}

      {d && (
        <div className="space-y-4">
          {/* Regime status */}
          <div
            className={`bg-card border rounded-lg p-4 ${
              isA ? 'border-green-500/50' : 'border-red-800'
            }`}
          >
            <div className="flex items-center gap-2">
              {isA ? (
                <CheckCircle2 size={20} className="text-green-400" />
              ) : (
                <XCircle size={20} className="text-red-400" />
              )}
              <span className="text-fg font-semibold">
                {d.ticker} — Regime {d.regime}{' '}
                <span className={isA ? 'text-green-400' : 'text-red-400'}>
                  {isA ? '(tradeable)' : '(no trade)'}
                </span>
              </span>
            </div>
            {d.disqualify_reasons?.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {d.disqualify_reasons.map((r, i) => (
                  <li key={i} className="text-red-400 text-xs flex gap-1.5">
                    <span>✗</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 grid grid-cols-1 gap-1">
              {Object.entries(CONDITION_LABELS).map(([k, label]) => {
                const ok = d.conditions?.[k]
                return (
                  <div key={k} className="flex items-center gap-1.5 text-xs">
                    <span className={ok ? 'text-green-400' : 'text-muted'}>
                      {ok ? '✓' : '·'}
                    </span>
                    <span className={ok ? 'text-subtle' : 'text-muted'}>{label}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* GEX snapshot */}
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="text-subtle text-[10px] uppercase tracking-[0.18em] mb-2">
              GEX Snapshot
            </div>
            <Row label="Spot" value={fmtNum(d.spot)} />
            <Row label="Net GEX" value={fmtUsd(d.net_gex)} />
            <Row label="Pin probability" value={`${fmtNum(d.pin_probability, 1)}%`} />
            <Row label="Expected move" value={`$${fmtNum(d.expected_move)}`} />
            <Row
              label="IV rank"
              value={
                d.iv_rank == null
                  ? `unavailable (${d.iv_history_samples ?? 0} samples)`
                  : `${fmtNum(d.iv_rank, 1)} (${d.iv_rank_source})`
              }
            />
            <Row
              label="Source"
              value={`${d.gex_source ?? '—'} · exp ${d.expiration?.date ?? '—'} (${
                d.expiration?.dte ?? '—'
              } DTE)`}
            />
          </div>

          {/* Walls */}
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="text-subtle text-[10px] uppercase tracking-[0.18em] mb-2">
              Dealer Walls (≥ $500K notional OI)
            </div>
            <Row
              label="Call wall"
              value={
                d.call_wall
                  ? `${fmtNum(d.call_wall.strike)} · ${fmtNum(d.call_wall.oi, 0)} OI · ${fmtUsd(
                      d.call_wall.notional,
                    )}`
                  : 'no clear wall'
              }
            />
            <Row
              label="Put wall"
              value={
                d.put_wall
                  ? `${fmtNum(d.put_wall.strike)} · ${fmtNum(d.put_wall.oi, 0)} OI · ${fmtUsd(
                      d.put_wall.notional,
                    )}`
                  : 'no clear wall'
              }
            />
          </div>

          {/* Wall migration check — runs before the setup is acted on */}
          {d.wall_migration && (
            <div
              className={`bg-card border rounded-lg p-4 ${
                d.wall_migration.warning ? 'border-red-800' : 'border-green-500/50'
              }`}
            >
              <div className="text-subtle text-[10px] uppercase tracking-[0.18em] mb-2">
                Wall Migration Check
              </div>
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`text-sm font-semibold ${
                    d.wall_migration.trend === 'ESTABLISHED_PIN'
                      ? 'text-green-400'
                      : d.wall_migration.trend === 'UNKNOWN'
                      ? 'text-subtle'
                      : 'text-red-400'
                  }`}
                >
                  {d.wall_migration.trend.replace(/_/g, ' ')}
                </span>
                <span className="text-muted text-xs">
                  · sell {d.wall_migration.trade_side.replace(/_/g, ' ')} · conf{' '}
                  {d.wall_migration.confidence}
                </span>
              </div>
              <p
                className={`text-xs leading-relaxed ${
                  d.wall_migration.warning ? 'text-red-400' : 'text-subtle'
                }`}
              >
                {d.wall_migration.message}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[1, 3, 5].map((n) => {
                  const o = d.wall_migration.observations?.find(
                    (x) => x.trading_days_ago === n,
                  )
                  return (
                    <div key={n} className="text-center">
                      <div className="text-muted text-[10px]">{n}d ago</div>
                      <div className="text-fg text-sm font-mono">
                        {o?.call_wall_strike ?? '—'}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 pt-3 border-t border-border/60">
                <Row
                  label="Effective sell call"
                  value={d.wall_migration.effective_call_strike ?? 'skip'}
                />
                <Row
                  label="Effective sell put"
                  value={d.wall_migration.effective_put_strike ?? 'skip'}
                />
              </div>
            </div>
          )}

          {/* Recommended strikes (base §4.3 structural reference) */}
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="text-subtle text-[10px] uppercase tracking-[0.18em] mb-2">
              Base Strikes (§4.3 reference)
            </div>
            <Row
              label="Sell call"
              value={d.suggested_call_strike ?? '—'}
            />
            <p className="text-muted text-[11px] mb-2">
              AT the call wall{d.call_wall ? ` (${fmtUsd(d.call_wall.notional)})` : ''}
            </p>
            <Row
              label="Sell put"
              value={d.suggested_put_strike ?? '—'}
            />
            <p className="text-muted text-[11px]">
              ONE strike above the put wall — the soft zone
              {d.put_wall ? ` (wall ${fmtNum(d.put_wall.strike)})` : ''}
            </p>
          </div>

          {/* Raw payload */}
          <details className="bg-card border border-border rounded-lg p-4">
            <summary className="text-subtle text-xs cursor-pointer">Raw response</summary>
            <pre className="mt-3 text-[10px] text-muted overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(d, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  )
}
