// What kind of bet a leader is (owner, 2026-10-16: "Is cluster the best
// taxonomy you can come up with?" — the top 10 were really chips, oil and
// refiners). Each ticker is named after the industry fund its daily moves
// track most closely over the last 120 trading days: SNDK → Chips (SMH),
// VLO → Refiners (CRAK), APA → Oil (XOP). Broad sector funds (XLK, XLE …)
// only win when no industry fund comes within 0.05, so chips don't read as
// "Tech". Below a 0.6 correlation a ticker gets no theme — it moves on its
// own. Leaders sharing a theme are one bet.

export const THEMES = Object.freeze([
  ['SMH', 'Chips & AI'], ['IGV', 'Software'], ['HACK', 'Cybersecurity'], ['SKYY', 'Cloud'], ['FDN', 'Internet'],
  ['XOP', 'Oil'], ['CRAK', 'Refiners'], ['OIH', 'Oil services'], ['AMLP', 'Pipelines'],
  ['KRE', 'Regional banks'], ['KBE', 'Banks'], ['IAI', 'Brokers'], ['KIE', 'Insurance'],
  ['XBI', 'Biotech'], ['XPH', 'Pharma'], ['IHI', 'Medical devices'], ['IHF', 'Health insurers'],
  ['ITB', 'Homebuilders'], ['XRT', 'Retail'], ['ITA', 'Defense'], ['JETS', 'Airlines'], ['IYT', 'Transports'],
  ['XME', 'Metals & mining'], ['GDX', 'Gold miners'], ['URA', 'Uranium'], ['TAN', 'Solar'], ['LIT', 'Batteries'],
  ['PAVE', 'Infrastructure'], ['PBJ', 'Food & drink'],
  // Broad sector funds — the fallback names.
  ['XLK', 'Tech'], ['XLE', 'Oil'], ['XLF', 'Financials'], ['XLV', 'Health care'], ['XLI', 'Industrials'],
  ['XLB', 'Materials'], ['XLY', 'Consumer'], ['XLP', 'Staples'], ['XLU', 'Utilities'], ['XLC', 'Media & telecom'],
  ['XLRE', 'Real estate'],
])
export const BROAD = new Set(['XLK', 'XLE', 'XLF', 'XLV', 'XLI', 'XLB', 'XLY', 'XLP', 'XLU', 'XLC', 'XLRE'])
export const THEME = Object.freeze({ window: 120, minCorr: 0.6, broadPenalty: 0.05 })

// Daily log returns keyed by date, the last `n` of them.
export function returnsByDate(bars, n = THEME.window) {
  const out = new Map()
  for (let i = Math.max(1, bars.length - n); i < bars.length; i++) {
    const a = bars[i - 1].c, b = bars[i].c
    if (a > 0 && b > 0) out.set(String(bars[i].t), Math.log(b / a))
  }
  return out
}

// Correlation over the dates both series have (null under 40 shared days).
export function corrByDate(a, b) {
  const x = [], y = []
  for (const [t, v] of a) { const w = b.get(t); if (w != null) { x.push(v); y.push(w) } }
  const n = x.length
  if (n < 40) return null
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null
}

// fundReturns: Map(etf → returnsByDate). → { name, etf, corr } or null.
// A ticker that is itself a theme fund takes that theme.
export function themeOf(ticker, bars, fundReturns, p = THEME) {
  const own = THEMES.find(([etf]) => etf === ticker)
  if (own) return { name: own[1], etf: own[0], corr: 1 }
  const r = returnsByDate(bars, p.window)
  let best = null
  for (const [etf, name] of THEMES) {
    const f = fundReturns.get(etf)
    if (!f) continue
    const c = corrByDate(r, f)
    if (c == null || c < p.minCorr) continue
    const score = c - (BROAD.has(etf) ? p.broadPenalty : 0)
    if (!best || score > best.score) best = { name, etf, corr: Math.round(c * 100) / 100, score }
  }
  if (!best) return null
  const { score: _s, ...out } = best
  return out
}

// The bets in a list of leaders (rank order): one entry per shared theme
// (2+ leaders) and one per leader that stands alone.
// rows: [{ ticker, theme: string | null }] → [{ name, tickers, alone }]
export function betsOf(rows) {
  const count = new Map()
  for (const r of rows) if (r.theme) count.set(r.theme, (count.get(r.theme) ?? 0) + 1)
  const out = [], seen = new Map()
  for (const r of rows) {
    if (r.theme && count.get(r.theme) > 1) {
      if (!seen.has(r.theme)) { const b = { name: r.theme, tickers: [], alone: false }; seen.set(r.theme, b); out.push(b) }
      seen.get(r.theme).tickers.push(r.ticker)
    } else out.push({ name: r.ticker, tickers: [r.ticker], alone: true })
  }
  return out
}
