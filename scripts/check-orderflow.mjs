// npm run orderflow:check — NIGHTFLOW engine (src/utils/orderflow/)
import { classifyTrade, quoteQuality, DEFAULT_CONFIG, sessionOf, sessionKey, OrderFlowEngine, runStream, aggregate, generateScenario, SCENARIOS, dilutionRisk, labelSelloffs, collectSignals, grade, walkForward, SCORE_WEIGHTS } from '../src/utils/orderflow/index.js'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const cfg = DEFAULT_CONFIG
const T = Date.UTC(2026, 9, 7, 15, 0, 0)   // Wed 11:00 ET

// --- classification -------------------------------------------------
const q = { t: T - 100, bid: 4.0, ask: 4.02 }
const tick0 = { last: null, dir: 0 }
ok('at ask = buy (quote rule)', classifyTrade({ t: T, price: 4.02, size: 100 }, q, tick0, cfg).side === 1)
ok('above ask = buy', classifyTrade({ t: T, price: 4.03, size: 100 }, q, tick0, cfg).side === 1)
ok('at bid = sell', classifyTrade({ t: T, price: 4.0, size: 100 }, q, tick0, cfg).side === -1)
const mid1 = classifyTrade({ t: T, price: 4.02, size: 100 }, { ...q, ask: 4.03 }, tick0, cfg)
ok('inside spread above mid = buy (midpoint)', mid1.side === 1 && mid1.method === 'midpoint')
const atMid = classifyTrade({ t: T, price: 4.01, size: 100 }, q, { last: 4.0, dir: -1 }, cfg)
ok('at mid → tick rule: uptick = buy', atMid.side === 1 && atMid.method === 'tick')
ok('zero tick inherits last direction', classifyTrade({ t: T, price: 4.01, size: 100 }, q, { last: 4.01, dir: -1 }, cfg).side === -1)
ok('no quote → tick rule, low confidence', classifyTrade({ t: T, price: 4.05, size: 100 }, null, { last: 4.0, dir: 0 }, cfg).confidence === 'low')
ok('stale quote → tick rule', classifyTrade({ t: T, price: 4.0, size: 100 }, { ...q, t: T - 60_000 }, { last: 4.1, dir: 0 }, cfg).method === 'tick')
ok('crossed quote → poor, tick rule', quoteQuality({ t: T, bid: 4.03, ask: 4.0 }, T, cfg).grade === 'poor' && classifyTrade({ t: T, price: 4.0, size: 1 }, { t: T, bid: 4.03, ask: 4.0 }, { last: 3.9, dir: 0 }, cfg).method === 'tick')
ok('out-of-sequence condition Z is excluded', !!classifyTrade({ t: T, price: 4.02, size: 100, conds: 'Z' }, q, tick0, cfg).excluded)
ok('average-price W is excluded', !!classifyTrade({ t: T, price: 4.02, size: 100, conds: '@W' }, q, tick0, cfg).excluded)
ok('off-market print is excluded', classifyTrade({ t: T, price: 4.6, size: 100 }, q, tick0, cfg).excluded === 'off-market print')
ok('feed-invalid tick is excluded', !!classifyTrade({ t: T, price: 4.02, size: 100, valid: false }, q, tick0, cfg).excluded)
ok('print-stamped bid/ask beats a stale quote', classifyTrade({ t: T, price: 4.02, size: 100, bid: 4.0, ask: 4.02 }, { ...q, t: T - 60_000 }, tick0, cfg).method === 'quote')
ok('candle colour is irrelevant: a buy at the ask in a falling tape is a buy', classifyTrade({ t: T, price: 3.5, size: 100 }, { t: T, bid: 3.48, ask: 3.5 }, { last: 4.0, dir: -1 }, cfg).side === 1)

// --- sessions ---------------------------------------------------------
const et = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h + 4, mi)   // EDT = UTC−4 (Oct)
ok('Wed 09:29 premarket', sessionOf(et(2026, 10, 7, 9, 29)) === 'premarket')
ok('Wed 09:30 regular', sessionOf(et(2026, 10, 7, 9, 30)) === 'regular')
ok('Wed 16:00 after hours', sessionOf(et(2026, 10, 7, 16, 0)) === 'afterhours')
ok('Wed 20:00 overnight', sessionOf(et(2026, 10, 7, 20, 0)) === 'overnight')
ok('Thu 01:00 overnight, keyed to Wed evening', sessionOf(et(2026, 10, 8, 1, 0)) === 'overnight' && sessionKey(et(2026, 10, 8, 1, 0)) === '2026-10-07:overnight')
ok('Fri 21:00 closed', sessionOf(et(2026, 10, 9, 21, 0)) === 'closed')
ok('Sat closed', sessionOf(et(2026, 10, 10, 12, 0)) === 'closed')
ok('Sun 20:30 overnight', sessionOf(et(2026, 10, 11, 20, 30)) === 'overnight')
ok('Mon 02:00 overnight (Sunday night session)', sessionOf(et(2026, 10, 12, 2, 0)) === 'overnight')

// --- engine: cancels, corrections, late prints, CVD -------------------
{
  const e = new OrderFlowEngine({ symbol: 'X', source: 'synthetic' })
  e.onQuote({ t: T, bid: 4.0, ask: 4.02, bidSize: 1000, askSize: 1000 })
  e.onTrade({ t: T + 10, price: 4.02, size: 500, id: 'a' })
  e.onTrade({ t: T + 20, price: 4.0, size: 200, id: 'b' })
  ok('CVD = buys − sells', aggregate(e.trades).delta === 300)
  e.onTrade({ t: T + 30, type: 'CANCEL', id: 'a', price: 4.02, size: 500 })
  ok('cancel removes the print from CVD', aggregate(e.trades).delta === -200 && e.stats.cancels === 1)
  e.onTrade({ t: T + 40, type: 'CORRECTION', id: 'b', price: 4.02, size: 300 })
  ok('correction replaces the print', aggregate(e.trades).delta === 300 && aggregate(e.trades).vol === 300)
  e.onTrade({ t: T + 10_000, price: 4.02, size: 100, id: 'c' })
  e.onTrade({ t: T + 1_000, price: 3.9, size: 100, id: 'late' })
  const late = e.trades.find((r) => r.id === 'late')
  ok('late print is flagged, ordered by time, and leaves the tick state alone', late.late && e.trades.indexOf(late) < e.trades.findIndex((r) => r.id === 'c') && e.tick.last === 4.02)
}
{
  // CVD resets when the session changes (premarket → regular).
  const e = new OrderFlowEngine({ symbol: 'X', source: 'synthetic' })
  const pre = et(2026, 10, 7, 9, 29), reg = et(2026, 10, 7, 9, 31)
  e.onQuote({ t: pre, bid: 4, ask: 4.02, bidSize: 100, askSize: 100 })
  for (let i = 0; i < 5; i++) e.onTrade({ t: pre + i * 1000, price: 4.02, size: 100 })
  e.onQuote({ t: reg, bid: 4, ask: 4.02, bidSize: 100, askSize: 100 })
  for (let i = 0; i < 2; i++) e.onTrade({ t: reg + i * 1000, price: 4.0, size: 100 })
  const b = e.buckets(reg + 5000)
  ok('premarket CVD +500', b.filter((x) => x.session === 'premarket').at(-1).cvd === 500)
  ok('regular-session CVD starts from zero', b.filter((x) => x.session === 'regular').at(-1).cvd === -200)
}
{
  // Coverage: the live source has no overnight data → analytics disabled.
  const e = new OrderFlowEngine({ symbol: 'X', source: 'dxfeed_tastytrade' })
  const s = e.snapshot(et(2026, 10, 7, 22, 0))
  ok('overnight on dxFeed → disabled, not estimated', s.status === 'disabled' && /overnight/.test(s.reason))
}

