// Cash Moves — "The Wheel" (/wheel).
//
// Authenticated surface. Renders the latest wheel_suggestions row:
// cash-secured-put / covered-call candidates that cleared all 7 entry
// conditions, ranked by annualized yield.
//
// Two non-negotiable UX contracts, locked with the owner:
//
//  1. UNVERIFIED catalyst is LOUD, not silent. earnings_calendar +
//     market_events are empty in this project (no feed wired), so the
//     scanner can only hard-verify OPEX. Any suggestion whose
//     catalyst_check has earnings/macro = 'UNVERIFIED' renders a
//     blocking amber warning the user must read before entry — selling
//     a CSP into an unflagged earnings print is the classic wheel
//     blow-up and we will not hide that gap behind a green checkmark.
//
//  2. An empty feed is EXPLAINED, never a sad zero. The scanner writes
//     gate_rejections (per-ticker, which of the 7 conditions failed),
//     so when nothing passes we show exactly why ("9 scanned: 5
//     negative net GEX, 3 IV rank < 30, 1 OPEX within DTE") instead of
//     a blank screen. This is the direct fix for the silent-zero
//     failure mode this codebase has been bitten by.
//
// Wheel is a desktop-sidebar + direct-URL surface; the mobile bottom
// nav is already full at 5 slots (see Layout.jsx), so it is not added
// there.

