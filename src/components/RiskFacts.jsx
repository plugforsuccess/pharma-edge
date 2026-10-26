// Risk facts on a ticker (owner spec v2, 2026-10-26): the nightly
// ticker_risks row as two plain sentences — no color, no score — plus the
// test's own reading when both are lit. `useTickerRisks(tickers)` loads the
// rows; <RiskFactList> is the entry chart's card; the holding card renders
// the same facts inline (RiskNotices in Leaps.jsx).
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { holdingRiskFacts, bothLitLine, riskRows } from '../utils/holdingRisks'

// tickers: string[] → { TICKER: row } (undefined while loading, {} when none).
export function useTickerRisks(tickers) {
  const key = (tickers ?? []).filter(Boolean).map((t) => t.toUpperCase()).sort().join(',')
  const [rows, setRows] = useState(undefined)
  useEffect(() => {
    let cancelled = false
    if (!key) { setRows({}); return undefined }
    supabase.from('ticker_risks').select('ticker, as_of, catalyst, shorts, runway').in('ticker', key.split(','))
      .then(({ data, error }) => { if (!cancelled) setRows(error ? {} : Object.fromEntries((data ?? []).map((r) => [r.ticker, r]))) })
    return () => { cancelled = true }
  }, [key])
  return rows
}

// Compact rows (owner, 2026-10-26: the sentences read as a wall of text):
// label on the left, the number as the hero on the right, one detail line.
export function RiskSentences({ row }) {
  const facts = holdingRiskFacts(row)
  if (!facts.length) return null
  const both = bothLitLine(facts)
  return (
    <div>
      <div className="divide-y divide-border border border-border rounded-xl overflow-hidden">
        {riskRows(row).map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm text-fg truncate">{r.label}</div>
              <div className="text-xs text-subtle truncate">{r.detail}</div>
            </div>
            <div className="shrink-0 text-base font-semibold font-mono-tab text-fg">{r.value}</div>
          </div>
        ))}
      </div>
      {both && <div className="mt-1.5 text-[11px] text-muted">{both}</div>}
    </div>
  )
}

export default function RiskFactList({ row, title = 'Risks to watch' }) {
  if (!holdingRiskFacts(row).length) return null
  return (
    <section className="bg-card border border-border rounded-2xl p-5 mt-4">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold mb-2">{title}</div>
      <RiskSentences row={row} />
      <div className="mt-2 text-[11px] text-muted">As of {row.as_of} · from prices and FINRA short interest · facts, not advice.</div>
    </section>
  )
}
