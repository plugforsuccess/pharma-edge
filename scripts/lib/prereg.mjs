// The pre-registered test inside the universe replay
// (docs/signal-engine/preregistration.md). Given every ticker's bars and
// signals, SPY's bars, real IV history and dividends:
//   1. calibrate the IV-proxy premium on the samples that have real IV
//   2. for each premium in the grid (+ the calibrated one), run the three
//      rules (setup = BUY SETUP as shown · zone · confluence) with proxy
//      pricing, sticky vol, slippage tiers and dividends, and the controls:
//      SPY on the same dates (every premium), monthly DCA (every premium),
//      200 random-entry replications (calibrated premium, primary rule)
//   3. period results P1 / P2 / all, completed-only too, market buckets,
//      and the verdict — read at the calibrated premium
//   4. one export row per trade at the calibrated premium (replay_trades)

import { replayTrades, replayFromEntries, trailingVol, tradeStats, SWING, SWING_GRID, SWING_PIVOT_BARS } from '../../src/utils/replay.js'
import { swingPoints } from '../../src/utils/confluence.js'
import { randomEntries, mulberry32 } from '../../src/utils/controls.js'
import { PERIODS, PREMIUM_GRID, RANDOM_REPS, pricingFor, controlsForTicker, periodResult, bucketResults, verdict, periodOf, calibratePremium } from '../../src/utils/controls.js'

// momentum (2026-10-05, after the Triple result): cross-sectional 12-1
// momentum, top decile above the 200-day, rebalanced at month ends — a
// universe-level rule whose entries the job computes (src/utils/momentum.js)
// and hands in as `extraEntries`. The random control runs for it too.
// index (2026-10-05, after the momentum result): the SPY call bought at
// each completed month end — the benchmark as a rule of its own. SPY is
// handed in as an `extraResult` (it isn't in the universe) and only runs
// the rules named in `extraEntries` for it. Its SPY-same-day control is
// itself; the random and DCA controls are the comparison.
export const PREREG_RULES = ['setup', 'zone', 'confluence', 'triple', 'momentum', 'index']
export const RANDOM_RULES = new Set(['setup', 'momentum', 'index'])
const FWD = [['3m', 63], ['6m', 126], ['12m', 252]]
export const PRIMARY_RULE = 'setup'
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4)

// Forward stock returns per horizon and, per calendar month, the mean
// forward return over every bar of that month (the random-entry baseline
// for a signal in that month). Cached on the ticker.
function forward(r) {
  if (r._fwd) return r._fwd
  const c = r.bars.map((b) => b.c)
  const n = c.length
  const fwd = {}
  const monthMean = {}
  for (const [k, h] of FWD) {
    fwd[k] = c.map((x, i) => (i + h < n && x > 0 ? c[i + h] / x - 1 : null))
    const acc = new Map()
    fwd[k].forEach((v, i) => { if (v == null) return; const m = r.bars[i].t.slice(0, 7); const a = acc.get(m) ?? { s: 0, n: 0 }; a.s += v; a.n++; acc.set(m, a) })
    monthMean[k] = Object.fromEntries([...acc].map(([m, a]) => [m, a.s / a.n]))
  }
  r._fwd = { fwd, monthMean }
  return r._fwd
}

// Per-trade features for the export (all known at the signal bar, except
// the forward returns, which are the outcome).
export function features(r, t) {
  const i = t.signalI
  const bars = r.bars
  const f = forward(r)
  const month = bars[i].t.slice(0, 7)
  let hi = 0
  for (let k = Math.max(0, i - 251); k <= i; k++) hi = Math.max(hi, bars[k].h)
  let up = 0
  for (let k = i; k >= 0 && r.model.slope200[k] != null && r.model.slope200[k] > 0; k--) up++
  const key = r.sig.buyKey?.[i] || ''
  return {
    dd_from_high: hi > 0 ? r4(bars[i].c / hi - 1) : null,
    days_200_up: up,
    score: r.sig.buyScore?.[i] ?? null,
    lit: key ? key.split('+') : [],
    iv_rank_source: r.model.ivSource === 'iv' ? 'iv' : 'hv_standin',
    fwd_3m: r4(f.fwd['3m'][i]), fwd_6m: r4(f.fwd['6m'][i]), fwd_12m: r4(f.fwd['12m'][i]),
    rand_3m: r4(f.monthMean['3m'][month] ?? null), rand_6m: r4(f.monthMean['6m'][month] ?? null), rand_12m: r4(f.monthMean['12m'][month] ?? null),
  }
}

