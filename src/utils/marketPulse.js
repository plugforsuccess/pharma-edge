// The market on one screen (owner, 2026-10-19: "the leaders, their
// momentum, the market"). Pure: the nightly ranking hands in what it has
// already computed; the result is one market_pulse row.
//   trend    S&P 500 vs its 200-day (and that average's 20-day slope)
//   breadth  share of the universe above its own 200-day
//   leaders  how many stocks meet the Leaders rule, and the groups they sit in
//   vix      level and 5-day change

const sma = (xs, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += xs[k]; return s / n }
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000)

// spy / vix: daily bars [{ t, c }]; stocks: [{ ticker, vs200 }] (today's
// distance above the 200-day, null when unknown); leaders: ranked rows
// [{ ticker, theme }] in rank order.
export function marketPulse({ asOf, spy = [], vix = [], stocks = [], leaders = [] }) {
  const out = { as_of: asOf }
  if (spy.length >= 221) {
    const c = spy.map((b) => b.c), i = c.length - 1
    const m = sma(c, 200, i), m20 = sma(c, 200, i - 20)
    out.spy_close = r4(c[i])
    out.spy_200 = r4(m)
    out.spy_vs200 = r4(c[i] / m - 1)
    out.spy_slope200 = r4(m / m20 - 1)
    out.spy_above = c[i] > m
    out.spy_1m = c.length > 21 ? r4(c[i] / c[i - 21] - 1) : null
    // How many closes in a row the S&P has been on this side of its 200-day
    // ("above its 200-day for 112 days"), and the last 3 months of closes.
    let k = i
    while (k > 199 && (c[k - 1] > sma(c, 200, k - 1)) === out.spy_above) k--
    out.spy_streak = i - k + 1
    out.spy_spark = c.slice(-63).map((x) => r4(x))
  }
  if (vix.length >= 6) {
    const c = vix.map((b) => b.c), i = c.length - 1
    out.vix = r4(c[i])
    out.vix_5d = r4(c[i] - c[i - 5])
    out.vix_spark = c.slice(-63).map((x) => r4(x))
  }
  const known = stocks.filter((s) => s.vs200 != null)
  out.universe = known.length
  out.above200 = known.filter((s) => s.vs200 > 0).length
  out.breadth = known.length ? r4(out.above200 / known.length) : null
  out.leaders = leaders.length
  const g = new Map()
  for (const l of leaders) { const name = l.theme ?? 'Other'; if (!g.has(name)) g.set(name, []); g.get(name).push(l.ticker) }
  out.groups = [...g].map(([name, tickers]) => ({ name, n: tickers.length, tickers }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
  return out
}

// Plain-words read of the market for the card's headline.
export function marketRead(p) {
  if (!p || p.spy_above == null) return null
  const trend = p.spy_above ? (p.spy_slope200 > 0 ? 'Uptrend' : 'Above a flat 200-day') : 'Downtrend'
  const tone = p.spy_above && p.spy_slope200 > 0 ? 'green' : p.spy_above ? 'amber' : 'red'
  const breadth = p.breadth == null ? null : p.breadth >= 0.6 ? 'broad' : p.breadth >= 0.4 ? 'mixed' : 'narrow'
  return { trend, tone, breadth }
}
