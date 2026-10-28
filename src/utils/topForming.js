// Top Forming signals, score and stage for every day of one stock's daily bars
// (research/top-forming/PREREG.md). Day t uses data through the close of t only.
// Pure; npm run topforming:check. Measurements, not instructions.
import { TOP_FORMING } from './topFormingConfig.js'

const clamp01 = (x) => Math.max(0, Math.min(1, x))
const ramp = (x, lo, hi) => (x == null || !Number.isFinite(x) ? null : clamp01((x - lo) / (hi - lo)))

export function smaSeries(xs, n) {
  const out = new Array(xs.length).fill(null)
  let s = 0
  for (let i = 0; i < xs.length; i++) { s += xs[i]; if (i >= n) s -= xs[i - n]; if (i >= n - 1) out[i] = s / n }
  return out
}
// Wilder RSI.
export function rsiSeries(c, n = 14) {
  const out = new Array(c.length).fill(null)
  let g = 0, l = 0
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(0, d), dn = Math.max(0, -d)
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l) } continue }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
  }
  return out
}
export function obvSeries(c, v) {
  const out = new Array(c.length).fill(0)
  for (let i = 1; i < c.length; i++) out[i] = out[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0)
  return out
}
export function atrSeries(bars, n = 14) {
  const out = new Array(bars.length).fill(null)
  let s = 0
  const tr = bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l))
  for (let i = 0; i < bars.length; i++) { s += tr[i]; if (i >= n) s -= tr[i - n]; if (i >= n - 1) out[i] = s / n }
  return out
}
// Rank of x among the window (share of values ≤ x).
const pctRank = (arr, end, n, x) => { let k = 0, m = 0; for (let j = Math.max(0, end - n + 1); j <= end; j++) { if (arr[j] == null) continue; m++; if (arr[j] <= x) k++ } return m ? k / m : null }

// Quadratic fit of y on x = 0..n-1 → { c, r2 }.
export function quadFit(y) {
  const n = y.length
  let S0 = n, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0
  for (let x = 0; x < n; x++) { const x2 = x * x; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2; T0 += y[x]; T1 += x * y[x]; T2 += x2 * y[x] }
  // Solve [[S0,S1,S2],[S1,S2,S3],[S2,S3,S4]] [a,b,c] = [T0,T1,T2] by Cramer's rule.
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const M = [[S0, S1, S2], [S1, S2, S3], [S2, S3, S4]], D = det(M)
  if (!D) return null
  const a = det([[T0, S1, S2], [T1, S2, S3], [T2, S3, S4]]) / D
  const b = det([[S0, T0, S2], [S1, T1, S3], [S2, T2, S4]]) / D
  const c = det([[S0, S1, T0], [S1, S2, T1], [S2, S3, T2]]) / D
  const mean = T0 / n
  let ssr = 0, sst = 0
  for (let x = 0; x < n; x++) { const f = a + b * x + c * x * x; ssr += (y[x] - f) ** 2; sst += (y[x] - mean) ** 2 }
  return { a, b, c, r2: sst > 0 ? 1 - ssr / sst : 0 }
}

// Confirmed swing highs (fractal k): index i is known at i + k.
export function swingHighs(bars, k) {
  const out = []
  for (let i = k; i < bars.length - k; i++) {
    let top = true
    for (let j = i - k; j <= i + k && top; j++) if (j !== i && (bars[j].h > bars[i].h || (bars[j].h === bars[i].h && j < i))) top = false
    if (top) out.push(i)
  }
  return out
}

// Completed-week closes → 10-week SMA below test per day (only weeks ended before the current week).
function weekKeyOf(d) { const t = new Date(`${d}T12:00:00Z`); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day); return t.toISOString().slice(0, 10) }