// Premium = median IV / proxy over rows with real IV, each matched to its
// ticker's RV60 / RV252 on that date.
export function calibrate(results, ivRows) {
  const byTicker = new Map(results.map((r) => [r.ticker, r]))
  const rv = new Map()
  const samples = []
  for (const row of ivRows) {
    const r = byTicker.get(row.ticker)
    if (!r || !(row.iv_30d > 0.02 && row.iv_30d < 3)) continue
    if (!rv.has(r.ticker)) {
      const closes = r.bars.map((b) => b.c)
      rv.set(r.ticker, { idx: new Map(r.bars.map((b, i) => [b.t, i])), rv60: trailingVol(closes, 60), rv252: trailingVol(closes, 252) })
    }
    const m = rv.get(r.ticker)
    const i = m.idx.get(String(row.sample_date))
    if (i == null) continue
    samples.push({ iv: Number(row.iv_30d), rv60: m.rv60[i], rv252: m.rv252[i] })
  }
  return { ...calibratePremium(samples), tickers: new Set(ivRows.map((x) => x.ticker)).size }
}

// The swing exit grid (docs/signal-engine/preregistration.md, "the swing
// exit", 2026-10-05): every entry rule × 16 exit variants at the calibrated
// premium — hit rate, days to target, hit / miss returns, by period and by
// signal year; a random-entry control (same months, same swing exit) for
// the default variant only.
export const SWING_RULES = ['setup', 'confluence', 'momentum', 'triple']
const SWING_RANDOM_REPS = 50
export function swingVariants() {
  const out = []
  for (const [target, pct] of SWING_GRID.targets) for (const maxHold of SWING_GRID.holds) for (const stopPct of SWING_GRID.stops) {
    out.push({ key: `${target}${target === 'pivot' ? '' : Math.round(pct * 100)}:${maxHold}:${stopPct == null ? 'none' : Math.round(stopPct * 100)}`, swing: { ...SWING, target, pct, maxHold, stopPct } })
  }
  return out
}
// Compact record per trade — the grid holds 28 variants × every trade of
// every rule, so whole trade objects (with their exits) blew the runner's
// memory on the first run. Only what the summary needs survives.
const compact = (t) => ({ y: t.signalT.slice(0, 4), p: periodOf(t.signalT), hit: !!t.hit, d: t.days, r: t.optionReturn, open: !!t.open })
function swingSummary(recs) {
  const by = (list) => {
    const rs = list.map((x) => x.r).filter((x) => x != null).sort((a, b) => a - b)
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
    const hits = list.filter((x) => x.hit)
    const days = hits.map((x) => x.d).sort((a, b) => a - b)
    return {
      n: list.length, open: list.filter((x) => x.open).length,
      hitRate: list.length ? r4(hits.length / list.length) : null, medDaysHit: days.length ? days[Math.floor(days.length / 2)] : null,
      avg: r4(mean(rs)), median: rs.length ? r4(rs[Math.floor(rs.length / 2)]) : null, lostHalf: rs.length ? r4(rs.filter((x) => x <= -0.5).length / rs.length) : null,
      hitAvg: r4(mean(hits.map((x) => x.r).filter((x) => x != null))), missAvg: r4(mean(list.filter((x) => !x.hit).map((x) => x.r).filter((x) => x != null))),
      avgDays: list.length ? Math.round(mean(list.filter((x) => !x.open).map((x) => x.d)) ?? 0) : null,
    }
  }
  const years = {}
  for (const x of recs) (years[x.y] ??= []).push(x)
  return {
    all: by(recs), P1: by(recs.filter((x) => x.p === 'P1')), P2: by(recs.filter((x) => x.p === 'P2')),
    byYear: Object.fromEntries(Object.entries(years).sort().map(([y, l]) => [y, by(l)])),
  }
}
export function runSwingGrid({ results, premium, ivByTicker = new Map(), dividendsByTicker = new Map(), extraEntries = new Map(), log = () => {} }) {
  const variants = swingVariants()
  const defaultKey = variants.find((v) => v.swing.target === SWING.target && v.swing.maxHold === SWING.maxHold && v.swing.stopPct === SWING.stopPct)?.key
  const acc = Object.fromEntries(SWING_RULES.map((r) => [r, Object.fromEntries(variants.map((v) => [v.key, []]))]))
  const randomAcc = Object.fromEntries(SWING_RULES.map((r) => [r, []]))
  let n = 0
  for (const r of results) {
    const pricing = pricingFor(r.bars, { premium, dividends: dividendsByTicker.get(r.ticker) ?? {}, realIv: ivByTicker.get(r.ticker) ?? null })
    const highs = swingPoints(r.bars, SWING_PIVOT_BARS).highs
    for (const rule of SWING_RULES) {
      const entries = extraEntries.has(rule) ? extraEntries.get(rule).get(r.ticker) : r.sig.entry?.[rule]
      if (!entries || !entries.some(Boolean)) continue
      for (const v of variants) {
        const trades = replayFromEntries(r.bars, entries, { exitRule: 'swing', swing: v.swing, highs, sell: r.sig.sell, ...pricing })
        for (const t of trades) acc[rule][v.key].push(compact(t))
        if (v.key === defaultKey && trades.length) {
          const rng = mulberry32(hash(r.ticker) ^ 0x5157)
          const dates = trades.map((t) => t.signalT)
          for (let k = 0; k < SWING_RANDOM_REPS; k++) {
            const rt = replayFromEntries(r.bars, randomEntries(r.bars, dates, rng), { exitRule: 'swing', swing: v.swing, highs, ...pricing })
            const a = (randomAcc[rule][k] ??= { n: 0, hits: 0, sum: 0 })
            for (const t of rt) { a.n++; if (t.hit) a.hits++; a.sum += t.optionReturn }
          }
        }
      }
    }
    if (++n % 100 === 0) log(`  swing grid: ${n}/${results.length}`)
  }
  const out = { grid: SWING_GRID, defaultKey, variants: variants.map((v) => ({ key: v.key, ...v.swing })), rules: {} }
  for (const rule of SWING_RULES) {
    const perVariant = Object.fromEntries(variants.map((v) => [v.key, swingSummary(acc[rule][v.key])]))
    const reps = (randomAcc[rule] ?? []).filter((a) => a && a.n > 0)
    const randomHit = reps.map((a) => a.hits / a.n)
    const randomAvg = reps.map((a) => a.sum / a.n)
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
    const own = perVariant[defaultKey]?.all
    const pctile = (xs, v) => (xs.length && v != null ? xs.filter((x) => x <= v).length / xs.length : null)
    out.rules[rule] = { variants: perVariant, random: { reps: reps.length, hitRate: r4(mean(randomHit)), avg: r4(mean(randomAvg)), hitPercentile: r4(pctile(randomHit, own?.hitRate)), avgPercentile: r4(pctile(randomAvg, own?.avg)) } }
  }
  return out
}

