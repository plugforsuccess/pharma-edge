// Cash Moves — on-demand wheel CSP analysis for the matrix on screen.
//
// The /wheel page and the SuggestedWheel strip read the batch
// universe scan. This panel is the per-ticker, click-to-run
// equivalent of SuggestedPlays for the wheel: it asks the SAME
// deterministic scan-wheel-cycles engine (single-ticker mode) to
// evaluate the CURRENT matrix ticker right now, and renders either
// the constructed CSP (all 7 conditions + the live Polygon-priced
// leg) or the explained rejection. The call is persisted server-side
// as a scan_kind='ondemand' row (attributed, rate-limited) so it is
// auditable without polluting the batch surfaces.
//
// Locked UX contracts preserved: loud UNVERIFIED catalyst, explained
// (never silent) rejection, and the softened-gate low-confidence
// caveat.

import { useState } from 'react'
import { RefreshCw, AlertTriangle, ShieldCheck, CircleSlash } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import {
  CONDITIONS,
  reasonText,
  fmtStrike,
  fmtUsd,
  fmtUsd0,
  fmtPct,
  fmtDate,
} from '../lib/wheelFormat'

export default function WheelAnalyze({ ticker }) {
  const [state, setState] = useState('idle') // idle | loading | done | error
  const [result, setResult] = useState(null)
  const [errMsg, setErrMsg] = useState('')

  async function run() {
    if (!ticker) return
    setState('loading')
    setErrMsg('')
    setResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('scan-wheel-cycles', {
        body: { ticker },
      })
      if (error) {
        let msg = error.message || 'Analysis failed'
        try {
          const j = await error.context?.json?.()
          if (j?.error) msg = j.error
        } catch {
          /* keep generic */
        }
        setErrMsg(msg)
        setState('error')
        return
      }
      setResult(data)
      setState('done')
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }

  const s = result?.suggestion || null
  const rejections = Array.isArray(result?.rejections) ? result.rejections : []

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <RefreshCw size={15} className="text-amber-400 shrink-0" />
          <div className="min-w-0">
            <p className="text-fg text-sm font-semibold leading-tight">
              Wheel check{ticker ? ` · ${ticker}` : ''}
            </p>
            <p className="text-muted text-[10px] leading-tight">
              Run the 7-condition CSP analysis on this matrix now
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={state === 'loading' || !ticker}
          className={clsx(
            'tap-spring shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold',
            state === 'loading' || !ticker
              ? 'bg-bg-elev text-muted cursor-not-allowed'
              : 'bg-amber-400 hover:bg-amber-300 text-bg',
          )}
        >
          {state === 'loading' ? 'Analyzing…' : state === 'done' || state === 'error' ? 'Re-run' : `Analyze ${ticker || ''}`}
        </button>
      </div>

      {state === 'loading' && (
        <div className="px-4 py-6 text-center text-muted text-xs">
          Pulling the live matrix + pricing the cash-secured put…
        </div>
      )}

      {state === 'error' && (
        <div className="px-4 py-4 flex items-start gap-2">
          <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-red-300 text-xs leading-relaxed">{errMsg}</p>
        </div>
      )}

      {state === 'done' && s && <QualifiedCard s={s} />}

      {state === 'done' && !s && (
        <NotQualified ticker={result?.ticker || ticker} rejections={rejections} err={result?.error} />
      )}
    </div>
  )
}

