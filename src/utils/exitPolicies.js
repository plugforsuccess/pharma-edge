// Job 1 exit policies (research/top-forming/PREREG.md §4). A holder owns the
// stock from the close of entry day t; rules are checked at each close and
// fill at the next open with slippage; whatever is left sells at the close of
// t + horizon. Pure; npm run exitpolicies:check.
import { STAGE_RANK } from './topForming.js'

export const EXIT = Object.freeze({
  horizon: 120, slip: 0.001, flatTrail: 0.25,
  stageTrail: Object.freeze({ clear: 0.25, extended: 0.20, distribution: 0.15, broken: 0.10 }),
  targets: Object.freeze([[1.5, 1 / 3], [2.0, 1 / 3]]),
  doubleWithin: 252, minPeak: 0.10,
})
const BY_RANK = ['clear', 'extended', 'distribution', 'broken']
export const POLICIES = Object.freeze([
  { key: 'hold', name: 'Buy-and-hold', trail: null, targets: false },
  { key: 'trail25', name: '25% trail', trail: 'flat', targets: false },
  { key: 'thirds', name: '⅓ / ⅓ / runner', trail: 'flat', targets: true },
  { key: 'stage', name: 'Stage trail', trail: 'stage', targets: false },
  { key: 'thirdsStage', name: '⅓ / ⅓ / runner + stage trail', trail: 'stage', targets: true },
])

// bars: [{ o, c }]; stage: per-day stage names (or null). → { R, exitIdx, fills: [{ i, frac, px }] }
export function simulate(bars, t, policy, stage = [], p = EXIT) {
  const end = t + p.horizon
  if (end >= bars.length) return null
  const entry = bars[t].c
  let left = 1, peak = entry, maxRank = STAGE_RANK[stage[t]] ?? 0, proceeds = 0, exitIdx = null
  const hit = p.targets.map(() => false)
  const fills = []
  const sell = (i, frac, px) => { const f = Math.min(left, frac); if (f <= 0) return; proceeds += f * px * (1 - p.slip); left -= f; fills.push({ i, frac: f, px }); if (left <= 1e-12) { left = 0; exitIdx = i } }
  for (let d = t + 1; d <= end; d++) {
    if (left <= 0) break
    const cd = bars[d].c
    if (d === end) { sell(d, left, cd); break }
    peak = Math.max(peak, cd)
    maxRank = Math.max(maxRank, STAGE_RANK[stage[d]] ?? 0)
    const fillPx = bars[d + 1].o > 0 ? bars[d + 1].o : bars[d + 1].c
    let orders = 0
    if (policy.targets) p.targets.forEach(([mult, frac], k) => { if (!hit[k] && cd >= entry * mult) { hit[k] = true; orders += frac } })
    let trailOut = false
    if (policy.trail) {
      const trail = policy.trail === 'flat' ? p.flatTrail : p.stageTrail[BY_RANK[maxRank]]
      if (cd <= peak * (1 - trail)) trailOut = true
    }
    if (trailOut) sell(d + 1, left, fillPx)
    else if (orders > 0) sell(d + 1, orders, fillPx)
  }
  return { R: proceeds / entry - 1, exitIdx, fills }
}

// Peak gain within the horizon and the first close ≥ 2× entry within doubleWithin (index or null).
export function entryFacts(bars, t, p = EXIT) {
  const end = t + p.horizon
  if (end >= bars.length) return null
  const entry = bars[t].c
  let pk = entry
  for (let d = t + 1; d <= end; d++) pk = Math.max(pk, bars[d].c)
  let dbl = null
  for (let d = t + 1; d <= Math.min(bars.length - 1, t + p.doubleWithin); d++) if (bars[d].c >= 2 * entry) { dbl = d; break }
  return { G: pk / entry - 1, dbl, doubleKnown: t + p.doubleWithin < bars.length || dbl != null }
}
// Early exit from a doubler: fully out before the first 2× close.
export const exitedEarly = (sim, facts) => facts.dbl != null && sim.exitIdx != null && sim.exitIdx < facts.dbl

// The run-up entry rule: close ≥ 1.5 × the lowest low of t−59…t.
export function isRunUp(bars, t, mult = 1.5, look = 60) {
  if (t < look - 1) return false
  let lo = Infinity
  for (let j = t - look + 1; j <= t; j++) lo = Math.min(lo, bars[j].l)
  return bars[t].c >= mult * lo
}