// --- divergence A–E -----------------------------------------------------
{
  const e = new OrderFlowEngine({ symbol: 'X' })
  const gate = { ok: true, reasons: [] }
  const w = (ret, d) => ({ ret, deltaRatio: d })
  ok('A: up + positive delta', e.divergence(w(0.02, 0.3), 0.005, gate).key === 'A')
  ok('B: up + negative delta', e.divergence(w(0.02, -0.3), 0.005, gate).key === 'B')
  ok('C: flat + strong positive delta', e.divergence(w(0.0005, 0.4), 0.005, gate).key === 'C')
  ok('D: flat + strong negative delta', e.divergence(w(-0.0005, -0.4), 0.005, gate).key === 'D')
  ok('E: down + strong negative delta', e.divergence(w(-0.02, -0.4), 0.005, gate).key === 'E')
  ok('gate closed → insufficient', e.divergence(w(0.02, 0.3), 0.005, { ok: false, reasons: ['x'] }).key === 'insufficient')
}

// --- impact table ---------------------------------------------------------
{
  const e = new OrderFlowEngine({ symbol: 'X', source: 'synthetic' })
  const qq = quoteQuality({ t: T, bid: 9.99, ask: 10.01 }, T, cfg)
  const book = { t: T, bids: [[9.99, 100], [9.98, 100]], asks: [[10.01, 100], [10.02, 1000]] }
  const tab = e.impactTable({ t: T, bid: 9.99, ask: 10.01, bidSize: 100, askSize: 100 }, qq, book, 0.001, 1e6)
  const r500 = tab.buy.find((r) => r.usd === 500), r5k = tab.buy.find((r) => r.usd === 5000)
  ok('$500 fills on the first level at the ask', r500.displayedPct > 0.999 && Math.abs(r500.avgPrice - 10.01) < 1e-9)
  ok('$5,000 walks to the second level (avg between)', r5k.avgPrice > 10.01 && r5k.avgPrice < 10.02)
  ok('executable < displayed beyond level 1', r5k.executablePct < r5k.displayedPct)
  const big = tab.buy.find((r) => r.usd === 100_000)
  ok('$100k exceeds displayed depth', big.displayedPct < 0.2 && big.quality === 'thin')
  ok('model impact grows with size', tab.buy[6].modelBps > tab.buy[0].modelBps)
  const top = e.impactTable({ t: T, bid: 9.99, ask: 10.01, bidSize: 100, askSize: 100 }, qq, null, 0.001, 1e6)
  ok('without Level 2 the basis says so', top.basis === 'top of book + model')
}

// --- dilution ---------------------------------------------------------------
{
  const now = Date.UTC(2026, 9, 8)
  ok('recent 424B5 = active', dilutionRisk([{ form: '424B5', filed: '2026-10-01' }], now).level === 'active')
  ok('S-3 shelf = shelf', dilutionRisk([{ form: 'S-3', filed: '2026-05-01' }], now).score === 0.5)
  ok('8-K item 3.02 = active', dilutionRisk([{ form: '8-K', filed: '2026-10-05', items: '3.02,9.01' }], now).score === 1)
  ok('nothing = 0', dilutionRisk([{ form: '10-Q', filed: '2026-08-01' }], now).score === 0)
  ok('no data = unknown', dilutionRisk(null, now).score === null)
}

