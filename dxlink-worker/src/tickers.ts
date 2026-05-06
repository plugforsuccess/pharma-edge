// Curated ticker tracking list for the DXLink worker.
//
// MUST stay synced with HOT_TICKERS in `src/lib/tickerUniverse.js`
// (frontend) — those are the names the UI shows the green "LIVE" dot
// next to. If you add a ticker here, add it there too, and vice
// versa. (Deno workers can't import from src/lib so we duplicate.)
//
// We subscribe to the front-month + next-month chain for each ticker.
// At ~50 tickers × 2 expirations × ~50 strikes × 2 sides × 3 event
// types we hit ~30,000 dxFeed subscriptions — well under any per-
// connection cap. Memory footprint stays under 200MB on the Fly VM.
//
// Tickers not in this list still work in /markets — compute-gex falls
// back to Yahoo's 15-min delayed feed so users can pull GEX for any
// S&P 500 name, just without the real-time stream.

export const TRACKED_TICKERS: string[] = [
  // Index ETFs (highest options volume on the planet)
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  // Volatility / commodity / rates ETFs
  'GLD',
  'SLV',
  'TLT',
  'USO',
  // Mega-cap tech
  'AAPL',
  'MSFT',
  'NVDA',
  'GOOGL',
  'AMZN',
  'META',
  'TSLA',
  // Big tech / SaaS / semis
  'AMD',
  'AVGO',
  'INTC',
  'ORCL',
  'CRM',
  'ADBE',
  'NFLX',
  // Memory / DRAM
  'MU',
  'WDC',
  // Banks
  'JPM',
  'GS',
  'BAC',
  'WFC',
  // Healthcare / pharma
  'LLY',
  'NVO',
  'PFE',
  'MRK',
  'JNJ',
  'UNH',
  'ABBV',
  // Consumer
  'WMT',
  'COST',
  'HD',
  'MCD',
  'NKE',
  'DIS',
  // Energy
  'XOM',
  'CVX',
  'COP',
  // Liquid retail / meme / fintech
  'COIN',
  'PLTR',
  'UBER',
  'ARM',
  'BABA',
  'GME',
]

// How many expirations to subscribe to per ticker. 2 = front month +
// next month. Each option subscription is a separate dxFeed entry
// so going wider here multiplies the bandwidth.
export const EXPIRATIONS_PER_TICKER = 2

// Strikes-per-side ATM window. We trim to ATM ± WINDOW_PCT * spot
// because gamma decays quickly at the wings; subscribing beyond that
// is wasted bandwidth and database churn.
export const STRIKE_WINDOW_PCT = 0.25
