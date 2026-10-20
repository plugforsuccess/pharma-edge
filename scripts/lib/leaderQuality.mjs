// Cash-flow quality on the nightly Leaders (owner, 2026-10-20: "Filter: only
// passers listed"). For every ticker that is a leader today or was one in the
// past year: the verdict on the latest annual report (src/utils/quality.js),
// each past step (one per 10-K) for the leader record, and the stints rebuilt
// so a stock only counts as a leader on days its report on file passed.
// Funds (USO, sector ETFs) are exempt. SEC unreachable for a ticker → the
// last stored verdict (company_quality) is reused, so a bad night never
// empties the list.
import { isFund, qualityAt, qualityOn, qualityParams, qualitySteps, OIL_GROUPS } from '../../src/utils/quality.js'
import { leaderStints } from '../../src/utils/leaderRecord.js'
import { CHART_TICKERS } from '../../src/lib/chartTickers.js'

const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000)
const labelOf = new Map(CHART_TICKERS.map((t) => [t.symbol, t.label ?? '']))

// Tickers the check needs: leaders today or with a leader day in the past year.
export function qualityTickers(results) {
  return results.filter((r) => r.leader?.misses?.length === 0 || (r.leaderDays ?? []).slice(-260).some(Boolean)).map((r) => r.ticker)
}

// → Map ticker → company_quality row (steps included).
export function qualityRows(results, facts, stored, asOf) {
  const out = new Map()
  for (const r of results) {
    if (!facts.has(r.ticker)) continue
    if (isFund(r.ticker, labelOf.get(r.ticker))) {
      out.set(r.ticker, { ticker: r.ticker, checked_on: asOf, rule: 'fund', known: true, pass: true, misses: [], fcf_margin: null, net_debt_years: null, share_growth: null, period_end: null, why: null, steps: null })
      continue
    }
    const f = facts.get(r.ticker)
    if (!f) { if (stored.has(r.ticker)) out.set(r.ticker, { ...stored.get(r.ticker), stale: true }); else out.set(r.ticker, { ticker: r.ticker, checked_on: asOf, rule: OIL_GROUPS.has(r.theme?.name) ? 'oil' : 'standard', known: false, pass: false, misses: ['no data'], why: 'no SEC company facts', steps: [] }); continue }
    const p = qualityParams(r.theme?.name)
    const q = qualityAt(f, asOf, p)
    const steps = qualitySteps(f, p).map((s) => ({ from: s.from, pass: s.pass, misses: s.misses }))
    out.set(r.ticker, {
      ticker: r.ticker, checked_on: asOf, rule: OIL_GROUPS.has(r.theme?.name) ? 'oil' : 'standard',
      known: q.known, pass: q.pass, misses: q.misses ?? [], fcf_margin: r4(q.fcfMargin), net_debt_years: r4(q.netDebtYears),
      share_growth: r4(q.shareGrowth), period_end: q.end ?? null, why: q.why ?? null, steps,
    })
  }
  return out
}

// Annotate results in place: r.quality (no steps) and stints rebuilt on
// leader days whose report on file passed. Tickers never checked keep
// quality null → not ranked.
export function applyQuality(results, rows, spy) {
  const spyMap = spy ? new Map(spy.map((b) => [b.t, b.c])) : null
  for (const r of results) {
    const q = rows.get(r.ticker)
    if (!q) { r.quality = null; continue }
    const { steps, ...rest } = q
    r.quality = rest
    if (!r.leaderDays) continue
    const passOn = (t) => q.rule === 'fund' || (qualityOn(steps, t)?.pass ?? false)
    r.stints = leaderStints(r.bars, r.leaderDays.map((d, i) => d && passOn(r.bars[i].t)), { spy: spyMap })
  }
}

// The forward record of the strongest-10 quality basket (owner, 2026-10-20:
// "Yes, start it"), held as tested: the 10 strongest ranked leaders, at most
// CAP_PER_GROUP per industry group, chosen on the first close of each month
// and held, equal weight, until the next month's first close.
export const BASKET = Object.freeze({ name: 'quality_top10', size: 10, capPerGroup: 4 })

// ranked: [{ ticker, rank, group }] in rank order (strongest first);
// prev: the latest earlier basket_record row or null; closeOf(ticker) → close.
// → the row to log, or null (already logged today / nothing to hold).
export function basketToday({ asOf, prev, ranked, closeOf, spyClose = null, p = BASKET }) {
  if (prev && prev.as_of >= asOf) return null
  const rebalance = !prev || prev.as_of.slice(0, 7) !== asOf.slice(0, 7)
  let tickers
  if (rebalance) {
    const byGroup = new Map()
    tickers = []
    for (const r of ranked) {
      const g = r.group ?? `solo:${r.ticker}`, n = byGroup.get(g) ?? 0
      if (n >= p.capPerGroup) continue
      byGroup.set(g, n + 1)
      tickers.push(r.ticker)
      if (tickers.length >= p.size) break
    }
  } else tickers = [...prev.tickers]
  const closes = tickers.map((t) => closeOf(t))
  if (!tickers.length || closes.some((c) => !(c > 0))) return null
  return { basket: p.name, as_of: asOf, tickers, closes, spy_close: spyClose, rebalanced: rebalance }
}
