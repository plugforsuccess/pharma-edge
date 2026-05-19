// Underlying universe to scan for qualifying prints.
//
// Polygon's /v3/snapshot/options/{underlying} requires you to specify
// the underlying — there's no "scan everything" endpoint at affordable
// rate limits. We scan a curated list aligned with HOT_TICKERS in the
// frontend (HeatPulse) + the most active single-stock options names.
//
// Universe expansion is cheap (each underlying is one snapshot call
// per scanner loop); diminishing returns kick in past ~30 names
// because whale prints concentrate in the same liquid tape.

export const SCAN_UNIVERSE: readonly string[] = [
  // Indices / ETFs
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'SMH', 'TLT', 'VIX', 'VXX', 'GLD',
  // Mega-cap tech
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'TSLA', 'AVGO', 'AMD',
  // High-flow single names
  'NFLX', 'COIN', 'PLTR', 'CRWD', 'SNOW', 'ORCL', 'CRM', 'ADBE', 'NOK',
  // High-RV small/mid
  'MSTR', 'HOOD', 'RBLX', 'SOFI', 'RIVN', 'LCID',
  // Pharma / biotech
  'LLY', 'NVO', 'MRNA',
  // Financials / banks
  'JPM', 'BAC', 'GS', 'WFC',
  // Volatile newcomers
  'BTMR', 'BE', 'NOW',
]
