// Curated ticker tracking list.
//
// MVP: just the highest-volume index ETFs and single names. We
// subscribe to the front-month + next-month chains for each. Total
// subscription count = ~tickers × 2 expirations × ~80 strikes × 2
// (call + put) — comfortably under DXLink's per-connection limit on
// the prod feed.
//
// Adding a ticker: append below and redeploy the worker. compute-gex
// will start serving it the moment the first frame lands in
// dxlink_quotes.

export const TRACKED_TICKERS: string[] = [
  // Index ETFs
  'SPY',
  'QQQ',
  'IWM',
  // Mega-cap single names where dealer hedging actually moves the tape
  'AAPL',
  'NVDA',
  'TSLA',
  'MSFT',
  'AMD',
  'AMZN',
  'META',
  'GOOGL',
  // Large-cap biotechs (keeps the original strategy connected)
  'LLY',
  'NVO',
  'MRK',
  'PFE',
]

// How many expirations to subscribe to per ticker. 2 = front month +
// next month. Each option subscription is a separate dxFeed entry
// so going wider here multiplies the bandwidth.
export const EXPIRATIONS_PER_TICKER = 2

// Strikes-per-side ATM window. We trim to ATM ± WINDOW_PCT * spot
// because gamma decays quickly at the wings; subscribing beyond that
// is wasted bandwidth and database churn.
export const STRIKE_WINDOW_PCT = 0.25
