// Curated ticker tracking list for the DXLink worker.
//
// MUST stay synced with HOT_TICKERS in `src/lib/tickerUniverse.js`
// (frontend) — those are the names the UI shows the green "LIVE" dot
// next to. If you add a ticker here, add it there too, and vice
// versa. (Deno workers can't import from src/lib so we duplicate.)
//
// We subscribe to the front-month + next-month chain for each ticker.
// At ~70 tickers × 2 expirations × ~50 strikes × 2 sides × 3 event
// types we hit ~42,000 dxFeed subscriptions — well under any per-
// connection cap. Memory footprint stays under 250MB on the Fly VM.
// (List grew 2026-05-07: added 6 semis, 8 AI-infra names, 6 power
// names. Run `fly deploy` from dxlink-worker/ to pick up the chain
// plan refresh — until then those tickers fall back to Yahoo's
// 15-min delayed feed.)
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
  // Volatility / commodity / rates / credit ETFs
  'GLD',
  'SLV',
  'TLT',
  'USO',
  'HYG',
  'EEM',
  // Sector SPDRs
  'XLK',
  'XLF',
  'XLE',
  'XLV',
  'XLY',
  'XLP',
  'XLU',
  'XLI',
  'XLB',
  'XLC',
  'XLRE',
  // Theme ETFs (semis, banks, biotech, china, innovation, bitcoin)
  'SMH',
  'SOXX',
  'KRE',
  'XBI',
  'KWEB',
  'ARKK',
  'IBIT',
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
  'CSCO',
  'HPE',
  'ADBE',
  'NFLX',
  'NOW',
  // Semis (foundry / equipment / mobile / networking-silicon)
  'TSM',
  'ASML',
  'AMAT',
  'LRCX',
  'QCOM',
  'MRVL',
  // Memory / DRAM / NAND
  'MU',
  'WDC',
  'SNDK',
  'DRAM',
  // AI infrastructure (data center, GPU cloud, networking, servers)
  'VRT',
  'DLR',
  'EQIX',
  'CRWV',
  'NBIS',
  'IREN',
  'BTMR',
  'SMCI',
  'ANET',
  'NOK',
  // Banks (incl. regional dividend payers used as wheel candidates)
  'JPM',
  'GS',
  'BAC',
  'WFC',
  'HBAN',
  'KEY',
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
  'KO',
  'SIRI',
  // Autos
  'F',
  // Energy (oil majors + midstream)
  'XOM',
  'CVX',
  'COP',
  'KMI',
  // AI power / nuclear renaissance
  'VST',
  'CEG',
  'NEE',
  'SMR',
  'OKLO',
  'CCJ',
  'BE',
  // Rare earths / lithium / solar — strategic-materials supply chain
  'MP',
  'LAC',
  'USAR',
  'CRML',
  'UUU',
  'TE',
  // Liquid retail / meme / fintech
  'COIN',
  'PLTR',
  'UBER',
  'ARM',
  'BABA',
  'GME',
  'SOFI',
  // Bitcoin miners (also Aschenbrenner portfolio)
  'RIOT',
  'CLSK',
]

// How many expirations to subscribe to per ticker. 2 = front month +
// next month. Each option subscription is a separate dxFeed entry
// so going wider here multiplies the bandwidth.
export const EXPIRATIONS_PER_TICKER = 2

// Strikes-per-side ATM window. We trim to ATM ± WINDOW_PCT * spot
// because gamma decays quickly at the wings; subscribing beyond that
// is wasted bandwidth and database churn.
export const STRIKE_WINDOW_PCT = 0.25
