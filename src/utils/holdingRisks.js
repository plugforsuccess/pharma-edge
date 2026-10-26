// Risk facts on a holding (owner spec v2, 2026-10-26, after the Fade Screen
// test: two facts "each shown as a sentence with its numbers, no color
// coding, no score" — the two inputs that carried the test; insider selling,
// shelf filings and a runway countdown are deliberately not shown. Cash and
// burn appear as plain numbers in the ledger header, not as a signal).
//
// `riskRow` builds the stored row (scripts/holding-risks.mjs, nightly, every
// ticker a user holds or has starred → ticker_risks); `holdingRiskFacts`
// turns a row into the sentences; `cashLine` the header numbers;
// `bothLitLine` the test's own reading, shown only when both facts are lit.
import { FADE, eventDays, cashAt, quarterlyOcfAt, quarterlyJvAt } from './fade.js'

export const HOLDING_RISK = Object.freeze({
  belowSessions: 20,     // failed catalyst: below the event close for 20+ sessions
  siRise: FADE.siRise,   // shorts pressing: SI up ≥ 15% vs the settlement ≥ 30 days earlier …
  siDays: FADE.siDays,
  siStale: FADE.siStale,
  priceDrop: FADE.priceDrop, // … while the close is down ≥ 10% over the same span
})
// The test's reading of months with both facts lit (variants.md, 2026-10-26,
// row "1 + 2": 305 months, 6M median −18.4%, doubled 32.5%, fell 55.4%).
export const BOTH_LIT = Object.freeze({ median: -0.18, doubled: 0.325, fell: 0.554, months: 305 })

const DAY = 86400000
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)

// Short interest: the latest settlement on or before the bar, the one ≥ 30
// days before it, and the close-to-close move between them.
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
  return { from: prev.date, to: cur.date, spanDays: days(prev.date, cur.date), siChange: cur.shares / prev.shares - 1, shares: cur.shares, priceChange: c0 && c1 ? c1 / c0 - 1 : null, siPct: sharesOut > 0 ? cur.shares / sharesOut : null }
}

// The latest event day (a close up ≥ 10% on ≥ 3× volume within the last 60
// sessions), its close, and how many sessions in a row the stock has now
// closed below it (0 = holding above).
export function catalystRow(bars, i) {
  const ev = eventDays(bars, i)
  if (!ev.length) return null
  const k = ev[ev.length - 1]
  const b = bars[k]
  let below = 0
  for (let m = i; m > k; m--) { if (bars[m].c < b.c) below++; else break }
  return { event: b.t, level: b.c, jump: b.c / bars[k - 1].c - 1, sessionsBelow: below, last: bars[i].c }
}

// Cash on hand against the latest quarter's spend (plain numbers). Spend =
// operating cash flow + capital put into equity-method investees — a company
// that runs its operations through a JV shows almost no operating burn
// (AIRJ: ~$1.4M a quarter at the parent, the spend is in AirJoule, LLC —
// owner, 2026-10-26), so OCF alone understated it ~5×.
export function runwayRow(fin, asOf) {
  if (!fin) return null
  const cash = cashAt(fin, asOf), burn = quarterlyOcfAt(fin, asOf)
  if (cash == null || burn == null) return null
  // Differenced YTD rows can go negative on a restatement; contributions are never negative.
  const jv = Math.max(0, quarterlyJvAt(fin, asOf) ?? 0)
  const spend = Math.max(0, -burn) + jv
  const cashRow = (fin.cash ?? []).filter((x) => x.filed <= asOf).sort((a, b) => a.end.localeCompare(b.end)).pop()
  return { quarters: spend > 0 ? cash / spend : null, cash, burn, jv: jv || null, periodEnd: cashRow?.end ?? null }
}

export function riskRow({ bars, shorts = [], fin = null, sharesOut = null, asOf = null }) {
  const i = bars.length - 1
  const t = asOf ?? bars[i].t
  return { as_of: t, catalyst: catalystRow(bars, i), shorts: shortsRow(shorts, bars, i, sharesOut), runway: runwayRow(fin, t) }
}

const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const signed = (x, d = 0) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`
const price = (x) => `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`
const money = (x) => { const a = Math.abs(x); return a >= 1e9 ? `$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${Math.round(a / 1e6)}M` : `$${Math.round(a / 1e3)}K` }

// row: a ticker_risks row → [{ key, text }] — the two facts, each one sentence.
export function holdingRiskFacts(row, p = HOLDING_RISK) {
  const out = []
  if (!row) return out
  const c = row.catalyst
  if (c && c.sessionsBelow >= p.belowSessions) {
    out.push({ key: `catalyst:${c.event}`, text: `Has not held its ${fmtDay(c.event)} close (${price(c.level)}) for ${c.sessionsBelow} sessions; now ${price(c.last)}.` })
  }
  const s = row.shorts
  if (s && s.siChange >= p.siRise && s.priceChange != null && s.priceChange <= -p.priceDrop) {
    out.push({ key: `shorts:${s.to}`, text: `Short interest ${signed(s.siChange)} in ${s.spanDays} days${s.siPct != null ? ` to ${(s.siPct * 100).toFixed(1)}% of shares out` : ''}; price ${signed(s.priceChange)} over the same window.` })
  }
  return out
}

// The same two facts as compact rows: { key, label, value, detail }.
export function riskRows(row, p = HOLDING_RISK) {
  const out = []
  if (!row) return out
  const c = row.catalyst
  if (c && c.sessionsBelow >= p.belowSessions) out.push({ key: `catalyst:${c.event}`, label: `Below its ${fmtDay(c.event)} close`, value: `${c.sessionsBelow} sessions`, detail: `That close ${price(c.level)} · now ${price(c.last)}` })
  const s = row.shorts
  if (s && s.siChange >= p.siRise && s.priceChange != null && s.priceChange <= -p.priceDrop) out.push({ key: `shorts:${s.to}`, label: `Shorts ${signed(s.siChange)} · ${s.spanDays} days`, value: `price ${signed(s.priceChange)}`, detail: `${s.siPct != null ? `${(s.siPct * 100).toFixed(1)}% of shares out · ` : ''}same window` })
  return out
}

// Shown only when both facts are lit — the test's own reading, both halves.
export function bothLitLine(facts, b = BOTH_LIT) {
  if (!facts || facts.length < 2) return null
  return `Both lit: in the test, ${Math.round(Math.abs(b.median) * 100)}% lower six months later at the median, and doubled one time in ${Math.round(1 / b.doubled)}.`
}

// The ledger header's plain numbers: cash and last-quarter burn, no framing.
export function cashLine(row) {
  const r = row?.runway
  if (!r || r.cash == null || r.burn == null) return null
  const when = r.periodEnd ? ` at ${fmtDay(r.periodEnd)}` : ''
  const ops = r.burn < 0 ? `${money(r.burn)} ops` : `${money(r.burn)} generated`
  return r.jv > 0 ? `Cash ${money(r.cash)}${when} · ${ops} + ${money(r.jv)} to JV last qtr` : `Cash ${money(r.cash)}${when} · ${r.burn < 0 ? `${money(r.burn)} used` : ops} last qtr`
}
