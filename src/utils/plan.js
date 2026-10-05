// Context badge, Triple status and the reclaim plan for the entry chart
// (owner, 2026-10-05). Pure; `npm run plan:check`.
//
//   trendQuality  the trend-quality gate from the signal-engine review:
//                 drawdown from the 252-bar high ≤ 25% and the 200-day
//                 rising for ≥ 60 bars → "Trend pullback"; else "Recovery
//                 setup — higher risk". A badge, not a rule: nothing trades
//                 on it until it passes the walk-forward ablation.
//   tripleStatus  the Triple events (Bravo + Echo + Tango within 2 bars) on
//                 a bar series, with the latest of each side
//   reclaimPlan   trigger = weekly close above the reclaim zone's high;
//                 invalidation = weekly close below its low; targets = the
//                 next upper band and prior pivot highs above price; % to
//                 each level from the current close and reward : risk

import { tripleEvents } from './signalSuite.js'

export const TREND_GATE = Object.freeze({ maxDrawdown: 0.25, minDays200Up: 60, highLookback: 252 })

export function trendQuality(bars, model, i = bars.length - 1, gate = TREND_GATE) {
  if (!bars?.length || i < 0) return null
  let hi = 0
  for (let k = Math.max(0, i - gate.highLookback + 1); k <= i; k++) hi = Math.max(hi, bars[k].h)
  const drawdown = hi > 0 ? 1 - bars[i].c / hi : null
  let days200Up = 0
  for (let k = i; k >= 0 && model?.slope200?.[k] != null && model.slope200[k] > 0; k--) days200Up++
  const pass = drawdown != null && drawdown <= gate.maxDrawdown && days200Up >= gate.minDays200Up
  return {
    drawdown, days200Up, pass,
    label: pass ? 'Trend pullback' : 'Recovery setup — higher risk',
    why: pass ? `${Math.round(drawdown * 100)}% off its high · 200-day rising ${days200Up} days`
      : [drawdown != null && drawdown > gate.maxDrawdown ? `${Math.round(drawdown * 100)}% off its high (gate: ≤ ${Math.round(gate.maxDrawdown * 100)}%)` : null,
        days200Up < gate.minDays200Up ? `200-day rising ${days200Up} days (gate: ≥ ${gate.minDays200Up})` : null].filter(Boolean).join(' · '),
  }
}

export function tripleStatus(bars, suite, within = 2) {
  const ev = tripleEvents(suite, within)
  const n = bars.length
  const list = (flags) => flags.map((f, i) => (f ? { i, t: bars[i].t, price: bars[i].c } : null)).filter(Boolean)
  const bull = list(ev.bull), bear = list(ev.bear)
  const last = (xs) => (xs.length ? { ...xs[xs.length - 1], barsAgo: n - 1 - xs[xs.length - 1].i } : null)
  return { bull, bear, lastBull: last(bull), lastBear: last(bear), within }
}

// weekly = { close, zoneLow, zoneHigh, upperBand } from the weekly suite's
// last bar; pivots = prior swing-high prices (any order).
export function reclaimPlan({ close, weekly, pivots = [] }) {
  if (!(close > 0) || !weekly || weekly.zoneLow == null || weekly.zoneHigh == null) return null
  const pctTo = (lvl) => (lvl != null && close > 0 ? lvl / close - 1 : null)
  const risk = close - weekly.zoneLow
  const rr = (lvl) => (lvl != null && risk > 0 && lvl > close ? (lvl - close) / risk : null)
  const targets = []
  if (weekly.upperBand != null && weekly.upperBand > close) targets.push({ label: 'Upper band', level: weekly.upperBand })
  // Pivots above price, nearest first; a second pivot only when it is at
  // least 3% past the first (two highs a dollar apart are one level).
  const sorted = [...new Set(pivots.filter((p) => p > close * 1.005).map((p) => Math.round(p * 100) / 100))].sort((a, b) => a - b)
  const above = []
  for (const p of sorted) { if (!above.length || p >= above[above.length - 1] * 1.03) above.push(p); if (above.length === 2) break }
  above.forEach((p, k) => targets.push({ label: k === 0 ? 'Prior pivot' : 'Next pivot', level: p }))
  targets.sort((a, b) => a.level - b.level)
  return {
    close,
    position: close > weekly.zoneHigh ? 'above' : close < weekly.zoneLow ? 'below' : 'inside',
    trigger: { level: weekly.zoneHigh, met: weekly.close > weekly.zoneHigh, pct: pctTo(weekly.zoneHigh) },
    invalidation: { level: weekly.zoneLow, hit: weekly.close < weekly.zoneLow, pct: pctTo(weekly.zoneLow) },
    targets: targets.map((t) => ({ ...t, pct: pctTo(t.level), rr: rr(t.level) })),
    risk: risk > 0 ? risk / close : null,
  }
}
