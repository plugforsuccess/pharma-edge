// MatrixSummaryCard — structured GEX-matrix summary + Claude narrative.
//
// Two variants:
//   * variant="compact" — used on the play detail page. 4 stat tiles
//     (regime, king wall, flip, pin prob) + a one-sentence
//     "why this play" narrative. The matrix prop comes from
//     claude_calls.matrix_at_call so the narrative describes the
//     matrix at the time the play was suggested, not the live one.
//   * variant="full" — used on /markets Summary view. 7 stat tiles +
//     a 2-3 sentence regime narrative. The matrix prop is the live
//     compute-gex payload.
//
// The structured fields are derived locally; only the narrative is
// fetched (from explain-matrix edge fn) and only when the qualitative
// state of the matrix changes (fingerprint-based caching).

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Derive presentational summary from a compute-gex MatrixOutput payload.
// All compute lives in compute-gex; we just project.
function deriveSummary(matrix, liveSpot = null) {
  if (!matrix) return null
  const netGex = Number(matrix.net_gex ?? 0)
  const regime = netGex >= 0 ? 'A' : 'B'
  const regimeLabel = regime === 'A' ? 'Pin-friendly' : 'Trending'

  const kingWallStrike = matrix.largest?.strike ?? null
  const kingWallGex = matrix.largest?.gex_net ?? null
  const kingWallSide = kingWallGex != null
    ? (kingWallGex > 0 ? 'call' : 'put')
    : null

  // Flip strike — for single-strike mode compute-gex returns
  // zero_gamma_strike directly; for matrix mode we walk the cumulative
  // GEX through the front expiration column and find the sign change.
  // Strikes are descending in the matrix so walk ascending order.
  let flipStrike = matrix.zero_gamma_strike ?? null
  if (flipStrike == null && Array.isArray(matrix.cells) && Array.isArray(matrix.strikes)) {
    const ascendingIdx = [...Array(matrix.strikes.length).keys()].reverse()
    let cumulative = 0
    let prev = 0
    for (const i of ascendingIdx) {
      const v = Number(matrix.cells[i]?.[0] ?? 0)
      prev = cumulative
      cumulative += v
      if ((prev <= 0 && cumulative > 0) || (prev >= 0 && cumulative < 0)) {
        flipStrike = matrix.strikes[i]
        break
      }
    }
  }

  return {
    ticker: matrix.ticker,
    // Prefer the live dxlink poll over matrix.spot (server-cached up
    // to 5 min) so the headline spot matches the Markets header and
    // the GexMatrix ▶ cursor exactly — they use this same idiom
    // (GexMatrix.jsx:79). The EM-today / EM-realized tiles below
    // stay server-as-of-compute on purpose (they're timestamped
    // "Updated HH:MM") — only the headline spot tracks live.
    spot: (Number.isFinite(liveSpot) && liveSpot > 0)
      ? Number(liveSpot)
      : Number(matrix.spot ?? 0),
    regime,
    regimeLabel,
    netGex,
    kingWallStrike,
    kingWallGex,
    kingWallSide,
    flipStrike,
    pinningProb: Number(matrix.pinning_probability ?? 0),
    expectedMove: Number(matrix.expected_move ?? 0),
    expectedMoveToday: Number(matrix.expected_move_today ?? 0),
    realizedPctOfToday: matrix.realized_pct_of_today ?? null,
    netDex: Number(matrix.net_dex ?? 0),
    source: matrix.source ?? 'unknown',
    computedAt: matrix.computed_at ?? matrix.computedAt ?? null,
  }
}

function fmtMillions(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const num = Number(n)
  const abs = Math.abs(num)
  const sign = num >= 0 ? '' : '−'
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(0)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`
  return `${sign}${abs.toFixed(0)}`
}

function fmtMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `$${Number(n).toFixed(2)}`
}

function fmtTime(iso) {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
  catch { return '' }
}

export default function MatrixSummaryCard({ matrix, variant = 'full', play = null, liveSpot = null }) {
  const summary = deriveSummary(matrix, liveSpot)
  const [narrative, setNarrative] = useState(null)
  const [narrativeLoading, setNarrativeLoading] = useState(true)

  // Bucketize values so unchanged qualitative state doesn't refetch.
  const pinBucket = summary?.pinningProb != null
    ? Math.round(summary.pinningProb * 10)
    : 0
  const wallStrikeRounded = summary?.kingWallStrike != null
    ? Math.round(summary.kingWallStrike)
    : null
  const flipRounded = summary?.flipStrike != null
    ? Math.round(summary.flipStrike)
    : null

  useEffect(() => {
    if (!summary) return
    let cancelled = false
    setNarrativeLoading(true)

    const mode = variant === 'compact' ? 'play_context' : 'regime_summary'
    const body = {
      mode,
      summary: {
        ticker: summary.ticker,
        spot: summary.spot,
        net_gex: summary.netGex,
        king_wall_strike: summary.kingWallStrike,
        king_wall_gex: summary.kingWallGex,
        flip_strike: summary.flipStrike,
        pinning_probability: summary.pinningProb,
        expected_move: summary.expectedMove,
        expected_move_today: summary.expectedMoveToday,
        realized_pct_of_today: summary.realizedPctOfToday,
        net_dex: summary.netDex,
        source: summary.source,
        computed_at: summary.computedAt,
      },
      play: play ? {
        strategy: play.strategy,
        long_strike: play.long_strike,
        short_strike: play.short_strike,
        dte: play.dte,
        thesis_kind: play.thesis_kind,
      } : undefined,
    }

    supabase.functions
      .invoke('explain-matrix', { body })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error || !data?.success) {
          setNarrative(null)
        } else {
          setNarrative(data.narrative)
        }
        setNarrativeLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          setNarrative(null)
          setNarrativeLoading(false)
        }
      })

    return () => { cancelled = true }
    // Dependencies are bucketed values so spot drift inside the same
    // bucket doesn't refire the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    summary?.ticker,
    summary?.regime,
    wallStrikeRounded,
    flipRounded,
    pinBucket,
    variant,
    play?.long_strike,
    play?.short_strike,
    play?.dte,
  ])

  if (!summary) return null

  if (variant === 'compact') {
    return (
      <section className="bg-card border border-border rounded-xl p-4 space-y-2">
        <header className="flex items-center justify-between">
          <h3 className="text-zinc-300 text-[11px] font-semibold uppercase tracking-wider">
            Why this play
          </h3>
          <span className="text-[10px] text-zinc-500">
            {summary.source} · {fmtTime(summary.computedAt)}
          </span>
        </header>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <Row label="Regime" value={`${summary.regime} · ${summary.regimeLabel}`} />
          <Row
            label="King wall"
            value={summary.kingWallStrike != null
              ? `${fmtMoney(summary.kingWallStrike)} ${summary.kingWallSide}`
              : '—'}
          />
          <Row label="Flip strike" value={fmtMoney(summary.flipStrike)} />
          <Row label="Pin prob" value={`${(summary.pinningProb * 100).toFixed(0)}%`} />
        </div>
        {narrativeLoading ? (
          <p className="text-xs text-zinc-500 italic pt-1 border-t border-border">
            Reading the matrix…
          </p>
        ) : narrative ? (
          <p className="text-sm text-zinc-200 leading-snug pt-1 border-t border-border">
            {narrative}
          </p>
        ) : null}
      </section>
    )
  }

  // Full variant
  return (
    <section className="bg-card border border-border rounded-xl p-4 space-y-3">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-white text-base font-semibold">
            {summary.ticker} Matrix Summary
          </h2>
          <p className="text-[11px] text-zinc-500">
            Spot {fmtMoney(summary.spot)} · {summary.source} · Updated {fmtTime(summary.computedAt)}
          </p>
        </div>
        <RegimeBadge regime={summary.regime} label={summary.regimeLabel} />
      </header>

      {narrativeLoading ? (
        <p className="text-sm text-zinc-500 italic">Reading the matrix…</p>
      ) : narrative ? (
        <p className="text-sm text-zinc-200 leading-relaxed">{narrative}</p>
      ) : (
        <p className="text-xs text-zinc-500">Narrative unavailable.</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm pt-3 border-t border-border">
        <Stat
          label="Net GEX"
          value={`$${fmtMillions(summary.netGex)}`}
          tone={summary.netGex >= 0 ? 'pos' : 'neg'}
        />
        <Stat
          label="King wall"
          value={summary.kingWallStrike != null
            ? `${fmtMoney(summary.kingWallStrike)} ${summary.kingWallSide}`
            : '—'}
        />
        <Stat label="Flip strike" value={fmtMoney(summary.flipStrike)} />
        <Stat
          label="Pin prob"
          value={`${(summary.pinningProb * 100).toFixed(0)}%`}
          tone={summary.pinningProb >= 0.6 ? 'pos' : summary.pinningProb >= 0.3 ? 'warn' : 'neg'}
        />
        <Stat label="EM today" value={fmtMoney(summary.expectedMoveToday)} />
        <Stat
          label="EM realized"
          value={summary.realizedPctOfToday != null
            ? `${(summary.realizedPctOfToday * 100).toFixed(0)}%`
            : '—'}
        />
        <Stat
          label="Dealer delta"
          value={`${summary.netDex >= 0 ? 'long' : 'short'} $${fmtMillions(Math.abs(summary.netDex))}`}
        />
        <Stat label="Source" value={summary.source} />
      </div>
    </section>
  )
}

function Row({ label, value }) {
  return (
    <>
      <span className="text-zinc-500">{label}</span>
      <span className="text-right text-white font-medium">{value}</span>
    </>
  )
}

function Stat({ label, value, tone }) {
  const toneClass =
    tone === 'pos' ? 'text-emerald-400'
      : tone === 'neg' ? 'text-rose-400'
      : tone === 'warn' ? 'text-amber-400'
      : 'text-white'
  return (
    <div>
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-semibold ${toneClass}`}>{value}</div>
    </div>
  )
}

function RegimeBadge({ regime, label }) {
  const color = regime === 'A'
    ? 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10'
    : 'text-rose-400 border-rose-400/30 bg-rose-400/10'
  return (
    <div className={`px-2 py-1 rounded-md border text-[11px] font-semibold ${color}`}>
      Regime {regime} · {label}
    </div>
  )
}
