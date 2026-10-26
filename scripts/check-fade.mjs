// npm run fade:check — src/utils/fade.js
import { FADE, financingEvents, capitalRedirect, raiseAfter, outcomeRates, compactFacts, revenueAt, cashAt, quarterlyOcfAt, shortsPressing, eventDays, failedCatalyst, runway, insiderRole, insiderSelling, trendBreak, fadeScore, forwardFade, fadeStats, fadeVerdict } from '../src/utils/fade.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }

// Bars: 300 flat at 100, a +20% jump on 5× volume at bar 300, five bars holding above it, then a slide from bar 306 on.
const bars = []
const day = (n) => new Date(Date.UTC(2025, 0, 1) + n * 86400e3).toISOString().slice(0, 10)
for (let i = 0; i < 300; i++) bars.push({ t: day(i), o: 100, h: 101, l: 99, c: 100, v: 1e6 })
bars.push({ t: day(300), o: 100, h: 122, l: 100, c: 120, v: 5e6 })
for (let i = 301; i < 306; i++) bars.push({ t: day(i), o: 121, h: 122, l: 120.5, c: 121, v: 1e6 })
for (let i = 306; i < 441; i++) { const c = 121 * 0.99 ** (i - 305); bars.push({ t: day(i), o: c, h: c + 1, l: c - 1, c, v: 1e6 }) }
ok('event day found: +20% on 5× volume', eventDays(bars, 305).includes(300))
ok('no event on a flat stretch', eventDays(bars, 250).length === 0)
ok('failed catalyst fires once a later close undercuts the event close', failedCatalyst(bars, 320).points === 25 && failedCatalyst(bars, 320).event === day(300))
ok('not yet failed the day after the event', failedCatalyst(bars, 301).points === 0)
ok('event older than the look-back is forgotten', failedCatalyst(bars, 369).points === 0 || 369 - 300 < FADE.eventLook)

// Shorts: settlement 35 days before bar 360 at 1.0M, latest 5 days before at 1.3M; price fell ~30% in between.
const i = 359
const shorts = [{ date: bars[i - 35].t, shares: 1e6 }, { date: bars[i - 5].t, shares: 1.3e6 }]
const sp = shortsPressing(shorts, bars, i)
ok('shorts up 30% while price fell: full 25', sp.points === 25 && sp.siChange > 0.29 && sp.priceChange < -0.1)
ok('shorts up, price flat: partial 10', shortsPressing([{ date: bars[200].t, shares: 1e6 }, { date: bars[240].t, shares: 1.2e6 }], bars, 245).points === 10)
ok('stale short data → unknown', shortsPressing([{ date: bars[100].t, shares: 1e6 }, { date: bars[200].t, shares: 2e6 }], bars, 300).known === false)

// Trend: bar 369 is well under the 50-day, and the 50-day is under the 200-day.
ok('trend break: 10+ closes under a 50-day that sits under the 200-day', trendBreak(bars, 369).points === 10)
ok('no trend break on the flat stretch', trendBreak(bars, 299).points === 0)

// SEC facts → compact → runway.
const fy = (y, val, filed, form = '10-K') => ({ start: `${y}-01-01`, end: `${y}-12-31`, val, form, filed })
const facts = { facts: { 'us-gaap': {
  Revenues: { units: { USD: [fy(2024, 12e6, '2025-03-01')] } },
  NetCashProvidedByUsedInOperatingActivities: { units: { USD: [
    { start: '2025-01-01', end: '2025-03-31', val: -5e6, form: '10-Q', filed: '2025-05-10' },
    { start: '2025-01-01', end: '2025-06-30', val: -11e6, form: '10-Q', filed: '2025-08-10' },
  ] } },
  CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: '2025-03-31', val: 30e6, form: '10-Q', filed: '2025-05-10' }, { end: '2025-06-30', val: 24e6, form: '10-Q', filed: '2025-08-10' }] } },
}, dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: '2025-07-31', val: 50e6, form: '10-Q', filed: '2025-08-10' }] } } } } }
const fin = compactFacts(facts)
ok('compact facts keep revenue, ocf, cash, shares', fin.revenue.length === 1 && fin.ocf.length === 2 && fin.cash.length === 2 && fin.sharesOut.length === 1 && fin.hasRevenueTag)
ok('revenue known point in time', revenueAt(fin, '2025-06-01') === 12e6 && revenueAt(fin, '2025-02-01') === null)
ok('Q2 burn = H1 YTD − Q1', quarterlyOcfAt(fin, '2025-09-01') === -6e6 && quarterlyOcfAt(fin, '2025-06-01') === -5e6)
ok('runway 4 quarters → partial 8', runway(fin, '2025-09-01').points === 8 && Math.abs(runway(fin, '2025-09-01').quarters - 4) < 1e-9)
ok('runway under 3 quarters → full 15', runway({ ...fin, cash: [{ end: '2025-06-30', filed: '2025-08-10', val: 12e6 }] }, '2025-09-01').points === 15)
ok('cash-generating company → 0', runway({ ...fin, ocf: [{ start: '2025-01-01', end: '2025-03-31', filed: '2025-05-10', val: 2e6 }] }, '2025-09-01').points === 0)
ok('no cash row → unknown', runway({ ...fin, cash: [] }, '2025-09-01').known === false)
ok('cashAt', cashAt(fin, '2025-09-01') === 24e6)

