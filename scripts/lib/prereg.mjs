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

import { replayTrades, trailingVol } from '../../src/utils/replay.js'
import { PERIODS, PREMIUM_GRID, RANDOM_REPS, pricingFor, controlsForTicker, periodResult, bucketResults, verdict, periodOf, calibratePremium } from '../../src/utils/controls.js'

export const PREREG_RULES = ['setup', 'zone', 'confluence']
export const PRIMARY_RULE = 'setup'
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4)

// Per-trade features for the export (all known at the signal bar).
export function features(r, t) {
  const i = t.signalI
  const bars = r.bars
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

export function runPrereg({ results, spyBars, ivByTicker = new Map(), dividendsByTicker = new Map(), premium, premiumN = 0, reps = RANDOM_REPS, log = () => {} }) {
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
    for (const r of results) {
      const pricing = pricingFor(r.bars, { premium: pm, dividends: dividendsByTicker.get(r.ticker) ?? {}, realIv: ivByTicker.get(r.ticker) ?? null })
      for (const rule of PREREG_RULES) {
        const trades = replayTrades(r.bars, r.sig, { entryRule: rule, exitRule: 'targets', ...pricing })
        if (!trades.length) continue
        const c = controlsForTicker({ bars: r.bars, spyBars, trades, pricing, spyPricing, reps: atCal && rule === PRIMARY_RULE ? reps : 0, seed: hash(r.ticker) })
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
      if (++n % 100 === 0) log(`  premium ${pm}: ${n}/${results.length}`)
    }
    grid[String(pm)] = {}
    for (const rule of PREREG_RULES) {
      const { paired, random, dca } = perRule[rule]
      const per = (opts) => Object.fromEntries([['all', null], ...PERIODS.map(([k]) => [k, k])].map(([label, period]) => [label, periodResult(paired, random, dca, { period, ...opts })]))
      grid[String(pm)][rule] = { marked: per({}), completed: per({ completedOnly: true }), buckets: bucketResults(paired), trades: paired.length, randomReps: random.length }
    }
    log(`premium ${pm} done`)
  }
  const cal = premium != null ? grid[String(premium)]?.[PRIMARY_RULE] : null
  const v = cal ? verdict({ P1: cal.marked.P1, P2: cal.marked.P2 }) : { verdict: 'inconclusive', why: 'no calibrated premium (too little real IV history)' }
  return {
    summary: {
      recorded: '2026-10-05', rule: PRIMARY_RULE, premium: { calibrated: premium, samples: premiumN, grid: premiums },
      reps, verdict: v, grid,
    },
    rows,
  }
}

function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }
