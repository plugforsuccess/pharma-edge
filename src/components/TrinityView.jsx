import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import GexMatrix from './GexMatrix'

// 3-ticker side-by-side comparison view (Skylit's "Trinity" mode).
// Renders three full GexMatrix components in a horizontal-scroll
// layout — comfortably one ticker visible at a time on phone, swipe
// to next. The default trio is SPY/QQQ/IWM (the standard index-vol
// comparison set) but any 3 tickers from TICKER_UNIVERSE work.
//
// Each column fetches independently so a single slow ticker doesn't
// block the others, and refresh is per-column.

const DEFAULT_TRIO = ['SPY', 'QQQ', 'IWM']

export default function TrinityView({ initialTickers }) {
  const [tickers, setTickers] = useState(initialTickers ?? DEFAULT_TRIO)

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-subtle leading-relaxed px-1">
        <strong className="text-fg">Trinity:</strong> three tickers
        side-by-side. Swipe between columns. The default trio (SPY /
        QQQ / IWM) is the standard index-vol comparison.
      </div>

      <div className="-mx-4 px-4 overflow-x-auto snap-x snap-mandatory">
        <div className="flex gap-3 pb-2">
          {tickers.map((t) => (
            <div
              key={t}
              className="shrink-0 w-[88vw] max-w-[420px] snap-start bg-card border border-border rounded-xl overflow-hidden"
            >
              <TrinityColumn ticker={t} onSwap={(newSym) => {
                setTickers((prev) => prev.map((p) => (p === t ? newSym : p)))
              }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TrinityColumn({ ticker, onSwap }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function load(refresh = false) {
    setLoading(true)
    setError(null)
    try {
      const { data: result, error: err } = await supabase.functions.invoke(
        'compute-gex',
        { body: { ticker, matrix: true, refresh } },
      )
      if (err) throw err
      if (!result?.success) throw new Error(result?.error || 'compute-gex failed')
      setData(result.data)
    } catch (e) {
      setError(e.message || 'failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker])

  return (
    <div>
      <div className="px-3 py-2 border-b border-border flex items-baseline justify-between">
        <div>
          <div className="text-base font-display tracking-tight text-fg">
            {data?.ticker ?? ticker}
          </div>
          <div className="text-[10px] text-subtle">
            {data && (
              <>
                ${formatNum(data.spot)} · {data.expirations?.length ?? 0} exp
              </>
            )}
            {loading && !data && <>loading…</>}
          </div>
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="text-[10px] text-subtle hover:text-fg disabled:opacity-50"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>

      <div className="p-3 min-h-[300px]">
        {!loading && error && (
          <p className="text-[11px] text-crimson">{error}</p>
        )}
        {!loading && !error && data && <GexMatrix data={data} />}
      </div>
    </div>
  )
}

function formatNum(v) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(2)
}
