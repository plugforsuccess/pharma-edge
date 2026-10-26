// Risk facts on a holding (owner, 2026-10-26, after the Fade Screen test —
// the score failed its pass mark, but "yes to 'failed catalyst' and 'shorts
// pressing' as plain risk facts on a holding, no verdict wording, no tier";
// runway: "keep it as a displayed fact, drop it as a score input").
//
// Two halves: `riskRow` builds the stored row (scripts/holding-risks.mjs runs
// it nightly on every ticker a user holds or has starred → ticker_risks);
// `holdingRiskFacts` turns a row into lines for a card. Facts only: what
// happened, dated and priced — never what to do about it.
import { FADE, eventDays, failedCatalyst, runway, cashAt, quarterlyOcfAt } from './fade.js'

export const HOLDING_RISK = Object.freeze({
  runwayShow: 8,        // show the runway fact only under 8 quarters of cash
  runwayTight: 3,       // amber under 3 quarters (the test's "full" threshold)
  siRise: FADE.siRise,  // short interest up ≥ 15% vs the settlement ~30 days earlier
  siDays: FADE.siDays,
  siStale: FADE.siStale,
  priceDrop: FADE.priceDrop,
})

const DAY = 86400000
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)

// The short-interest row: the latest settlement on or before `asOf`, the one
// ~30+ days before it, and the close-to-close move between them.
export function shortsRow(shorts, bars, i, sharesOut = null, p = HOLDING_RISK) {
  const asOf = bars[i]?.t
  if (!asOf || !shorts?.length) return null
  const upTo = shorts.filter((s) => s.date <= asOf)
  const cur = upTo[upTo.length - 1]
  if (!cur || days(cur.date, asOf) > p.siStale) return null
  const prev = [...upTo].reverse().find((s) => days(s.date, cur.date) >= p.siDays)
  if (!prev || !(prev.shares > 0)) return null
  const closeOn = (d) => { let c = null; for (const b of bars) { if (b.t <= d) c = b.c; else break } return c }
  const c0 = closeOn(prev.date), c1 = closeOn(cur.date)
  return {
    from: prev.date, to: cur.date, siChange: cur.shares / prev.shares - 1, shares: cur.shares,
    priceChange: c0 && c1 ? c1 / c0 - 1 : null,
    siPct: sharesOut > 0 ? cur.shares / sharesOut : null,
  }
}

// The catalyst row: the latest event day (a close up ≥ 10% on ≥ 3× volume
// within the last 60 sessions) and whether a later close undercut it.
export function catalystRow(bars, i) {
  const ev = eventDays(bars, i)
  if (!ev.length) return null
  const k = ev[ev.length - 1]
  const b = bars[k]
  const jump = b.c / bars[k - 1].c - 1
  const broke = failedCatalyst(bars, i)
  const held = broke.points > 0 && broke.event === b.t ? broke.brokeOn : null
  return { event: b.t, level: b.c, jump, brokeOn: held, last: bars[i].c }
}

// The runway row: cash on hand against the latest quarter's operating burn.
export function runwayRow(fin, asOf) {
  if (!fin) return null
  const r = runway(fin, asOf)
  if (!r.known || !Number.isFinite(r.quarters)) return null
  const cash = cashAt(fin, asOf), burn = quarterlyOcfAt(fin, asOf)
  const cashRow = (fin.cash ?? []).filter((x) => x.filed <= asOf).sort((a, b) => a.end.localeCompare(b.end)).pop()
  return { quarters: r.quarters, cash, burn, periodEnd: cashRow?.end ?? null }
}

export function riskRow({ bars, shorts = [], fin = null, sharesOut = null, asOf = null }) {
  const i = bars.length - 1
  const t = asOf ?? bars[i].t
  return { as_of: t, catalyst: catalystRow(bars, i), shorts: shortsRow(shorts, bars, i, sharesOut), runway: runwayRow(fin, t) }
}

const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const pct = (x, d = 0) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`
const mag = (x, d = 0) => `${Math.abs(x * 100).toFixed(d)}%`
const price = (x) => `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`
const money = (x) => { const a = Math.abs(x); return a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${Math.round(a / 1e6)}M` : `$${Math.round(a / 1e3)}K` }
const quarters = (q) => (q < 1 ? 'under a quarter' : q < 1.5 ? 'about a quarter' : `about ${Math.round(q)} quarters`)

// row: a ticker_risks row → [{ key, tone, title, body }]. Each key carries the
// event's date so a dismissal stays dismissed until the fact changes.
export function holdingRiskFacts(row, p = HOLDING_RISK) {
  const out = []
  if (!row) return out
  const c = row.catalyst
  if (c?.brokeOn) {
    out.push({ key: `catalyst:${c.event}:${c.brokeOn}`, tone: 'amber', title: `Hasn't held its ${fmtDay(c.event)} jump`,
      body: `Rose ${mag(c.jump)} that day on heavy volume, then closed below that day's ${price(c.level)} on ${fmtDay(c.brokeOn)}.` })
  } else if (c) {
    out.push({ key: `catalyst:${c.event}:held`, tone: 'neutral', title: `Jumped ${pct(c.jump)} on ${fmtDay(c.event)} on heavy volume`,
      body: `Still above that day's close (${price(c.level)}) so far.` })
  }
  const s = row.shorts
  if (s && s.siChange >= p.siRise) {
    const fell = s.priceChange != null && s.priceChange <= -p.priceDrop
    const held = s.priceChange != null && !fell
    out.push({ key: `shorts:${s.to}`, tone: fell ? 'amber' : 'neutral', title: `Short interest ${pct(s.siChange)} since ${fmtDay(s.from)}`,
      body: [fell ? `The price fell ${mag(s.priceChange)} over the same span.` : held ? `The price held over the same span (${pct(s.priceChange)}).` : null,
        s.siPct != null ? `Shorts are ${Math.round(s.siPct * 100)}% of the shares (as of ${fmtDay(s.to)}).` : null].filter(Boolean).join(' ') })
  }
  const r = row.runway
  if (r && r.quarters < p.runwayShow) {
    out.push({ key: `runway:${r.periodEnd ?? row.as_of}`, tone: r.quarters < p.runwayTight ? 'amber' : 'neutral', title: `Cash covers ${quarters(r.quarters)} of spending`,
      body: `${money(r.cash)} on hand at ${r.periodEnd ? fmtDay(r.periodEnd) : 'the last report'} against ${money(r.burn)} spent in the latest quarter. Companies in this spot often raise money by selling more shares.` })
  }
  return out
}