export function runPrereg({ results, spyBars, ivByTicker = new Map(), dividendsByTicker = new Map(), premium, premiumN = 0, reps = RANDOM_REPS, extraEntries = new Map(), extraResults = [], extraSummary = {}, log = () => {} }) {
  const premiums = [...new Set([...PREMIUM_GRID, premium].filter((x) => x != null))].sort((a, b) => a - b)
  const grid = {}
  const rows = []
  const spyDiv = dividendsByTicker.get('SPY') ?? {}
  const spyIv = ivByTicker.get('SPY') ?? null
  for (const pm of premiums) {
    const atCal = pm === premium
    const spyPricing = pricingFor(spyBars, { premium: pm, dividends: spyDiv, realIv: spyIv })
    const perRule = Object.fromEntries(PREREG_RULES.map((k) => [k, { paired: [], random: [], dca: [] }]))
    let n = 0
    const all = [...results, ...extraResults.map((r) => ({ ...r, _extraOnly: true }))]
    for (const r of all) {
      const pricing = pricingFor(r.bars, { premium: pm, dividends: dividendsByTicker.get(r.ticker) ?? {}, realIv: ivByTicker.get(r.ticker) ?? null })
      for (const rule of PREREG_RULES) {
        let trades
        if (r._extraOnly && !extraEntries.has(rule)) continue
        if (extraEntries.has(rule)) {
          const entries = extraEntries.get(rule).get(r.ticker)
          if (!entries) continue
          trades = replayFromEntries(r.bars, entries, { exitRule: 'targets', sell: r.sig.sell, ...pricing })
          for (const t of trades) t.key = null
        } else {
          if (!r.sig.entry?.[rule]) continue // a universe-level rule whose entries weren't handed in
          trades = replayTrades(r.bars, r.sig, { entryRule: rule, exitRule: 'targets', ...pricing })
        }
        if (!trades.length) continue
        const c = controlsForTicker({ bars: r.bars, spyBars, trades, pricing, spyPricing, reps: atCal && RANDOM_RULES.has(rule) ? reps : 0, seed: hash(r.ticker) })
        const acc = perRule[rule]
        for (const t of c.paired) acc.paired.push({ ...t, ticker: r.ticker })
        if (c.random.length) { // replication k across tickers = concat of each ticker's k-th replication
          if (!acc.random.length) acc.random = c.random.map(() => [])
          c.random.forEach((rep, k) => acc.random[k].push(...rep))
        }
        acc.dca.push(...c.dca)
        if (atCal) {
          for (const t of c.paired) {
            const f = features(r, t)
            rows.push({
              ticker: r.ticker, rule, exit_rule: 'targets', signal_date: t.signalT, fill_date: t.t, fill_price: r4(t.stock), strike: r4(t.strike), cost: r4(t.cost),
              vol: r4(t.vol), vol_source: pricing.volSourceAt(t.signalI), premium: pm, slippage: t.slip, div_yield: r4(t.q),
              exit_reason: t.open ? 'open' : t.exits[t.exits.length - 1]?.reason ?? null, exit_date: t.open ? null : t.endT, days: t.days, open: !!t.open,
              option_return: r4(t.optionReturn), stock_return: r4(t.stockReturn), best_stock: r4(t.bestStock),
              spy_control: r4(t.spyControl), spy_hold: r4(t.spyHold), ...f, period: periodOf(t.signalT),
            })
          }
        }
      }
      if (++n % 100 === 0) log(`  premium ${pm}: ${n}/${all.length}`)
    }
    grid[String(pm)] = {}
    for (const rule of PREREG_RULES) {
      const { paired, random, dca } = perRule[rule]
      const per = (opts) => Object.fromEntries([['all', null], ...PERIODS.map(([k]) => [k, k])].map(([label, period]) => [label, periodResult(paired, random, dca, { period, ...opts })]))
      grid[String(pm)][rule] = { marked: per({}), completed: per({ completedOnly: true }), buckets: bucketResults(paired), trades: paired.length, randomReps: random.length }
    }
    log(`premium ${pm} done`)
  }
  // The swing exit grid, at the calibrated premium (or 1.0 without one).
  log('swing grid…')
  const swing = runSwingGrid({ results: [...results, ...extraResults], premium: premium ?? 1, ivByTicker, dividendsByTicker, extraEntries, log })
  const cal = premium != null ? grid[String(premium)]?.[PRIMARY_RULE] : null
  const v = cal ? verdict({ P1: cal.marked.P1, P2: cal.marked.P2 }) : { verdict: 'inconclusive', why: 'no calibrated premium (too little real IV history)' }
  return {
    summary: {
      recorded: '2026-10-05', rule: PRIMARY_RULE, premium: { calibrated: premium, samples: premiumN, grid: premiums },
      reps, verdict: v, grid, swing, ...extraSummary,
    },
    rows,
  }
}

function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }
