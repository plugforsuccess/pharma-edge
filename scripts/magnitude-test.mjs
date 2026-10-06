// Magnitude test (owner, 2026-10-06: "did any signal predict magnitude?"):
// for every signal day, the biggest absolute move of the close within the
// next 60 trading days (and its up / down halves, and realized vol over the
// window) against random days in the same months on the same ticker —
// 50 replications, seeded. Direction-agnostic: a signal that can't say
// "something big is coming" describes the past. Reading rule in
// docs/signal-engine/preregistration.md ("the magnitude test").
//
// Env: TICKERS (subset), CONCURRENCY, MAGNITUDE_OUT=file.json

import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { entryModel, historicalVol, rank } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'
import { replayModel } from '../src/utils/replay.js'
import { crossSectionalEntries } from '../src/utils/momentum.js'
import { randomEntries, mulberry32, periodOf } from '../src/utils/controls.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const WINDOW = 60
const REPS = 50
const THRESHOLDS = [0.15, 0.25, 0.40]
const CONCURRENCY = Number(process.env.CONCURRENCY) || 6
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

// Signals under test. Buy-side entry rules as the replay defines them, the
// sell side (sell score reaching 2, Bravo bear turning on), and the
// cheap-vol entry the owner's question points at next: the 20-day
// historical vol's 252-day rank crossing below 25.
const SIGNALS = ['setup', 'zone', 'confluence', 'triple', 'bravo', 'recovery', 'sell', 'bravoBear', 'cheapVol', 'momentum']
const hash = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }

function signalsFor(bars, model, suite) {
  const rp = replayModel({ bars, model, suite })
  const hv = historicalVol(bars.map((b) => b.c), 20)
  const hvRank = rank(hv, 252)
  const cheap = hvRank.map((r, i) => r != null && r < 25 && (i === 0 || hvRank[i - 1] == null || hvRank[i - 1] >= 25))
  return {
    setup: rp.sig.entry.setup, zone: rp.sig.entry.zone, confluence: rp.sig.entry.confluence, triple: rp.sig.entry.triple,
    bravo: rp.sig.entry.bravo, recovery: rp.sig.entry.recovery,
    sell: rp.sig.bear.any, bravoBear: suite.bravo.bearOn.map((x) => !!x), cheapVol: cheap,
  }
}

// What happened after bar i: biggest |move| of the close in (i, i+WINDOW],
// its up and down halves, realized vol over the window (annualized).
function after(closes, i) {
  if (i + WINDOW >= closes.length) return null
  let up = 0, down = 0, s = 0, s2 = 0
  for (let j = i + 1; j <= i + WINDOW; j++) {
    const r = closes[j] / closes[i] - 1
    if (r > up) up = r
    if (r < down) down = r
    const lr = Math.log(closes[j] / closes[j - 1])
    s += lr; s2 += lr * lr
  }
  const v = Math.sqrt(Math.max(0, s2 / WINDOW - (s / WINDOW) ** 2) * 252)
  return { abs: Math.max(up, -down), up, down: -down, vol: v }
}

const acc = () => ({ n: 0, abs: 0, up: 0, down: 0, vol: 0, ge: THRESHOLDS.map(() => 0), absList: [] })
function add(a, m, keepList) {
  a.n++; a.abs += m.abs; a.up += m.up; a.down += m.down; a.vol += m.vol
  THRESHOLDS.forEach((t, k) => { if (m.abs >= t) a.ge[k]++ })
  if (keepList) a.absList.push(m.abs)
}
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4)
function stats(a) {
  if (!a.n) return null
  const sorted = [...a.absList].sort((x, y) => x - y)
  return { n: a.n, abs: r4(a.abs / a.n), median: sorted.length ? r4(sorted[Math.floor(sorted.length / 2)]) : null, up: r4(a.up / a.n), down: r4(a.down / a.n), vol: r4(a.vol / a.n),
    ge: Object.fromEntries(THRESHOLDS.map((t, k) => [`${Math.round(t * 100)}`, r4(a.ge[k] / a.n)])) }
}
const pctile = (xs, v) => (xs.length && v != null ? r4(xs.filter((x) => x <= v).length / xs.length) : null)