// → { signals: { A1: [], … }, groups: { A, B, E }, score: [], stage: [], ext: [], ext pct: [] }
export function topFormingSeries(bars, cfg = TOP_FORMING) {
  const n = bars.length
  const c = bars.map((b) => b.c), v = bars.map((b) => b.v ?? 0)
  const sma250 = smaSeries(c, cfg.a1.sma), sma50 = smaSeries(c, cfg.e1.sma), vol50 = smaSeries(v, cfg.b1.volAvg)
  const atr = atrSeries(bars, cfg.a3.atr), rsi = rsiSeries(c, cfg.b3.rsi), obv = obvSeries(c, v)
  const ext = c.map((x, i) => (sma250[i] ? x / sma250[i] - 1 : null))
  const atrp = atr.map((a, i) => (a != null ? a / c[i] : null))
  const lc = c.map(Math.log)
  const sh = swingHighs(bars, cfg.b3.fractal)
  const S = { A1: [], A2: [], A3: [], B1: [], B2: [], B3: [], B4: [], B5: [], E1: [], E2: [], E3: [] }
  const extPct = new Array(n).fill(null)
  // B1 / B4 event days.
  const climax = new Array(n).fill(false), gapFill = new Array(n).fill(false)
  for (let i = 1; i < n; i++) {
    const b = bars[i], r = b.h - b.l
    const avg = vol50[i - 1]
    if (avg > 0 && v[i] > cfg.b1.volX * avg && r > 0) {
      const upper = (b.h - Math.max(b.o, b.c)) / r, pos = (b.c - b.l) / r
      if (upper >= cfg.b1.wick || pos <= cfg.b1.lowThird) climax[i] = true
    }
  }
  for (let i = 1; i < n; i++) {
    if (!(ext[i - 1] > cfg.b4.extMin) || !(bars[i].o > c[i - 1] * (1 + cfg.b4.gap))) continue
    for (let j = i; j <= Math.min(n - 1, i + cfg.b4.fill); j++) if (bars[j].l <= c[i - 1]) { gapFill[j] = true; break }
  }
  // Weekly closes (completed weeks).
  const wk = bars.map((b) => weekKeyOf(b.t))
  const weekClose = [] // [{ key, c }]
  const e2 = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    if (i > 0 && wk[i] !== wk[i - 1]) weekClose.push({ key: wk[i - 1], c: c[i - 1] })
    const m = cfg.e2.weeks
    if (weekClose.length >= m) { let s = 0; for (let k = weekClose.length - m; k < weekClose.length; k++) s += weekClose[k].c; e2[i] = weekClose.at(-1).c < s / m ? 1 : 0 }
  }
  let shPtr = 0
  const known = [] // confirmed swing highs up to day i
  for (let i = 0; i < n; i++) {
    while (shPtr < sh.length && sh[shPtr] + cfg.b3.fractal <= i) known.push(sh[shPtr++])
    // A1
    S.A1.push(ramp(ext[i], cfg.a1.lo, cfg.a1.hi))
    if (ext[i] != null && i >= cfg.a1.pctWindow - 1) extPct[i] = pctRank(ext, i, cfg.a1.pctWindow, ext[i])
    // A2
    let a2 = null
    if (i >= Math.max(cfg.a2.window, cfg.a2.slow)) {
      const f = quadFit(lc.slice(i - cfg.a2.window + 1, i + 1))
      const fast = (lc[i] - lc[i - cfg.a2.fast]) / cfg.a2.fast, slow = (lc[i] - lc[i - cfg.a2.slow]) / cfg.a2.slow
      a2 = f && f.c > 0 && f.r2 > cfg.a2.r2 && fast > cfg.a2.ratio * slow && slow > 0 ? 1 : 0
    }
    S.A2.push(a2)
    // A3
    S.A3.push(atrp[i] != null && i >= cfg.a3.window ? pctRank(atrp, i, cfg.a3.window, atrp[i]) : null)
    // B1
    let b1 = 0; for (let j = Math.max(0, i - cfg.b1.recent + 1); j <= i; j++) if (climax[j]) b1 = 1
    S.B1.push(i >= cfg.b1.volAvg ? b1 : null)
    // B2
    let dd = 0; for (let j = Math.max(1, i - cfg.b2.window + 1); j <= i; j++) if (c[j] < c[j - 1] && v[j] > v[j - 1]) dd++
    S.B2.push(i >= cfg.b2.window ? ramp(dd, cfg.b2.lo, cfg.b2.hi) : null)
    // B3: last two confirmed swing highs within the window
    let b3 = null
    if (i >= 60) {
      const rec = known.filter((k) => i - k <= cfg.b3.within)
      if (rec.length >= 2) {
        const [h1, h2] = rec.slice(-2)
        const higher = bars[h2].h > bars[h1].h
        const r = higher && rsi[h2] != null && rsi[h1] != null && rsi[h2] < rsi[h1] ? 1 : 0
        const o = higher && obv[h2] < obv[h1] ? 1 : 0
        b3 = (r + o) / 2
      } else b3 = 0
    }
    S.B3.push(b3)
    // B4
    let b4 = 0; for (let j = Math.max(0, i - cfg.b4.recent + 1); j <= i; j++) if (gapFill[j]) b4 = 1
    S.B4.push(i >= cfg.a1.sma ? b4 : null)
    // B5: after the 252-session high, the last two confirmed swing highs each lower than the one before
    let b5 = null
    if (i >= cfg.b5.high) {
      let hi = -Infinity, hk = -1
      for (let j = i - cfg.b5.high + 1; j <= i; j++) if (bars[j].h > hi) { hi = bars[j].h; hk = j }
      const after = known.filter((k) => k > hk)
      b5 = after.length >= 2 && bars[after.at(-2)].h < hi && bars[after.at(-1)].h < bars[after.at(-2)].h ? 1 : 0
    }
    S.B5.push(b5)
    // E1
    let e1 = null
    if (sma50[i] != null && i >= cfg.a1.sma) {
      let was = false; for (let j = Math.max(0, i - cfg.e1.within + 1); j <= i; j++) if (ext[j] > cfg.e1.extMin) was = true
      e1 = c[i] < sma50[i] && was ? 1 : 0
    }
    S.E1.push(e1)
    S.E2.push(i >= 60 ? e2[i] : null)
    // E3: break below SMA50 within the window, a retest high ≥ SMA50, no close above within 5, today below every close since the break
    let e3 = null
    if (sma50[i] != null && i > 60) {
      e3 = 0
      let brk = -1
      for (let j = i; j > Math.max(50, i - cfg.e3.within); j--) if (c[j] < sma50[j] && c[j - 1] >= sma50[j - 1]) { brk = j; break }
      if (brk > 0) {
        for (let r = brk + 1; r < i; r++) {
          if (!(bars[r].h >= sma50[r])) continue
          let reclaimed = false
          for (let q = r; q <= Math.min(i, r + cfg.e3.fail - 1); q++) if (c[q] > sma50[q]) reclaimed = true
          if (reclaimed || r + cfg.e3.fail - 1 >= i) continue
          let low = Infinity; for (let q = brk; q < i; q++) low = Math.min(low, c[q])
          if (c[i] < low) { e3 = 1; break }
        }
      }
    }
    S.E3.push(e3)
  }
  const mean = (arr) => { const v = arr.filter((x) => x != null); return v.length === arr.length && v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
  const groups = { A: [], B: [], E: [] }, score = [], stage = []
  const W = cfg.weights, T = cfg.stages
  for (let i = 0; i < n; i++) {
    const A = mean([S.A1[i], S.A2[i], S.A3[i]]), B = mean([S.B1[i], S.B2[i], S.B3[i], S.B4[i], S.B5[i]]), E = mean([S.E1[i], S.E2[i], S.E3[i]])
    groups.A.push(A); groups.B.push(B); groups.E.push(E)
    if (A == null || B == null || E == null) { score.push(null); stage.push(null); continue }
    const sc = (100 * (W.A * A + W.B * B + W.E * E)) / (W.A + W.B + W.E)
    score.push(sc)
    const anyE = S.E1[i] === 1 || S.E2[i] === 1 || S.E3[i] === 1
    let recentDist = false
    for (let j = Math.max(0, i - T.lookback); j < i; j++) if (stage[j] === 'distribution' || stage[j] === 'broken') recentDist = true
    const bCount = ['B1', 'B2', 'B3', 'B4', 'B5'].filter((k) => S[k][i] >= T.bStrong).length
    stage.push(anyE && recentDist ? 'broken' : sc >= T.distribution && bCount >= T.bCount ? 'distribution' : sc >= T.extended && A >= T.aStrong ? 'extended' : 'clear')
  }
  return { signals: S, groups, score, stage, ext, extPct }
}

export const STAGE_RANK = Object.freeze({ clear: 0, extended: 1, distribution: 2, broken: 3 })
