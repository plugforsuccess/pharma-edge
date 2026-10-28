// Top Forming thresholds and weights (research/top-forming/PREREG.md, 2026-10-28).
// Never hard-code these in the signal code; a change here is a new addendum.
export const TOP_FORMING = Object.freeze({
  version: 'prereg-2026-10-28',
  a1: Object.freeze({ sma: 250, lo: 0.25, hi: 1.00, pctWindow: 756 }),
  a2: Object.freeze({ window: 30, r2: 0.85, fast: 10, slow: 60, ratio: 2 }),
  a3: Object.freeze({ atr: 14, window: 252 }),
  b1: Object.freeze({ volAvg: 50, volX: 3, wick: 0.5, lowThird: 1 / 3, recent: 10 }),
  b2: Object.freeze({ window: 25, lo: 3, hi: 6 }),
  b3: Object.freeze({ fractal: 5, within: 60, rsi: 14 }),
  b4: Object.freeze({ gap: 0.05, extMin: 0.50, fill: 3, recent: 10 }),
  b5: Object.freeze({ high: 252 }),
  e1: Object.freeze({ sma: 50, extMin: 0.30, within: 40 }),
  e2: Object.freeze({ weeks: 10 }),
  e3: Object.freeze({ within: 40, fail: 5 }),
  weights: Object.freeze({ A: 0.20, B: 0.30, E: 0.10, C: 0.30, D: 0 }),
  stages: Object.freeze({ extended: 35, distribution: 60, aStrong: 0.5, bStrong: 0.5, bCount: 2, lookback: 20 }),
  stageOrder: Object.freeze(['clear', 'extended', 'distribution', 'broken']),
  stageNames: Object.freeze({ clear: 'Clear', extended: 'Extended', distribution: 'Distribution', broken: 'Trend broken' }),
})