// Insiders.
ok('roles from the bulk columns', insiderRole('Officer', 'Chief Executive Officer') === 'ceo' && insiderRole('Officer', 'CFO') === 'cfo' && insiderRole('Officer', 'SVP, Engineering') === 'officer' && insiderRole('Director', '') === 'director' && insiderRole('TenPercentOwner', '') === 'other')
const t = (role, code, date, filed = date) => ({ role, code, date, filed })
ok('CEO sale, no buy: full 15', insiderSelling([t('ceo', 'S', '2025-08-01')], '2025-09-01').points === 15)
ok('officer sale: 8', insiderSelling([t('officer', 'S', '2025-08-01')], '2025-09-01').points === 8)
ok('director sale alone: 0 (spec says officer)', insiderSelling([t('director', 'S', '2025-08-01')], '2025-09-01').points === 0)
ok('an offsetting buy cancels it', insiderSelling([t('ceo', 'S', '2025-08-01'), t('director', 'P', '2025-08-15')], '2025-09-01').points === 0)
ok('a sale older than 60 days does not count', insiderSelling([t('ceo', 'S', '2025-05-01')], '2025-09-01').points === 0)
ok('a filing after the day does not count', insiderSelling([t('ceo', 'S', '2025-08-20', '2025-09-05')], '2025-09-01').points === 0)

// The whole score on bar 359: the event (bar 300) is still inside the 60-bar look-back and broke at 306.
const sc = fadeScore({ bars, i, shorts, trades: [t('cfo', 'S', bars[i - 10].t)], fin: { ...fin, cash: [{ end: '2025-06-30', filed: '2025-08-10', val: 12e6 }] } })
ok('score sums the factors (25 + 25 + 15 + 15 + 0 + 10 = 90, actionable)', sc.score === 90 && sc.tier === 'actionable')
ok('clear tier on a quiet stock', fadeScore({ bars, i: 250, shorts: [], trades: [], fin: null }).tier === 'clear')

// Outcomes and the verdict.
const fw = forwardFade(bars, 300)
ok('a 60%+ slide after the event is a faller, not a doubler', fw.fell && !fw.doubled && fw.maxFall < -0.5)
ok('incomplete horizon → null', forwardFade(bars, 400) === null)
const st = fadeStats([...Array(200)].map((_, k) => ({ flagged: k < 20, fell: k < 12 || (k >= 100 && k < 110), doubled: k >= 150 && k < 170, ret: k < 20 ? -0.35 : 0.05 })))
ok('stats: fell rate 60% vs base 11%, no doublers among flagged', Math.abs(st.fellRate - 0.6) < 1e-9 && Math.abs(st.baseFell - 0.11) < 1e-9 && st.doubledRate === 0)
ok('that flag fails the minimum count (20 < 100) → inconclusive', fadeVerdict(st) === 'inconclusive')
ok('a strong flag at count passes', fadeVerdict({ ...st, flagged: 150 }) === 'pass')
ok('lift without a worse median fails', fadeVerdict({ ...st, flagged: 150, medianRet: 0.04 }) === 'fail')
ok('weights are the spec’s', Object.values(FADE.weights).reduce((a, b) => a + b, 0) === 100 && FADE.tiers.actionable === 70)
// Financing from SEC submissions.
const fl = [{ form: 'S-3', date: '2025-01-15', items: [] }, { form: '8-K', date: '2025-03-01', items: ['2.02', '9.01'] }, { form: '424B5', date: '2025-06-10', items: [] }, { form: '8-K', date: '2025-09-20', items: ['1.01', '3.02', '9.01'] }]
ok('shelf within a year → factor 5', capitalRedirect(fl, '2025-04-01').points === 10 && capitalRedirect(fl, '2025-04-01').shelf)
ok('shelf older than a year, no supplement → 0', capitalRedirect(fl, '2026-03-01').points === 0)
ok('supplement within 180 days → factor 5 (atm)', capitalRedirect(fl, '2025-08-01').atm && capitalRedirect(fl, '2025-08-01').points === 10)
ok('an earnings 8-K (2.02) is not a raise', financingEvents(fl, '2025-04-01').raises.length === 0)
ok('424B5 and 8-K 3.02 are raises', financingEvents(fl, '2025-12-31').raises.join() === '2025-06-10,2025-09-20')
ok('first raise after a day, within the window', raiseAfter(fl, '2025-04-01', 183) === '2025-06-10' && raiseAfter(fl, '2025-07-01', 183) === '2025-09-20' && raiseAfter(fl, '2025-10-01', 183) === null)
ok('filings after the day are not known', capitalRedirect(fl, '2025-01-01').points === 0)
const orr = outcomeRates([{ flagged: true, raised: true }, { flagged: true, raised: false }, { flagged: false, raised: false }, { flagged: false, raised: true }], 'raised')
ok('outcome rates: 50% vs base 50%, recall 50%', orr.rate === 0.5 && orr.base === 0.5 && orr.recall === 0.5)
ok('score with a shelf on file includes factor 5', fadeScore({ bars, i: 250, shorts: [], trades: [], fin: null, filings: [{ form: 'S-3', date: bars[240].t, items: [] }] }).factors.redirect.points === 10)
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
