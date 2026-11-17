// What the jumps that gained had in common (pre-registered 2026-11-14). Traits read at the
// jump close, plus two "known later" ones kept apart. Pure; npm run jumptraits:check.
import { reportOnJump } from './jumpRecord.js'

export const TRAIT_PASS = Object.freeze({ lift: 0.08, minN: 30 })
const SHELF = new Set(['S-3', 'S-3ASR', '424B5'])
const OFFER = new Set(['S-1', 'S-1/A', 'S-3', 'S-3ASR', '424B1', '424B2', '424B3', '424B4', '424B5'])

// What the SEC filings around the jump say caused it (−1 … +1 day; offerings −3 … +3).
export function jumpCause(fl, t) {
  const near = (f, a, b) => f.date >= addDays(t, a) && f.date <= addDays(t, b)
  const k8 = fl.filter((f) => f.form === '8-K' && near(f, -1, 1)).flatMap((f) => f.items ?? [])
  if (fl.some((f) => f.form === '8-K' && (f.items ?? []).includes('2.02') && near(f, -3, 1))) return 'earnings'
  if (fl.some((f) => OFFER.has(f.form) && near(f, -3, 3))) return 'offering'
  if (k8.includes('1.01')) return 'agreement (1.01)'
  if (k8.includes('2.01')) return 'deal closed (2.01)'
  if (k8.includes('8.01') || k8.includes('7.01')) return 'other news'
  return 'no filing'
}
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10)
const sma = (bars, i, n) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += bars[k].c; return s / n }

// ctx: { filings, siPct, runwayQ, binary, spyUp, jumps: boolean[] (eventFlags) }
export function jumpTraits(bars, e, ctx = {}) {
  const b = bars[e], a = bars[e - 1]
  if (!b || !a || e < 130) return null
  const t = b.t
  let v = 0; for (let k = e - 20; k < e; k++) v += bars[k].v ?? 0
  const volX = v > 0 ? b.v / (v / 20) : null
  let dv = 0; for (let k = e - 20; k < e; k++) dv += (bars[k].v ?? 0) * bars[k].c
  dv /= 20
  const jump = b.c / a.c - 1
  const rng = b.h - b.l
  const m200 = sma(bars, e - 1, 200)
  const p6 = bars[e - 126] ? a.c / bars[e - 126].c - 1 : null
  const fl = ctx.filings ?? null
  let prior = false
  if (ctx.jumps) for (let k = Math.max(0, e - 60); k < e; k++) if (ctx.jumps[k]) { prior = true; break }
  return {
    earnings: fl ? (reportOnJump(fl, t) ? 'yes' : 'no') : null,
    size: jump < 0.25 ? '10–25%' : jump < 0.5 ? '25–50%' : '50%+',
    volume: volX == null ? null : volX < 5 ? '3–5×' : volX < 10 ? '5–10×' : '10×+',
    closeHigh: rng > 0 ? ((b.c - b.l) / rng >= 0.8 ? 'yes' : 'no') : null,
    above200: m200 == null ? null : a.c > m200 ? 'above' : 'below',
    prior6m: p6 == null ? null : p6 <= -0.5 ? 'down 50%+' : p6 < 0 ? 'down 0–50%' : 'up',
    price: b.c < 2 ? '< $2' : b.c < 5 ? '$2–5' : '$5+',
    dollarVol: dv < 5e6 ? '$1–5M' : '$5M+',
    shorts: ctx.siPct == null ? null : ctx.siPct >= 0.15 ? '15%+' : 'under 15%',
    runway: ctx.runwayQ == null ? null : ctx.runwayQ < 4 ? '< 4 qtrs' : ctx.runwayQ < 8 ? '4–8 qtrs' : '8+ qtrs',
    shelf: fl ? (fl.some((f) => SHELF.has(f.form) && f.date <= t && f.date >= addDays(t, -90)) ? 'yes' : 'no') : null,
    binary: ctx.binary == null ? null : ctx.binary ? 'yes' : 'no',
    spy: ctx.spyUp == null ? null : ctx.spyUp ? 'above 200d' : 'below 200d',
    priorJump: prior ? 'yes' : 'no',
    // Added 2026-11-17 (bigger-names pre-registration): what caused it, earnings ahead, market mood.
    cause: fl ? jumpCause(fl, t) : null,
    earningsAhead: fl ? (fl.some((f) => f.form === '8-K' && (f.items ?? []).includes('2.02') && f.date > addDays(t, 1) && f.date <= addDays(t, 30)) ? 'yes' : 'no') : null,
    vix: ctx.vix == null ? null : ctx.vix < 20 ? 'VIX < 20' : ctx.vix < 30 ? 'VIX 20–30' : 'VIX 30+',
    smallCaps: ctx.iwmUp == null ? null : ctx.iwmUp ? 'IWM above 200d' : 'IWM below 200d',
    // Known later — reported apart.
    saleAfter: fl ? (fl.some((f) => OFFER.has(f.form) && f.date > t && f.date <= addDays(t, 30)) ? 'yes' : 'no') : null,
    nextDay: bars[e + 1] ? (bars[e + 1].c > b.c ? 'yes' : 'no') : null,
    week: bars[e + 5] ? (bars[e + 5].c > b.c ? 'yes' : 'no') : null,
  }
}
export const LATER = new Set(['nextDay', 'week', 'saleAfter'])

// The outcome at `h` sessions from the jump close; null when not reached.
export function jumpOutcome6(bars, e, h = 126) {
  const to = e + h
  if (!bars[to]) return null
  const r = bars[to].c / bars[e].c - 1
  return { ret: r, gained: r > 0, doubled: r >= 1 }
}

const med = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }

// rows: [{ traits, out }] → { all, by: { trait: { bucket: { n, gained, doubled, median, lift } } } }
export function traitTable(rows) {
  const ok = rows.filter((r) => r.traits && r.out)
  const share = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : null)
  const all = { n: ok.length, gained: share(ok, (r) => r.out.gained), doubled: share(ok, (r) => r.out.doubled), median: med(ok.map((r) => r.out.ret)) }
  const by = {}
  for (const r of ok) for (const [k, v] of Object.entries(r.traits)) {
    if (v == null) continue
    ;((by[k] ??= {})[v] ??= []).push(r)
  }
  for (const k of Object.keys(by)) for (const v of Object.keys(by[k])) {
    const xs = by[k][v]
    const g = share(xs, (r) => r.out.gained)
    by[k][v] = { n: xs.length, gained: g, doubled: share(xs, (r) => r.out.doubled), median: med(xs.map((r) => r.out.ret)), lift: g - all.gained }
  }
  return { all, by }
}

// A bucket holds when it lifts the gain share by ≥ 8 points in both sets, same sign, ≥ 30 jumps each.
export function traitHolds(d, c, p = TRAIT_PASS) {
  if (!d || !c || d.n < p.minN || c.n < p.minN) return 'too few'
  if (Math.abs(d.lift) >= p.lift && Math.abs(c.lift) >= p.lift && Math.sign(d.lift) === Math.sign(c.lift)) return d.lift > 0 ? 'holds · more gain' : 'holds · fewer gain'
  return 'no'
}
