import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, ArrowDown, ArrowUp, RefreshCw } from 'lucide-react'
import { supabase } from '../lib/supabase'

function formatGex(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : '+'
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`
  return `${sign}$${abs.toLocaleString()}`
}

function sideClasses(side) {
  if (side === 'call') return 'text-green-400'
  if (side === 'put') return 'text-red-400'
  return 'text-zinc-400'
}

export default function KingBoard() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sortBy, setSortBy] = useState('biggest')

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('current_king_nodes')
      .select('*')
      .order('ticker', { ascending: true })
      .order('exp_idx', { ascending: true })
    if (error) setError(error.message)
    else setRows(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // Pivot flat rows into one row per ticker with exp0/exp1/exp2 columns.
  const tickers = useMemo(() => {
    const byTicker = new Map()
    for (const r of rows) {
      const existing = byTicker.get(r.ticker) ?? {
        ticker: r.ticker,
        snapshot_at: r.snapshot_at,
        spot: r.spot,
        exps: [null, null, null],
        max_abs_gex: 0,
      }
      existing.exps[r.exp_idx] = r
      if (r.spot != null) existing.spot = r.spot
      const absG = Math.abs(Number(r.king_gex) || 0)
      if (absG > existing.max_abs_gex) existing.max_abs_gex = absG
      byTicker.set(r.ticker, existing)
    }
    const arr = Array.from(byTicker.values())
    if (sortBy === 'biggest') arr.sort((a, b) => b.max_abs_gex - a.max_abs_gex)
    else arr.sort((a, b) => a.ticker.localeCompare(b.ticker))
    return arr
  }, [rows, sortBy])

  function distancePct(spot, strike) {
    if (spot == null || strike == null) return null
    const s = Number(spot)
    const k = Number(strike)
    if (!Number.isFinite(s) || !Number.isFinite(k) || s <= 0) return null
    return ((k - s) / s) * 100
  }

  return (
    <div className="px-4 py-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display text-fg">King Board</h1>
          <p className="text-sm text-subtle mt-1">
            Largest |GEX| strike per ticker for the front three expirations.
            Calls green, puts red. Click <span className="text-fg">Plays</span> for spread ideas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSortBy(sortBy === 'biggest' ? 'alpha' : 'biggest')}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card text-subtle hover:text-fg"
          >
            Sort: {sortBy === 'biggest' ? '|GEX| desc' : 'A→Z'}
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-md border border-border bg-card text-subtle hover:text-fg flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 text-red-400 text-sm px-3 py-2 mb-4">
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="text-subtle text-sm">Loading king nodes…</div>
      ) : tickers.length === 0 ? (
        <div className="text-subtle text-sm">
          No snapshots yet. The 5-min cron writes to <code>gex_history</code> during RTH.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 px-4">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted uppercase tracking-wide">
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-3">Ticker</th>
                <th className="text-left py-2 pr-3">Spot</th>
                <th className="text-left py-2 pr-3">Exp 0</th>
                <th className="text-left py-2 pr-3">Exp 1</th>
                <th className="text-left py-2 pr-3">Exp 2</th>
                <th className="text-right py-2 pl-3">Plays</th>
              </tr>
            </thead>
            <tbody>
              {tickers.map((t) => (
                <tr key={t.ticker} className="border-b border-border/40 hover:bg-card/40">
                  <td className="py-2 pr-3 font-mono font-semibold text-fg">{t.ticker}</td>
                  <td className="py-2 pr-3 font-mono text-subtle">
                    {t.spot != null ? Number(t.spot).toFixed(2) : '—'}
                  </td>
                  {t.exps.map((e, i) => {
                    const pct = e ? distancePct(t.spot, e.king_strike) : null
                    return (
                      <td key={i} className="py-2 pr-3 font-mono">
                        {e ? (
                          <div>
                            <div className={sideClasses(e.side)}>
                              {Number(e.king_strike)}
                              {e.side === 'call' ? 'C' : 'P'}{' '}
                              <span className="text-muted">· {e.dte}d</span>
                            </div>
                            <div className="text-xs text-subtle">
                              {formatGex(Number(e.king_gex))}
                              {pct != null && (
                                <span className="text-muted">
                                  {' '}· {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                                </span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="py-2 pl-3 text-right">
                    <Link
                      to={`/markets?ticker=${encodeURIComponent(t.ticker)}`}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border text-fg hover:bg-card"
                    >
                      <Sparkles className="w-3 h-3" />
                      Plays
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
