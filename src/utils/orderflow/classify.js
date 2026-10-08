// Trade classification: buyer-initiated (+1), seller-initiated (−1) or
// indeterminate (0).
//
// Method (Lee & Ready 1991, with the quote taken at trade time):
//   1. Quote rule — at/above the ask = buy, at/below the bid = sell.
//   2. Inside the spread — above the midpoint = buy, below = sell.
//   3. At the midpoint, or with no usable quote — tick rule: uptick (or
//      zero-uptick) = buy, downtick (or zero-downtick) = sell.
// Candle colour is never used. Prints whose sale conditions make them
// non-contemporaneous (late, out of sequence, average-price, derivatively
// priced, auction crosses…) and off-market prints are kept as volume but
// never classified and never move the price series.

// UTP / CTA sale-condition codes that disqualify a print from
// classification and from the last-sale price.
export const EXCLUDED_CONDITIONS = Object.freeze({
  Z: 'sold out of sequence',
  U: 'extended hours sold out of sequence',
  L: 'sold last (late report)',
  W: 'average price',
  B: 'average price (CTA)',
  4: 'derivatively priced',
  P: 'prior reference price',
  C: 'cash sale',
  N: 'next day',
  R: 'seller',
  V: 'contingent',
  7: 'qualified contingent',
  G: 'bunched sold',
  H: 'price variation',
  Q: 'market-center official open',
  M: 'market-center official close',
  O: 'opening print',
  6: 'closing print',
  5: 'reopening print',
})

export function conditionFlags(conditions) {
  const out = []
  for (const ch of String(conditions ?? '')) if (EXCLUDED_CONDITIONS[ch]) out.push(ch)
  return out
}

// Quote quality: { ok, crossed, locked, oneSided, spreadPct, ageMs, grade }
export function quoteQuality(quote, atMs, cfg, eth = false) {
  if (!quote || quote.bid == null || quote.ask == null) return { ok: false, grade: 'none', reason: 'no quote' }
  const ageMs = atMs - quote.t
  const maxAge = eth ? cfg.maxQuoteAgeEthMs : cfg.maxQuoteAgeMs
  const crossed = quote.bid > quote.ask
  const locked = quote.bid === quote.ask
  const oneSided = !(quote.bid > 0) || !(quote.ask > 0)
  const mid = (quote.bid + quote.ask) / 2
  const spreadPct = mid > 0 ? (quote.ask - quote.bid) / mid : null
  const stale = ageMs > maxAge
  let grade = 'good'
  if (crossed || oneSided || stale) grade = 'poor'
  else if (locked || spreadPct > 0.03) grade = 'fair'
  return { ok: !(crossed || oneSided || stale), crossed, locked, oneSided, stale, spreadPct, ageMs, mid, grade }
}

// tick: { last: last valid price, dir: +1 | -1 | 0 } — the tick-rule state.
export function tickSide(price, tick) {
  if (tick.last == null) return 0
  if (price > tick.last) return 1
  if (price < tick.last) return -1
  return tick.dir || 0   // zero tick → inherits the last non-zero direction
}

export function classifyTrade(trade, quote, tick, cfg) {
  const flags = conditionFlags(trade.conds)
  if (trade.valid === false) return { side: 0, method: 'none', confidence: 'none', excluded: 'invalid tick (feed flag)' }
  if (flags.length) return { side: 0, method: 'none', confidence: 'none', excluded: flags.map((c) => EXCLUDED_CONDITIONS[c]).join(', ') }

  // Prefer the bid/ask stamped on the print itself (dxFeed TimeAndSale
  // carries the NBBO at execution), else the latest quote before it.
  const q = trade.bid != null && trade.ask != null && trade.bid > 0 && trade.ask > 0
    ? { t: trade.t, bid: trade.bid, ask: trade.ask }
    : quote
  const qq = quoteQuality(q, trade.t - (cfg.quoteLagMs || 0), cfg, trade.eth)

  if (qq.ok) {
    const spread = q.ask - q.bid
    const off = Math.abs(trade.price - qq.mid)
    if (off > Math.max(cfg.offMarketSpreads * spread, cfg.offMarketPct * qq.mid)) {
      return { side: 0, method: 'none', confidence: 'none', excluded: 'off-market print' }
    }
    if (trade.price >= q.ask) return { side: 1, method: 'quote', confidence: 'high', qq }
    if (trade.price <= q.bid) return { side: -1, method: 'quote', confidence: 'high', qq }
    if (!qq.locked) {
      if (trade.price > qq.mid) return { side: 1, method: 'midpoint', confidence: 'medium', qq }
      if (trade.price < qq.mid) return { side: -1, method: 'midpoint', confidence: 'medium', qq }
    }
  }
  const s = tickSide(trade.price, tick)
  return { side: s, method: s ? 'tick' : 'none', confidence: s ? 'low' : 'none', qq }
}
