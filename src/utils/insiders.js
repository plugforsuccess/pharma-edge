// Insider and short-interest signals (owner, 2026-10-20: "Run it", after the
// weakness test). Pure facts on a day from filings made by that day.
// Thresholds fixed before the test (docs/signal-engine/preregistration.md,
// "the insider / short-interest test"). npm run insiders:check.

export const INSIDER = Object.freeze({
  clusterDays: 90,     // window for the sell / buy clusters (calendar days)
  sellCluster: 3,      // distinct insiders selling, with no buyer
  buyCluster: 2,       // distinct insiders buying
  netDays: 180,        // window for net selling
  netRatio: 10,        // $ sold ≥ 10× $ bought
  netMinSold: 1e6,     // and at least $1M sold
  shortRiseDays: 91,   // short interest vs ~3 months earlier
  shortRise: 0.5,      // up 50%+
  shortHigh: 0.10,     // shares short ≥ 10% of shares outstanding
})
export const INSIDER_SIGNALS = ['sellCluster', 'netSelling', 'buyCluster', 'shortRising', 'shortHigh']

const DAY = 86400e3
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY

// trades: [{ filed, date, code: 'S'|'P', shares, price, owner }] for one
// issuer (any order). asOf: 'YYYY-MM-DD'. Only filings on or before asOf
// count, and only trades dated inside the window.
export function insiderSignals(trades, asOf, p = INSIDER) {
  const sellers = new Set(), buyers = new Set()
  let sold = 0, bought = 0, any = false
  for (const t of trades ?? []) {
    if (!t.filed || t.filed > asOf || !t.date) continue
    const age = daysBetween(t.date, asOf)
    if (age < 0) continue
    any = true
    const usd = (t.shares ?? 0) * (t.price ?? 0)
    if (age <= p.clusterDays) { if (t.code === 'S') sellers.add(t.owner); else if (t.code === 'P') buyers.add(t.owner) }
    if (age <= p.netDays) { if (t.code === 'S') sold += usd; else if (t.code === 'P') bought += usd }
  }
  return {
    known: any,
    sellCluster: sellers.size >= p.sellCluster && buyers.size === 0,
    netSelling: sold >= p.netMinSold && sold >= p.netRatio * Math.max(bought, 1),
    buyCluster: buyers.size >= p.buyCluster,
    sellers: sellers.size, buyers: buyers.size, sold, bought,
  }
}

// shorts: [{ date, shares }] settlement dates (any order); sharesOut: the
// latest cover-page share count filed by asOf (null → shortHigh unknown).
export function shortSignals(shorts, asOf, sharesOut, p = INSIDER) {
  const rows = (shorts ?? []).filter((s) => s.date && s.date <= asOf && s.shares != null).sort((a, b) => a.date.localeCompare(b.date))
  if (!rows.length) return { known: false, shortRising: false, shortHigh: false, short: null, ratio: null }
  const cur = rows[rows.length - 1]
  if (daysBetween(cur.date, asOf) > 45) return { known: false, shortRising: false, shortHigh: false, short: null, ratio: null } // stale feed
  const target = Date.parse(cur.date) - p.shortRiseDays * DAY
  let prev = null
  for (const r of rows) { if (Date.parse(r.date) <= target) prev = r; else break }
  const ratio = sharesOut > 0 ? cur.shares / sharesOut : null
  return {
    known: true,
    shortRising: !!(prev && prev.shares > 0 && cur.shares / prev.shares - 1 >= p.shortRise),
    shortHigh: ratio != null && ratio >= p.shortHigh,
    short: cur.shares, ratio,
  }
}

// The pass mark (preregistration.md, "the insider / short-interest test"):
// rare flags, so recall is reported, not required.
export const INSIDER_PASS = Object.freeze({ lift: 2, medianGap: 0.05, minFlagged: 200 })
export function insiderVerdict(s, { mirror = false } = {}, p = INSIDER_PASS) {
  if (!s || s.lift == null || s.medianRet == null || s.medianAll == null) return 'inconclusive'
  if (s.flagged < p.minFlagged) return 'inconclusive'
  if (mirror) return s.medianRet >= s.medianAll + p.medianGap ? 'pass' : 'fail'
  return s.lift >= p.lift && s.medianRet <= s.medianAll - p.medianGap ? 'pass' : 'fail'
}
