// Small numeric helpers for the order-flow engine.
export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x))
export const sum = (a) => a.reduce((s, x) => s + x, 0)
export const mean = (a) => (a.length ? sum(a) / a.length : null)

export function median(a) {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function std(a) {
  if (a.length < 2) return null
  const m = mean(a)
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1))
}

// Ordinary least squares slope through the origin-free fit y = a + b·x.
export function slope(xs, ys) {
  const n = xs.length
  if (n < 3) return null
  const mx = mean(xs), my = mean(ys)
  let sxy = 0, sxx = 0
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2 }
  return sxx > 0 ? sxy / sxx : null
}

export function quantile(a, q) {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

// Deterministic PRNG (mulberry32) for the synthetic demo and bootstrap.
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
