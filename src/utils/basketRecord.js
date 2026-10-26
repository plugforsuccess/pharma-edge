// The quality basket's forward record (basket_record rows, append-only,
// hashed). Equal-weight index: on each close every member's close over its
// previous close is averaged; a rebalance day starts the next segment from
// the new members. Price only, no dividends, no costs. npm run basketrecord:check.
export function basketIndex(rows) {
  const r = [...(rows ?? [])].sort((a, b) => a.as_of.localeCompare(b.as_of))
  if (!r.length) return null
  let basket = 1, spy = 1, prev = null
  const series = []
  for (const row of r) {
    if (prev && !row.rebalanced) {
      const idx = new Map(prev.tickers.map((t, i) => [t, prev.closes[i]]))
      const rets = row.tickers.map((t, i) => (idx.has(t) && idx.get(t) > 0 ? row.closes[i] / idx.get(t) : null)).filter((x) => x != null)
      if (rets.length) basket *= rets.reduce((a, b) => a + b, 0) / rets.length
    } else if (prev && row.rebalanced) {
      // Members changed: the old members' move to this close is the last leg of the old segment.
      const idx = new Map(row.tickers.map((t, i) => [t, row.closes[i]]))
      const rets = prev.tickers.map((t, i) => (idx.has(t) && prev.closes[i] > 0 ? idx.get(t) / prev.closes[i] : null)).filter((x) => x != null)
      if (rets.length) basket *= rets.reduce((a, b) => a + b, 0) / rets.length
    }
    if (prev && prev.spy_close > 0 && row.spy_close > 0) spy *= row.spy_close / prev.spy_close
    series.push({ as_of: row.as_of, basket: basket - 1, spy: spy - 1, members: row.tickers.length, rebalanced: !!row.rebalanced })
    prev = row
  }
  const last = series[series.length - 1]
  return { start: r[0].as_of, end: last.as_of, days: series.length, basket: last.basket, spy: last.spy, members: r[r.length - 1].tickers, rebalances: series.filter((s) => s.rebalanced).length, series }
}
