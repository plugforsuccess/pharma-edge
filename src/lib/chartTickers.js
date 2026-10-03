import { TICKER_UNIVERSE } from './tickerUniverse'

// Tickers the Charts search lists: the 11 SPDR sector ETFs the LEAPS ideas
// rank (suggest-leaps) first under "Popular", then the app's ticker list.
export const SECTOR_ETFS = [
  ['XLK', 'Technology'], ['XLF', 'Financials'], ['XLV', 'Health Care'], ['XLE', 'Energy'],
  ['XLI', 'Industrials'], ['XLY', 'Consumer Discretionary'], ['XLP', 'Consumer Staples'],
  ['XLU', 'Utilities'], ['XLB', 'Materials'], ['XLRE', 'Real Estate'], ['XLC', 'Communication Services'],
].map(([symbol, label]) => ({ symbol, label: `${label} sector`, isHot: true }))

export const CHART_TICKERS = (() => {
  const seen = new Set(SECTOR_ETFS.map((t) => t.symbol))
  return [...SECTOR_ETFS, ...TICKER_UNIVERSE.filter((t) => !seen.has(t.symbol))]
})()