async function main() {
  const t0 = Date.now()
  const failed = []
  const loaded = (await mapLimit(universe, CONCURRENCY, async (ticker) => {
    try {
      const bars = await dailyBars(ticker)
      if (!bars || bars.length < 300) return null
      const model = entryModel(bars)
      const suite = suiteModel(bars)
      return { ticker, bars, model, sig: signalsFor(bars, model, suite) }
    } catch (e) { failed.push(`${ticker}: ${e.message}`); return null }
  })).filter(Boolean)
  console.log(`Loaded ${loaded.length}/${universe.length} tickers in ${Math.round((Date.now() - t0) / 1000)}s; ${failed.length} failed; Yahoo ${sources.yahoo}, edge ${sources.edge}.`)
  const mom = crossSectionalEntries(loaded.map((r) => ({ ticker: r.ticker, bars: r.bars, s200: r.model.s200 })))
  for (const r of loaded) r.sig.momentum = mom.entries.get(r.ticker)

  // Per signal: own stats (all / P1 / P2) and REPS random replications.
  const own = Object.fromEntries(SIGNALS.map((s) => [s, { all: acc(), P1: acc(), P2: acc() }]))
  const rand = Object.fromEntries(SIGNALS.map((s) => [s, Array.from({ length: REPS }, acc)]))
  const allDays = acc()
  for (const r of loaded) {
    const closes = r.bars.map((b) => b.c)
    const m = closes.map((_, i) => after(closes, i))
    for (let i = 0; i < closes.length; i++) if (m[i]) add(allDays, m[i], false)
    for (const s of SIGNALS) {
      const flags = r.sig[s]
      if (!flags) continue
      const dates = []
      flags.forEach((f, i) => { if (f && m[i]) { add(own[s].all, m[i], true); const p = periodOf(r.bars[i].t); if (p) add(own[s][p], m[i], false); dates.push(r.bars[i].t) } })
      if (!dates.length) continue
      const rng = mulberry32(hash(r.ticker) ^ 0x3a7d)
      for (let k = 0; k < REPS; k++) {
        const re = randomEntries(r.bars, dates, rng)
        re.forEach((f, i) => { if (f && m[i]) add(rand[s][k], m[i], false) })
      }
    }
  }
  const out = { window: WINDOW, reps: REPS, tickers: loaded.length, asOf: loaded[0]?.bars.at(-1)?.t, anyDay: stats(allDays), signals: {} }
  console.log(`\nMagnitude after a signal — biggest |move| of the close within ${WINDOW} trading days, vs random days in the same months (${REPS} replications):`)
  console.log(`  any day (every ticker, every day): n ${allDays.n}  |move| ${pct(allDays.abs / allDays.n)}  ≥15% ${pct(allDays.ge[0] / allDays.n)}  ≥25% ${pct(allDays.ge[1] / allDays.n)}  ≥40% ${pct(allDays.ge[2] / allDays.n)}`)
  console.log('  signal      n      |move|  up     down   ≥15%   ≥25%   ≥40%   vol    · random |move| ≥15%  ≥25%  · pctl |move| / ≥15% / ≥25%')
  for (const s of SIGNALS) {
    const o = stats(own[s].all)
    if (!o) { out.signals[s] = null; continue }
    const reps = rand[s].filter((a) => a.n > 0).map(stats)
    const rs = { abs: mean(reps.map((x) => x.abs)), up: mean(reps.map((x) => x.up)), down: mean(reps.map((x) => x.down)), vol: mean(reps.map((x) => x.vol)),
      ge: Object.fromEntries(THRESHOLDS.map((t) => [`${Math.round(t * 100)}`, mean(reps.map((x) => x.ge[`${Math.round(t * 100)}`]))])) }
    const p = { abs: pctile(reps.map((x) => x.abs), o.abs), ge15: pctile(reps.map((x) => x.ge['15']), o.ge['15']), ge25: pctile(reps.map((x) => x.ge['25']), o.ge['25']) }
    out.signals[s] = { own: o, P1: stats(own[s].P1), P2: stats(own[s].P2), random: { reps: reps.length, ...rs }, percentile: p }
    console.log(`  ${s.padEnd(10)} ${String(o.n).padStart(6)}  ${pct(o.abs)}  ${pct(o.up)}  ${pct(o.down)}  ${pct(o.ge['15'])}  ${pct(o.ge['25'])}  ${pct(o.ge['40'])}  ${pct(o.vol)}  · ${pct(rs.abs)}  ${pct(rs.ge['15'])}  ${pct(rs.ge['25'])}  · ${pc(p.abs)} / ${pc(p.ge15)} / ${pc(p.ge25)}`)
  }
  console.log('\nBy period (|move| mean, ≥15% share):')
  for (const s of SIGNALS) { const x = out.signals[s]; if (!x) continue; console.log(`  ${s.padEnd(10)} P1 ${x.P1 ? `${pct(x.P1.abs)} ${pct(x.P1.ge['15'])} (n ${x.P1.n})` : '—'} · P2 ${x.P2 ? `${pct(x.P2.abs)} ${pct(x.P2.ge['15'])} (n ${x.P2.n})` : '—'}`) }
  if (process.env.MAGNITUDE_OUT) { const { writeFileSync } = await import('node:fs'); writeFileSync(process.env.MAGNITUDE_OUT, JSON.stringify(out)) }
}
const pct = (x) => (x == null || !Number.isFinite(x) ? '    —' : `${(x * 100).toFixed(1).padStart(5)}%`)
const pc = (x) => (x == null ? '—' : `${Math.round(x * 100)}th`)
main().catch((e) => { console.error(e); process.exit(1) })