// --- synthetic scenarios end to end -----------------------------------------
const runs = {}
for (const name of Object.keys(SCENARIOS)) {
  const g = generateScenario(name)
  const r = runStream(g.events, { symbol: 'DEMO', source: 'synthetic', stepMs: 5000 })
  runs[name] = { g, r, act: r.alerts.filter((a) => a.t >= g.warmupEnd).map((a) => a.type) }
}
ok('deterministic: same seed, same events', JSON.stringify(generateScenario('distribution').events.slice(0, 50)) === JSON.stringify(runs.distribution.g.events.slice(0, 50)))
ok('absorption scenario → POTENTIAL SELL-SIDE ABSORPTION', runs.sell_absorption.act.includes('sell_absorption'))
ok('absorption scenario → positive CVD stall', runs.sell_absorption.act.includes('positive_cvd_stall'))
ok('absorption scenario → selling once the seller wins', runs.sell_absorption.act.includes('selling_acceleration'))
ok('distribution scenario → distribution warning', runs.distribution.act.includes('distribution'))
ok('distribution scenario → spread widening', runs.distribution.act.includes('spread_widening'))
ok('withdrawal scenario → bid liquidity disappeared', runs.liquidity_withdrawal.act.includes('bid_withdrawal'))
ok('withdrawal scenario → selling acceleration', runs.liquidity_withdrawal.act.includes('selling_acceleration'))
ok('accumulation scenario → no severe sell alerts', !runs.accumulation.act.some((t) => ['sell_absorption', 'bid_withdrawal', 'distribution', 'selling_acceleration'].includes(t)))
ok('accumulation scenario reads A (price ↑ CVD ↑)', runs.accumulation.r.last.divergence.key === 'A')
ok('thin tape → insufficient data, no score', runs.quiet.r.last.status === 'insufficient' && runs.quiet.r.last.score.value == null && runs.quiet.act.length === 0)
for (const name of Object.keys(runs)) {
  const bad = runs[name].r.alerts.find((a) => !(a.t && a.symbol && a.evidence?.length && a.quoteQuality && a.sourceLabel && a.limitations?.length))
  ok(`${name}: every alert has time, symbol, evidence, quote quality, source, limitations`, !bad)
}
{
  // Dedupe: no type repeats at the same severity inside the cooldown.
  const a = runs.sell_absorption.r.alerts
  const dup = a.some((x, i) => a.slice(0, i).some((y) => y.type === x.type && x.t - y.t < cfg.alertCooldownMs && x.severity <= y.severity))
  ok('no repeated alert unless severity rises', !dup)
}
{
  const s = runs.distribution.r.last.score
  ok('score weights sum to 100', Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0) === 100)
  ok('score shows a reason for every component', s.components.every((c) => c.reason))
  ok('dilution unknown → excluded, coverage < 100%', s.coverage < 1 && s.components.find((c) => c.key === 'dilution').available === false)
}

// --- no look-ahead: a snapshot only depends on events up to its time ------
{
  const g = runs.distribution.g
  const at = g.warmupEnd + 10 * 60_000
  let streamed = null
  runStream(g.events, { symbol: 'DEMO', source: 'synthetic', stepMs: 5000, onSnapshot: (s) => { if (s.t === at) streamed = s } })
  const cut = runStream(g.events.filter((e) => e.t < at), { symbol: 'DEMO', source: 'synthetic', stepMs: 5000 })
  const fresh = cut.engine.snapshot(at)
  ok('snapshot at t equals a run that never saw events after t', streamed && streamed.score.value === fresh.score.value && streamed.windows['5m'].delta === fresh.windows['5m'].delta && streamed.distribution.level === fresh.distribution.level)
}

// --- backtest harness ---------------------------------------------------------
{
  const path = [100, 101, 102, 101, 90, 80, 82, 83].map((p, i) => ({ t: i * 60_000, p }))
  const L = labelSelloffs(path, { dropPct: 0.15, horizonMs: 3_600_000 })
  ok('selloff labelled at the peak', L.length === 1 && L[0].peak === 102 && L[0].trough === 80)
  const days = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'].map((date, i) => {
    const g = generateScenario(['distribution', 'accumulation', 'liquidity_withdrawal', 'sell_absorption'][i], { seed: 11 + i })
    return { symbol: 'DEMO', date, events: g.events, source: 'synthetic' }
  })
  const wf = walkForward(days, { gradeOpts: { dropPct: 0.05, fpDrop: 0.03 } })
  ok('walk-forward picks a threshold on train dates only', wf.trainDates.length === 2 && wf.testDates.length === 2 && wf.chosenThreshold >= 25 && wf.test)
  ok('grading reports coverage, false positives, MAE, outcomes, sessions, costs', ['coverage', 'falsePositiveRate', 'maeMedian', 'after', 'bySession', 'costBpsMedian'].every((k) => k in wf.test))
  const run = collectSignals(days[0])
  ok('alert-rule grading runs', grade([run], { kind: 'alerts', minSeverity: 2 }).signals >= 0)
}

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
