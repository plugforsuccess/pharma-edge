// Risk facts on a ticker (owner, 2026-10-26): the nightly ticker_risks row
// turned into dated, priced lines — what happened, never what to do.
// `useTickerRisks(tickers)` loads the rows; <RiskFactList> renders them as a
// plain list (entry chart); the holding card wraps each fact in its own
// dismissable Notice instead (Leaps.jsx).
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { holdingRiskFacts } from '../utils/holdingRisks'

export const RISK_TONE = {
  amber: 'border-amber-500/40 bg-amber-500/5 text-amber-100',
  neutral: 'border-border bg-bg/40 text-fg',
}

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

export default function RiskFactList({ row, title = 'Risks to watch' }) {
  const facts = holdingRiskFacts(row)
  if (!facts.length) return null
  return (
    <section className="bg-card border border-border rounded-2xl p-5 mt-4">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">{title}</div>
      <div className="mt-2 space-y-2">
        {facts.map((f) => (
          <div key={f.key} className={clsx('rounded-2xl border px-4 py-3', RISK_TONE[f.tone])}>
            <div className="text-sm font-semibold">{f.title}</div>
            <div className="mt-0.5 text-sm text-subtle">{f.body}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-muted">As of {row.as_of} · facts from prices, FINRA short interest and SEC filings, not advice.</div>
    </section>
  )
}
