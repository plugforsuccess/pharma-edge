// Momentum picks today (owner, 2026-10-06: "what stocks are entries?"): the
// cross-sectional momentum rule as of the latest bar — every universe
// ticker's 12-1 return, eligible above its 200-day, the top decile — the
// one entry family whose stock selection held up in the pre-registered
// tests. Prints the list; writes nothing. Env: TICKERS, CONCURRENCY,
// MOMENTUM_OUT=file.json

import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { sma, historicalVol } from '../src/utils/indicators.js'
import { momentumScore, MOMENTUM } from '../src/utils/momentum.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const CONCURRENCY = Number(process.env.CONCURRENCY) || 6
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

const rows = (await mapLimit(universe, CONCURRENCY, async (ticker) => {
  try {
    const bars = await dailyBars(ticker, { range: '2y' })
    if (!bars || bars.length < 260) return null
    const closes = bars.map((b) => b.c)
    const i = closes.length - 1
    const s200 = sma(closes, 200)[i]
    const score = momentumScore(closes, i, MOMENTUM)
    if (score == null || s200 == null) return null
    const hv = historicalVol(closes, 60)[i]
    const hi252 = Math.max(...closes.slice(-252))
    return { ticker, asOf: bars[i].t, close: closes[i], score, above200: closes[i] > s200, vs200: closes[i] / s200 - 1, hv60: hv, ddFromHigh: closes[i] / hi252 - 1, r1m: closes[i] / closes[i - 21] - 1 }
  } catch { return null }
})).filter(Boolean)
const eligible = rows.filter((r) => r.above200).sort((a, b) => b.score - a.score)
const k = eligible.length >= MOMENTUM.minNames ? Math.max(1, Math.floor(eligible.length * MOMENTUM.topFrac)) : 0
const picks = eligible.slice(0, k)
const pct = (x) => `${(x * 100).toFixed(0).padStart(4)}%`
console.log(`Momentum picks as of ${rows[0]?.asOf}: ${rows.length} scored (Yahoo ${sources.yahoo}, edge ${sources.edge}), ${eligible.length} above their 200-day, top decile = ${k}.`)
console.log('  #  ticker    close   12-1 ret  vs 200d  1m     off 52w-hi  HV60')
picks.forEach((r, n) => console.log(`  ${String(n + 1).padStart(2)} ${r.ticker.padEnd(7)} ${r.close.toFixed(2).padStart(9)}  ${pct(r.score)}    ${pct(r.vs200)}  ${pct(r.r1m)}  ${pct(r.ddFromHigh)}      ${pct(r.hv60)}`))
if (process.env.MOMENTUM_OUT) { const { writeFileSync } = await import('node:fs'); writeFileSync(process.env.MOMENTUM_OUT, JSON.stringify({ asOf: rows[0]?.asOf, scored: rows.length, eligible: eligible.length, picks })) }