import { useEffect, useMemo, useState } from 'react'
import {
  RefreshCw,
  AlertTriangle,
  ShieldCheck,
  CircleSlash,
  TrendingUp,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import {
  CONDITIONS,
  rejectionSummary,
  fmtStrike,
  fmtUsd,
  fmtUsd0,
  fmtPct,
  fmtDate,
  fmtGex,
  formatRelative,
} from '../lib/wheelFormat'

export default function Wheel() {
  const [row, setRow] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    supabase
      .from('wheel_suggestions')
      .select('*')
      // Batch surface only — exclude on-demand single-ticker rows so a
      // user's /markets analysis can't hijack the universe feed.
      .neq('scan_kind', 'ondemand')
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          setError(err.message)
          setRow(null)
        } else {
          setRow(data)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const suggestions = useMemo(
    () => (Array.isArray(row?.ranked_suggestions) ? row.ranked_suggestions : []),
    [row],
  )

  const anyUnverified = useMemo(
    () =>
      suggestions.some((s) => {
        const c = s?.catalyst_check || {}
        return c.earnings === 'UNVERIFIED' || c.macro === 'UNVERIFIED'
      }),
    [suggestions],
  )

  return (
    <div className="min-h-screen bg-bg">
      <div className="px-4 lg:px-6 pt-6 pb-12 mx-auto lg:max-w-5xl w-full">
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <RefreshCw size={20} className="text-amber-400" />
            <h1 className="text-fg text-xl lg:text-2xl font-bold">The Wheel</h1>
          </div>
          <p className="text-muted text-xs lg:text-sm leading-relaxed max-w-2xl">
            Cash-secured puts that clear all seven entry conditions, ranked by
            annualized yield. Get assigned → the position rolls to a covered
            call. Premium compounds either way — as long as the regime stays
            pinned.
          </p>
        </div>

        {/* ── Global UNVERIFIED catalyst banner ───────────────────── */}
        {anyUnverified && <UnverifiedBanner />}

        {/* ── Body ────────────────────────────────────────────────── */}
        {loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState message={error} />
        ) : !row ? (
          <NoScanYet />
        ) : (
          <>
            {suggestions.length === 0 ? (
              <ExplainedEmpty row={row} />
            ) : (
              <>
                <ScanMeta row={row} />
                <div className="space-y-3">
                  {suggestions.map((s, i) => (
                    <SuggestionCard key={`${s.ticker}-${s.leg}-${i}`} s={s} rank={i + 1} />
                  ))}
                </div>
                <RejectionFootNote row={row} />
              </>
            )}
            <GexLeaderboard rows={row.gex_ranking} />
          </>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Suggestion card
// ────────────────────────────────────────────────────────────────────

function SuggestionCard({ s, rank }) {
  const isCsp = s?.leg === 'csp'
  const c = s?.catalyst_check || {}
  const unverified = c.earnings === 'UNVERIFIED' || c.macro === 'UNVERIFIED'
  const lowConf = []
  if (s?.iv_rank_confidence === 'low') lowConf.push('IV rank')
  if (s?.wall_stable_confidence === 'low') lowConf.push('wall stability')

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-muted text-xs font-mono-tab w-6 text-center shrink-0">
            #{rank}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-fg font-bold text-base">{s.ticker}</span>
              <LegBadge isCsp={isCsp} />
            </div>
            <p className="text-muted text-[11px] truncate">
              {isCsp ? 'Sell put' : 'Sell call'} · {fmtStrike(s.strike)} ·{' '}
              {fmtDate(s.expiration)}
              {s.dte != null && <> · {s.dte}DTE</>}
              {s.delta != null && <> · {Math.abs(Number(s.delta)).toFixed(2)}Δ</>}
            </p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-green-400 font-bold text-base font-mono-tab tabular-nums">
            {fmtPct(s.annualized_pct)}
          </div>
          <div className="text-muted text-[10px] uppercase tracking-wide">
            annualized
          </div>
        </div>
      </div>

      <div className="px-4 py-3 grid grid-cols-3 gap-3 text-center border-b border-border">
        <Stat label="Premium" value={fmtUsd(s.premium)} />
        <Stat label="Collateral" value={fmtUsd0(s.collateral_cash)} />
        <Stat
          label="Regime"
          value={s.regime || (s.net_gex > 0 ? 'A' : '—')}
          tone={s.net_gex > 0 ? 'green' : 'muted'}
        />
      </div>

      {/* Per-card catalyst verification — the locked loud-warning UX */}
      {unverified ? (
        <div className="px-4 py-2.5 bg-amber-950/40 border-b border-amber-900/60 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-amber-200 text-[11px] leading-relaxed">
            <span className="font-semibold">Catalyst not verified.</span>{' '}
            {c.earnings === 'UNVERIFIED' && 'No earnings feed in this project. '}
            {c.macro === 'UNVERIFIED' && 'No FOMC/CPI feed in this project. '}
            Confirm there is no earnings or macro event before{' '}
            {fmtDate(s.expiration)} <span className="font-semibold">manually</span>{' '}
            before entering. OPEX{' '}
            {c.opex === 'clear' ? 'is clear (verified).' : 'check ran.'}
          </p>
        </div>
      ) : (
        <div className="px-4 py-2 bg-green-950/20 border-b border-green-900/40 flex items-center gap-2">
          <ShieldCheck size={13} className="text-green-400 shrink-0" />
          <p className="text-green-300 text-[11px]">
            No catalyst within DTE (OPEX + earnings + macro verified clear).
          </p>
        </div>
      )}

      {/* Low-confidence caveat — a softened gate (thin history) passed
          on a metric we can't yet fully substantiate. Shown, not
          hidden, so a soft pass never looks like a verified one. */}
      {lowConf.length > 0 && (
        <div className="px-4 py-2 bg-zinc-900/60 border-b border-border flex items-start gap-2">
          <AlertTriangle size={13} className="text-zinc-400 mt-0.5 shrink-0" />
          <p className="text-zinc-300 text-[11px] leading-relaxed">
            <span className="font-semibold">Low confidence:</span>{' '}
            {lowConf.join(' + ')} passed on thin history (window still
            building). The gate is satisfied but not yet strongly
            substantiated — size accordingly.
          </p>
        </div>
      )}

      {/* 7-condition gate strip */}
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
              <span
                className={clsx(
                  'w-1.5 h-1.5 rounded-full',
                  passed ? 'bg-green-400' : 'bg-zinc-600',
                )}
              />
              {cond.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function LegBadge({ isCsp }) {
  return (
    <span
      className={clsx(
        'px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide border',
        isCsp
          ? 'text-red-300 bg-red-950 border-red-800'
          : 'text-green-300 bg-green-950 border-green-800',
      )}
    >
      {isCsp ? 'CSP' : 'COVERED CALL'}
    </span>
  )
}

function Stat({ label, value, tone }) {
  return (
    <div>
      <div
        className={clsx(
          'font-mono-tab tabular-nums text-sm font-semibold',
          tone === 'green' ? 'text-green-400' : 'text-fg',
        )}
      >
        {value}
      </div>
      <div className="text-muted text-[10px] uppercase tracking-wide">{label}</div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Scan metadata + explained-empty state (the anti-silent-zero UX)
// ────────────────────────────────────────────────────────────────────

function ScanMeta({ row }) {
  return (
    <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
      <p className="text-muted text-[11px]">
        {row.candidates_after_gate} of {row.tickers_scanned} tickers passed all
        seven conditions · scanned {formatRelative(row.computed_at)}
      </p>
    </div>
  )
}

// When some passed, still surface a one-line tally of what didn't, so
// the list is never silently shorter than the universe with no reason.
function RejectionFootNote({ row }) {
  const summary = rejectionSummary(row?.gate_rejections)
  if (!summary) return null
  return (
    <p className="mt-4 text-muted text-[11px] leading-relaxed border-t border-border pt-3">
      <span className="text-subtle">Rejected:</span> {summary}
    </p>
  )
}

function ExplainedEmpty({ row }) {
  const summary = rejectionSummary(row?.gate_rejections)
  return (
    <div className="bg-card border border-border rounded-xl p-8 text-center space-y-3">
      <div className="flex justify-center">
        <CircleSlash size={28} className="text-muted" />
      </div>
      <p className="text-fg text-base font-display">
        No wheel setups right now — and here&apos;s exactly why
      </p>
      <p className="text-subtle text-xs leading-relaxed max-w-md mx-auto">
        Scanned {row.tickers_scanned} ticker{row.tickers_scanned === 1 ? '' : 's'}{' '}
        {formatRelative(row.computed_at)}. None cleared all seven entry
        conditions. The wheel only sells premium in a pinned, positive-net-GEX
        regime — an empty list is the strategy working, not a bug.
      </p>
      {summary && (
        <p className="text-muted text-[11px] leading-relaxed max-w-md mx-auto pt-2 border-t border-border">
          {summary}
        </p>
      )}
    </div>
  )
}

// Universe GEX leaderboard — always shown when a scan exists, so the
// page has useful content (biggest dealer-gamma names, ranked) even
// when zero CSPs clear the gate.
function GexLeaderboard({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  return (
    <div className="mt-5 bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <p className="text-fg text-sm font-semibold leading-tight">
          Universe by GEX
        </p>
        <p className="text-muted text-[10px] leading-tight">
          Scanned tickers ranked by dealer gamma footprint (|net GEX|)
        </p>
      </div>
      <div className="divide-y divide-border">
        {rows.map((r, i) => {
          const regA = r.regime === 'A'
          return (
            <div
              key={`${r.ticker}-${i}`}
              className="px-4 py-2.5 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-muted text-xs font-mono-tab w-5 text-center shrink-0">
                  {i + 1}
                </span>
                <span className="text-fg font-bold text-sm">{r.ticker}</span>
                <span
                  className={clsx(
                    'px-1.5 py-0.5 rounded text-[10px] font-semibold border',
                    regA
                      ? 'text-green-300 bg-green-950 border-green-800'
                      : 'text-red-300 bg-red-950 border-red-800',
                  )}
                  title={regA ? 'Regime A — positive net GEX (pinning)' : 'Regime B — negative net GEX (trending)'}
                >
                  {regA ? 'A · pin' : 'B · trend'}
                </span>
              </div>
              <div className="text-right shrink-0">
                <div
                  className={clsx(
                    'font-mono-tab tabular-nums text-sm font-semibold',
                    regA ? 'text-green-400' : 'text-red-400',
                  )}
                >
                  {fmtGex(r.net_gex)}
                </div>
                {r.spot != null && (
                  <div className="text-muted text-[10px]">
                    spot {fmtUsd(r.spot)}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NoScanYet() {
  return (
    <div className="bg-card border border-border rounded-xl p-10 text-center space-y-3">
      <div className="flex justify-center">
        <TrendingUp size={28} className="text-muted" />
      </div>
      <p className="text-fg text-base font-display">The first scan hasn&apos;t run yet</p>
      <p className="text-subtle text-xs leading-relaxed max-w-md mx-auto">
        The wheel scanner runs during market hours. Once it completes its first
        pass, qualifying cash-secured puts show up here ranked by annualized
        yield.
      </p>
    </div>
  )
}

function UnverifiedBanner() {
  return (
    <div className="mb-4 bg-amber-950/40 border border-amber-900/60 rounded-xl px-4 py-3 flex items-start gap-2.5">
      <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
      <div>
        <p className="text-amber-200 text-sm font-semibold">
          Earnings &amp; macro events are NOT verified
        </p>
        <p className="text-amber-200/80 text-[11px] leading-relaxed mt-0.5">
          This project has no earnings or FOMC/CPI feed wired, so the scanner
          can only hard-check OPEX. Every suggestion below tagged
          &ldquo;catalyst not verified&rdquo; needs a manual earnings/macro
          check before you sell the put. A CSP through an unflagged earnings
          print is the single classic way the wheel blows up.
        </p>
      </div>
    </div>
  )
}

function ErrorState({ message }) {
  return (
    <div className="bg-card border border-border rounded-xl p-10 text-center">
      <p className="text-fg text-sm font-display mb-2">
        Couldn&apos;t load the wheel feed
      </p>
      <p className="text-muted text-xs">{message}</p>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array(3)
        .fill(0)
        .map((_, i) => (
          <div
            key={i}
            className="bg-card border border-border rounded-xl h-40 animate-pulse"
          />
        ))}
    </div>
  )
}

// Presentation helpers (CONDITIONS, REASON_LABEL, rejectionSummary,
// formatters) are centralised in ../lib/wheelFormat so /wheel, the
// Pulse SuggestedWheel strip, and the on-demand WheelAnalyze panel
// never drift on the locked UX contracts.
