// Puts and shorts on a Stopped-believing stock (owner, 2026-11-14: "for losers we care
// about puts and shorts only"). Owner-only on the entry chart — subscribers see the facts,
// never a trade. Prices the three instruments the bear tests used, today, with the same
// model (jumpBear.js: σ = 1.3 × 60-day realised vol, floor 15%; Black-Scholes; 2% slip),
// and carries each test's recorded result. Estimates, not quotes. Pure; npm run losertrades:check.
import { bsPut } from './replay.js'
import { jumpVol, JUMP_BEAR } from './jumpBear.js'

export const TRADEABLE = Object.freeze({ minPrice: 3, minDollarVol: 10e6 })
// Recorded results (variants.md): average return per trade, test years 2024 →.
export const BEAR_RECORD = Object.freeze({
  fresh: { label: 'entered the open after a jump', n: 883, put: -0.325, spread: -0.116, short: -0.285, source: '2026-10-27, control A' },
  list: { label: 'entered the day a stock landed on the list', n: 189, put: -0.416, spread: -0.184, short: -0.447, source: '2026-10-28, all list entries' },
})

export function dollarVol20(bars) {
  const n = bars?.length ?? 0
  if (n < 20) return null
  let s = 0
  for (let k = n - 20; k < n; k++) s += (bars[k].v ?? 0) * bars[k].c
  return s / 20
}

// bars: daily OHLCV through the latest close → { price, vol, adv, tradeable, why, put, spread, short }.
export function bearPlan(bars, p = JUMP_BEAR) {
  const n = bars?.length ?? 0
  if (n < p.volBars + 2) return null
  const S = bars[n - 1].c, vol = jumpVol(bars, n - 1, p.premium, p)
  if (!(S > 0) || !vol) return null
  const adv = dollarVol20(bars)
  const why = [S < TRADEABLE.minPrice ? `under $${TRADEABLE.minPrice}` : null, adv != null && adv < TRADEABLE.minDollarVol ? 'thin volume' : null].filter(Boolean)
  const Tp = p.put.primary / p.year, Ts = p.spread.horizon / p.year
  const put = bsPut(S, S, Tp, vol, p.rate) * (1 + p.slip)
  const K2 = S * Math.max(0.05, 1 - vol * Math.sqrt(Ts))
  const debit = Math.max(0, bsPut(S, S, Ts, vol, p.rate) - bsPut(S, K2, Ts, vol, p.rate)) * (1 + p.slip)
  const width = S - K2
  return {
    price: S, vol, adv, tradeable: why.length === 0, why,
    put: { strike: S, days: p.put.primary, cost: put, breakeven: S - put, needs: put / S },
    spread: { long: S, short: K2, days: p.spread.horizon, debit, width, ratio: width > 0 ? debit / width : null, withinCap: width > 0 && debit / width <= p.spread.maxDebit },
    short: { price: S, borrows: p.short.borrows, stop: p.short.primary.stop },
  }
}
