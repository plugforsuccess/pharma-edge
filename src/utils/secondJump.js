// The second jump (pre-registered 2026-10-27, docs/signal-engine/preregistration.md):
// does the next jump on a stock from the tape list hold better than jumps in
// general? Pure functions on daily bars + FINRA short interest; shares only.
// npm run secondjump:check.
import { FADE } from './fade.js'
import { HOLDING_RISK } from './holdingRisks.js'

export const SECOND_JUMP = Object.freeze({
  litLook: 60,      // listed on any of the 60 sessions before the jump
  gap: 21,          // one jump per stock per 21 sessions
  holds: [21, 63, 126],
  horizon: 126,
  target: 0.40,
  fall: 0.40, rise: 1.00,
  siHigh: 0.15,     // split: short interest ≥ 15% of shares out the session before
})
export const SECOND_JUMP_PASS = Object.freeze({ minN: 100, medianGap: 0.10 })

const DAY = 86400e3
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY

// isEvent[k]: a close up ≥ 10% on volume ≥ 3× the prior 20-day average (FADE's definition).
export function eventFlags(bars, p = FADE) {
  const out = new Array(bars.length).fill(false)
  let s = 0
  for (let k = 0; k < bars.length; k++) {
    if (k >= 21) {
      const b = bars[k], a = bars[k - 1]
      if (b.v > 0 && a.c > 0 && b.c / a.c - 1 >= p.eventJump && b.v >= p.eventVolX * (s / 20)) out[k] = true
    }
    s += bars[k].v ?? 0
    if (k >= 20) s -= bars[k - 20].v ?? 0
  }
  return out
}

// Close on or before a date (binary search; bars sorted by t).
function closeOn(bars, d) {
  let lo = 0, hi = bars.length - 1, c = null
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].t <= d) { c = bars[m].c; lo = m + 1 } else hi = m - 1 }
  return c
}

// The scan definition per session: 20+ sessions in a row below the latest jump close
// (jumps within the last 60) AND short interest up ≥ 15% over ≥ 30 days with the price down ≥ 10%.
// Same numbers as catalystRow / shortsRow in holdingRisks.js, computed in one pass.
export function listedFlags(bars, isEvent, shorts = [], p = HOLDING_RISK, f = FADE) {
  const n = bars.length, out = new Array(n).fill(false)
  const si = [...(shorts ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  let lastEv = -1, below = 0, sp = -1
  for (let i = 0; i < n; i++) {
    if (isEvent[i]) { lastEv = i; below = 0 } else if (lastEv >= 0) below = bars[i].c < bars[lastEv].c ? below + 1 : 0
    while (sp + 1 < si.length && si[sp + 1].date <= bars[i].t) sp++
    if (lastEv < 0 || i - lastEv >= f.eventLook || below < p.belowSessions || sp < 0) continue
    const cur = si[sp]
    if (days(cur.date, bars[i].t) > p.siStale) continue
    let prev = null
    for (let q = sp - 1; q >= 0; q--) if (days(si[q].date, cur.date) >= p.siDays) { prev = si[q]; break }
    if (!prev || !(prev.shares > 0) || cur.shares / prev.shares - 1 < p.siRise) continue
    const c0 = closeOn(bars, prev.date), c1 = closeOn(bars, cur.date)
    if (c0 && c1 && c1 / c0 - 1 <= -p.priceDrop) out[i] = true
  }
  return out
}

// Buy at the open after bar e; measures from that open. null when the horizon isn't complete.
export function jumpOutcome(bars, e, p = SECOND_JUMP) {
  const s = e + 1, end = s + p.horizon
  if (end >= bars.length) return null
  const entry = bars[s].o > 0 ? bars[s].o : bars[s].c
  if (!(entry > 0)) return null
  let lo = Infinity, hi = 0, hitAt = null
  for (let k = s; k <= end; k++) {
    lo = Math.min(lo, bars[k].l ?? bars[k].c); hi = Math.max(hi, bars[k].h ?? bars[k].c)
    if (hitAt == null && bars[k].c >= entry * (1 + p.target)) hitAt = k
  }
  const ret = Object.fromEntries(p.holds.map((h) => [h, bars[s + h].c / entry - 1]))
  return { entry, ret, target: hitAt != null ? bars[hitAt].c / entry - 1 : ret[p.horizon], hit: hitAt != null, daysToHit: hitAt != null ? hitAt - s : null, fell: lo / entry - 1 <= -p.fall, doubled: hi / entry - 1 >= p.rise }
}

// Counted jumps: one per stock per `gap` sessions, from index `from`.
export function countedJumps(isEvent, from = 0, gap = SECOND_JUMP.gap) {
  const out = []
  let last = -Infinity
  for (let k = from; k < isEvent.length; k++) if (isEvent[k] && k - last > gap) { out.push(k); last = k }
  return out
}

export const wasListed = (listed, e, look = SECOND_JUMP.litLook) => { for (let j = Math.max(0, e - look); j < e; j++) if (listed[j]) return true; return false }

const med = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
const avg = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const rate = (xs, k) => (xs.length ? xs.filter((r) => r[k]).length / xs.length : null)

export function jumpStats(outs, p = SECOND_JUMP) {
  const o = outs.filter(Boolean)
  const holds = Object.fromEntries(p.holds.map((h) => [h, { median: med(o.map((r) => r.ret[h])), avg: avg(o.map((r) => r.ret[h])), win: o.length ? o.filter((r) => r.ret[h] > 0).length / o.length : null }]))
  return { n: o.length, holds, target: { median: med(o.map((r) => r.target)), avg: avg(o.map((r) => r.target)), hitRate: rate(o, 'hit'), medDays: med(o.filter((r) => r.hit).map((r) => r.daysToHit)) }, fell: rate(o, 'fell'), doubled: rate(o, 'doubled') }
}

// The recorded rule: listed vs control A (unlisted jumps) and control B (any day).
export function secondJumpVerdict(listed, unlisted, anyDay, p = SECOND_JUMP, pass = SECOND_JUMP_PASS) {
  if (listed.n < pass.minN) return 'inconclusive'
  const h = p.horizon
  const ok = listed.holds[h].median != null && unlisted.holds[h].median != null && listed.holds[h].median - unlisted.holds[h].median >= pass.medianGap && listed.fell != null && anyDay.fell != null && listed.fell <= anyDay.fell
  return ok ? 'pass' : 'fail'
}
