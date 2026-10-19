// Leaders + cash-flow quality (owner, 2026-10-19: "leaders should be strong
// cash flowing companies" → "We need ETFs and oil too"). Research only, no DB
// writes. A leader passes quality when its latest annual report filed by that
// day shows positive free cash flow, FCF ≥ 5% of revenue, net debt ≤ 3 years
// of FCF and diluted shares up ≤ 5% (src/utils/quality.js, SEC XBRL
// companyfacts, point in time). Funds (ETFs, commodity pools like USO) are
// exempt — judged on price alone. No company data (foreign filers, many banks
// and insurers) = fails, decided before the run.
// Below: the portfolio-test header, kept for the shared mechanics.
// Portfolio versions of the Leaders basket (owner, 2026-10-19: "tweak the
// leaders to actually beat the S&P" → "Sure"). Research only, no DB writes.
// Same data and basket mechanics as scripts/leader-fix-test.mjs; the rule is
// unchanged — only how the basket is held. Versions:
//   base      every leader (max 4 per group), equal weight, monthly
//   top10/20  the strongest 10 / 20 by 12-1 return (after the group cap)
//   core70    70% SPY + 30% base, rebalanced monthly
//   core50    50% SPY + 50% base
//   switch    base while base beat SPY over the last 6 months, else SPY
// Pass mark, fixed before the run: beats SPY over 2024 →, beats it in at least
// 3 of the 4 full-ish years 2023–2026, and a worst drop no more than 1.5× SPY's
// (all months). The smooth / group code below is unused here.
//
// Every variant is held as a basket — every stock that qualifies at a
// month's first close, equal weight, at most CAP_PER_GROUP per industry group
// (strongest 12-1 first), rebalanced monthly, close to close — beside SPY and
// an equal-weight "any stock" basket. The variants, all on top of today's
// rule (LEADER, S&P check off):
//   base       today's rule
//   uncapped   today's rule without the per-group cap
//   smooth     plus a steady climb: share of up days over the 12-1 window at
//              or above the train-period median of base leaders
//   unstretched plus close < 35% above the 200-day
//   strongGroup plus the stock's industry fund beating SPY over 12-1
//   calm       base, but cash (0%) for the month when SPY's 20-day volatility
//              sits in the top 20% of its past year
//   combo      smooth + unstretched + strongGroup
// Thresholds are fixed before results: the smooth cut is set on train
// (entries before 2024) only; the rest are round numbers chosen up front.
// Judge on test (2024 →). Caveats printed with the report: today's ticker list
// (survivorship), groups assigned from the last 120 days (a little hindsight
// for the group variants), no costs or dividends.

import { writeFileSync } from 'node:fs'
import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { trailingVol, OPTION_MODEL } from '../src/utils/replay.js'
import { leaderSeries, leaderMisses, LEADER } from '../src/utils/leaders.js'
import { THEMES, returnsByDate, themeOf } from '../src/utils/themes.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { qualityAt, isFund } from '../src/utils/quality.js'

const SPLIT = '2024-01-01'
const CAP_PER_GROUP = 4
const STRETCH_MAX = 0.35
const CALM_PCT = 0.8
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

const spyBars = await dailyBars('SPY')
const dates = spyBars.map((b) => b.t)
const dIdx = new Map(dates.map((t, i) => [t, i]))
const spyC = spyBars.map((b) => b.c)
// Month starts: the first trading day of each month.
const monthStarts = dates.map((t, i) => (i > 0 && t.slice(0, 7) !== dates[i - 1].slice(0, 7) ? i : -1)).filter((i) => i >= 0)

// 12-1 return on any close series aligned to SPY dates.
const mom12At = (c, i) => (i >= 252 && c[i - 21] && c[i - 252] ? c[i - 21] / c[i - 252] - 1 : null)

// Industry funds on SPY dates.
const fundClose = new Map(), fundRet = new Map()
for (const [etf] of THEMES) {
  try {
    const b = await dailyBars(etf)
    fundRet.set(etf, returnsByDate(b))
    const m = new Map(b.map((x) => [x.t, x.c]))
    fundClose.set(etf, dates.map((t) => m.get(t) ?? null))
  } catch { /* fund missing → its stocks get no group check */ }
}

// SPY 20-day volatility rank within its past year → the calm switch.
const r1 = spyC.map((c, i) => (i ? Math.log(c / spyC[i - 1]) : 0))
const vol20 = spyC.map((_, i) => { if (i < 21) return null; let s = 0, q = 0; for (let k = i - 19; k <= i; k++) { s += r1[k]; q += r1[k] * r1[k] } const m = s / 20; return Math.sqrt(Math.max(0, q / 20 - m * m)) })
const volRank = vol20.map((v, i) => { if (v == null || i < 252) return null; let k = 0, n = 0; for (let j = i - 251; j <= i; j++) if (vol20[j] != null) { n++; if (vol20[j] <= v) k++ } return n ? k / n : null })

const stocks = []
let done = 0, failed = 0
await mapLimit(universe, Number(process.env.CONCURRENCY) || 6, async (tk) => {
  try {
    const bars = await dailyBars(tk)
    if (!bars || bars.length < 300) return
    const c = bars.map((b) => b.c)
    const vol = trailingVol(c, OPTION_MODEL.volBars)
    const ls = leaderSeries(bars, spyBars, { vol })
    const own = new Map(bars.map((b, i) => [b.t, i]))
    const theme = themeOf(tk, bars, fundRet)
    // Per SPY date: close, leader?, traits, steadiness.
    const close = dates.map((t) => { const i = own.get(t); return i == null ? null : c[i] })
    const info = monthStarts.map((si) => {
      const i = own.get(dates[si])
      if (i == null) return null
      const tr = ls.at(i)
      if (!tr || leaderMisses(tr).length) return { leader: false }
      let up = 0, n = 0
      for (let k = i - 251; k <= i - 21; k++) if (k > 0) { n++; if (c[k] > c[k - 1]) up++ }
      return { leader: true, mom12: tr.mom12, vs200: tr.vs200, pctUp: n ? up / n : null }
    })
    const label = CHART_TICKERS.find((t) => t.symbol === tk)?.label ?? ''
    stocks.push({ tk, close, info, etf: theme?.etf ?? null, group: theme?.name ?? null, fund: isFund(tk, label), lastLeader: (() => { const tr = ls.at(bars.length - 1); return tr && !leaderMisses(tr).length })() })
  } catch { failed++ }
  if (++done % 100 === 0) console.log(`  ${done}/${universe.length} · ${failed} failed`)
})
console.log(`\n${stocks.length} tickers · ${failed} failed · funds ${fundClose.size}/${THEMES.length} · bars from Yahoo ${sources.yahoo} / edge ${sources.edge}`)

// The smooth cut: median pctUp among base leaders at train month starts.
const trainUps = []
monthStarts.forEach((si, m) => { if (dates[si] >= SPLIT) return; for (const s of stocks) { const x = s.info[m]; if (x?.leader && x.pctUp != null) trainUps.push(x.pctUp) } })
trainUps.sort((a, b) => a - b)
const SMOOTH_MIN = trainUps.length ? trainUps[Math.floor(trainUps.length / 2)] : 0.5
console.log(`Smooth cut (train median share of up days): ${(SMOOTH_MIN * 100).toFixed(1)}% · from ${trainUps.length} train leader-months`)



// SEC companyfacts for every company that was ever a leader (funds skipped).
const SEC_UA = process.env.SEC_USER_AGENT || 'Cash Moves research admin@cashmoves.io'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function secJson(url) {
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' } }); if (r.ok) return await r.json(); if (r.status === 404) return null } catch { /* retry */ }
    await sleep(1000 * (a + 1))
  }
  return null
}
const cikByTicker = new Map()
const tickersJson = await secJson('https://www.sec.gov/files/company_tickers.json')
for (const v of Object.values(tickersJson ?? {})) cikByTicker.set(String(v.ticker).toUpperCase().replace(/-/g, '.'), String(v.cik_str).padStart(10, '0'))
const need = stocks.filter((s) => !s.fund && (s.info.some((x) => x?.leader) || s.lastLeader))
let secOk = 0, secMissing = 0
await mapLimit(need, 4, async (s) => {
  const cik = cikByTicker.get(s.tk)
  s.facts = cik ? await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`) : null
  if (s.facts) secOk++; else secMissing++
}, 150)
console.log(`SEC: ${cikByTicker.size} tickers mapped · company facts for ${secOk} of ${need.length} leader companies (${secMissing} without)`)
// Quality per leader-month (point in time) and today.
let lm = 0, lmFund = 0, lmPass = 0, lmUnknown = 0
for (const s of stocks) {
  s.info.forEach((x, m) => {
    if (!x?.leader) return
    lm++
    if (s.fund) { x.quality = true; lmFund++; return }
    const q = s.facts ? qualityAt(s.facts, dates[monthStarts[m]]) : { known: false, pass: false }
    x.quality = q.pass
    if (q.pass) lmPass++
    if (!q.known) lmUnknown++
  })
}
console.log(`Leader-months: ${lm} · funds ${lmFund} · companies passing quality ${lmPass} · no company data ${lmUnknown}`)
const today = dates[dates.length - 1]
const nowRows = stocks.filter((s) => s.lastLeader).map((s) => {
  if (s.fund) return { tk: s.tk, verdict: 'fund (exempt)' }
  const q = s.facts ? qualityAt(s.facts, today) : { known: false, pass: false, misses: ['no data'] }
  return { tk: s.tk, verdict: q.pass ? 'PASS' : `fail: ${(q.misses ?? []).join(', ')}`, margin: q.fcfMargin, ndy: q.netDebtYears }
}).sort((a, b) => a.verdict.localeCompare(b.verdict) || a.tk.localeCompare(b.tk))
console.log(`\nToday's leaders (${today}) under the quality check:`)
for (const r of nowRows) console.log(`  ${r.tk.padEnd(6)} ${r.verdict}${r.margin != null ? ` · FCF margin ${(r.margin * 100).toFixed(1)}%` : ''}${r.ndy != null ? ` · net debt ${r.ndy.toFixed(1)} yrs of FCF` : ''}`)
// Monthly basket returns: base (capped, strongest first) and its top N.
const months = []
for (let m = 0; m < monthStarts.length - 1; m++) {
  const si = monthStarts[m], ei = monthStarts[m + 1]
  if (si < 260) continue
  const ret = (s) => (s.close[si] && s.close[ei] ? s.close[ei] / s.close[si] - 1 : null)
  const capped = (list) => { const byGroup = new Map(); return list.sort((a, b) => b.info[m].mom12 - a.info[m].mom12)
    .filter((s) => { const g = s.group ?? `solo:${s.tk}`, n = byGroup.get(g) ?? 0; if (n >= CAP_PER_GROUP) return false; byGroup.set(g, n + 1); return true }) }
  const picks = capped(stocks.filter((s) => s.info[m]?.leader && ret(s) != null))
  const qpicks = capped(stocks.filter((s) => s.info[m]?.leader && s.info[m].quality && ret(s) != null))
  const avg = (xs) => (xs.length ? xs.reduce((a, s) => a + ret(s), 0) / xs.length : 0)
  const all = stocks.map(ret).filter((v) => v != null)
  const row = { t: dates[si], spy: spyC[ei] / spyC[si] - 1, any: all.length ? all.reduce((a, v) => a + v, 0) / all.length : 0 }
  row.base = avg(picks); row.base_n = picks.length
  row.top10 = avg(picks.slice(0, 10)); row.top10_n = Math.min(10, picks.length)
  row.top20 = avg(picks.slice(0, 20)); row.top20_n = Math.min(20, picks.length)
  row.quality = avg(qpicks); row.quality_n = qpicks.length
  row.qtop10 = avg(qpicks.slice(0, 10)); row.qtop10_n = Math.min(10, qpicks.length)
  row.qtop20 = avg(qpicks.slice(0, 20)); row.qtop20_n = Math.min(20, qpicks.length)
  months.push(row)
}

function perf(rows, k) {
  if (!rows.length) return null
  let eq = 1, peak = 1, dd = 0
  for (const r of rows) { eq *= 1 + r[k]; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1) }
  const names = rows.map((r) => r[`${k}_n`]).filter((v) => v != null)
  return { total: eq - 1, cagr: Math.pow(eq, 12 / rows.length) - 1, maxDD: dd, beatMonths: rows.filter((r) => r[k] > r.spy).length / rows.length, avgNames: names.length ? names.reduce((a, v) => a + v, 0) / names.length : null }
}
const P = (x) => (x == null ? '   —' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`)
const LABEL = { base: 'Every leader (max 4/group)', quality: 'Every quality leader', top10: 'Strongest 10', qtop10: 'Strongest 10 quality leaders', top20: 'Strongest 20', qtop20: 'Strongest 20 quality leaders', any: 'Any stock (equal weight)', spy: 'S&P 500 (SPY)' }
const keys = Object.keys(LABEL)
const test = months.filter((r) => r.t >= SPLIT)
const YEARS = ['2023', '2024', '2025', '2026']
const spyAll = perf(months, 'spy'), spyTest = perf(test, 'spy')
const report = { at: new Date().toISOString(), months: months.length, versions: {} }
console.log(`\n${months.length} months (${months[0]?.t} → ${months[months.length - 1]?.t}); test = ${test.length} months from 2024`)
console.log(`  ${'version'.padEnd(34)} ${'2024→ /yr'.padStart(10)} ${'all /yr'.padStart(9)} ${'worst drop'.padStart(10)} ${YEARS.map((y) => y.padStart(8)).join('')}  ${'years won'.padStart(9)}  pass`)
for (const k of keys) {
  const t = perf(test, k), a = perf(months, k)
  const byYear = YEARS.map((y) => { const rows = months.filter((r) => r.t.startsWith(y)); return { y, v: perf(rows, k)?.total, spy: perf(rows, 'spy')?.total } })
  const won = byYear.filter((x) => x.v != null && x.v > x.spy).length
  const pass = k !== 'spy' && k !== 'any' && t.cagr > spyTest.cagr && won >= 3 && a.maxDD >= 1.5 * spyAll.maxDD
  report.versions[k] = { test: t, all: a, byYear, won, pass }
  console.log(`  ${LABEL[k].padEnd(34)} ${P(t.cagr).padStart(10)} ${P(a.cagr).padStart(9)} ${P(a.maxDD).padStart(10)} ${byYear.map((x) => P(x.v).padStart(8)).join('')}  ${(k === 'spy' ? '' : `${won} of 4`).padStart(9)}  ${k === 'spy' || k === 'any' ? '' : pass ? 'PASS' : 'fail'}`)
}
console.log(`\nPass mark: beats SPY's ${P(spyTest.cagr)}/yr over 2024 →, wins ≥ 3 of ${YEARS.join(' / ')}, worst drop no deeper than ${P(1.5 * spyAll.maxDD)} (1.5× SPY's ${P(spyAll.maxDD)}). 2026 = 9 months.`)
console.log("Quality = latest annual 10-K filed by each month start (SEC XBRL); funds exempt; companies without SEC data excluded from the quality lines.")
console.log("Caveats: today's ticker list (survivorship flatters every line); groups from the last 120 days (hindsight in the cap); monthly close to close, no costs, no dividends; ~4 years of history.")
writeFileSync('leader-quality-test.json', JSON.stringify(report, null, 1))
console.log('Wrote leader-quality-test.json')