function QualifiedCard({ s }) {
  const c = s?.catalyst_check || {}
  const unverified = c.earnings === 'UNVERIFIED' || c.macro === 'UNVERIFIED'
  const lowConf = []
  if (s?.iv_rank_confidence === 'low') lowConf.push('IV rank')
  if (s?.wall_stable_confidence === 'low') lowConf.push('wall stability')

  return (
    <div>
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-border">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-fg font-bold text-base">{s.ticker}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide border text-red-300 bg-red-950 border-red-800">
              CSP
            </span>
          </div>
          <p className="text-muted text-[11px] truncate mt-0.5">
            Sell put · {fmtStrike(s.strike)} · {fmtDate(s.expiration)}
            {s.dte != null && <> · {s.dte}DTE</>}
            {s.delta != null && <> · {Math.abs(Number(s.delta)).toFixed(2)}Δ</>}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-green-400 font-bold text-base font-mono-tab tabular-nums">
            {fmtPct(s.annualized_pct)}
          </div>
          <div className="text-muted text-[10px] uppercase tracking-wide">annualized</div>
        </div>
      </div>

      <div className="px-4 py-3 grid grid-cols-3 gap-3 text-center border-b border-border">
        <Stat label="Premium" value={fmtUsd(s.premium)} />
        <Stat label="Collateral" value={fmtUsd0(s.collateral_cash)} />
        <Stat label="Regime" value={s.regime || (s.net_gex > 0 ? 'A' : '—')} green={s.net_gex > 0} />
      </div>

      {unverified ? (
        <div className="px-4 py-2.5 bg-amber-950/40 border-b border-amber-900/60 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-amber-200 text-[11px] leading-relaxed">
            <span className="font-semibold">Catalyst not verified.</span>{' '}
            {c.earnings === 'UNVERIFIED' && 'No earnings feed. '}
            {c.macro === 'UNVERIFIED' && 'No FOMC/CPI feed. '}
            Confirm no earnings or macro event before {fmtDate(s.expiration)}{' '}
            <span className="font-semibold">manually</span> before selling this put.
          </p>
        </div>
      ) : (
        <div className="px-4 py-2 bg-green-950/20 border-b border-green-900/40 flex items-center gap-2">
          <ShieldCheck size={13} className="text-green-400 shrink-0" />
          <p className="text-green-300 text-[11px]">No catalyst within DTE (verified clear).</p>
        </div>
      )}

      {lowConf.length > 0 && (
        <div className="px-4 py-2 bg-zinc-900/60 border-b border-border flex items-start gap-2">
          <AlertTriangle size={13} className="text-zinc-400 mt-0.5 shrink-0" />
          <p className="text-zinc-300 text-[11px] leading-relaxed">
            <span className="font-semibold">Low confidence:</span>{' '}
            {lowConf.join(' + ')} passed on thin history — gate satisfied but
            not strongly substantiated. Size accordingly.
          </p>
        </div>
      )}

      <div className="px-4 py-3 flex flex-wrap gap-1.5">
        {CONDITIONS.map((cond) => {
          const passed = s?.conditions?.[cond.key]
          return (
            <span
              key={cond.key}
              title={cond.hint}
              className={clsx(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border',
                passed
                  ? 'bg-green-950/40 border-green-900/60 text-green-300'
                  : 'bg-zinc-900 border-border text-muted',
              )}
            >
              <span className={clsx('w-1.5 h-1.5 rounded-full', passed ? 'bg-green-400' : 'bg-zinc-600')} />
              {cond.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function NotQualified({ ticker, rejections, err }) {
  return (
    <div className="px-4 py-5 text-center space-y-2">
      <div className="flex justify-center">
        <CircleSlash size={24} className="text-muted" />
      </div>
      <p className="text-fg text-sm">
        {ticker} doesn&apos;t qualify for a wheel CSP right now
      </p>
      {err ? (
        <p className="text-muted text-[11px]">{err}</p>
      ) : rejections.length ? (
        <div className="flex flex-wrap gap-1.5 justify-center pt-1">
          {rejections.map((r) => (
            <span
              key={r}
              className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-medium bg-zinc-900 border border-border text-muted"
            >
              {reasonText(r)}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-muted text-[11px]">
          No qualifying setup; no specific gate reason returned.
        </p>
      )}
      <p className="text-subtle text-[11px] leading-relaxed max-w-sm mx-auto pt-1">
        An empty result is the strategy working — the wheel only sells premium
        in a pinned, positive-net-GEX regime.
      </p>
    </div>
  )
}

function Stat({ label, value, green }) {
  return (
    <div>
      <div
        className={clsx(
          'font-mono-tab tabular-nums text-sm font-semibold',
          green ? 'text-green-400' : 'text-fg',
        )}
      >
        {value}
      </div>
      <div className="text-muted text-[10px] uppercase tracking-wide">{label}</div>
    </div>
  )
}
