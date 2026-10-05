// Checks for src/utils/controls.js (npm run controls:check).
import {
  clusterBootstrapDiff, mulberry32, periodOf, ivProxy, calibratePremium, slippageTier, dollarVolumeSeries, dividendYieldSeries,
  entriesAtDates, randomEntries, dcaEntries, clusterBootstrap, marketBucket, periodResult, verdict, controlsForTicker, pricingFor,
} from '../src/utils/controls.js'
import { replayFromEntries, oneTrade, trailingVol, replayTrades, replaySignals, bsCall } from '../src/utils/replay.js'
import { entryModel } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'

let passed = 0
const failures = []
const eq = (name, got, want, tol = 0) => {
  const ok = typeof want === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++; else failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

// PRNG is deterministic.
const r1 = mulberry32(42), r2 = mulberry32(42)
eq('seeded prng repeats', [r1(), r1()], [r2(), r2()])
eq('periods by signal date', [periodOf('2022-03-01'), periodOf('2023-12-31'), periodOf('2024-01-01'), periodOf('2021-06-01')], ['P1', 'P1', 'P2', null])

// IV proxy + calibration.
eq('proxy weights', ivProxy(0.2, 0.3, 1), 0.27, 1e-12)
eq('proxy premium', ivProxy(0.2, 0.3, 1.2), 0.324, 1e-12)
eq('proxy falls back to the vol it has', ivProxy(null, 0.3, 1), 0.3, 1e-12)
const samples = Array.from({ length: 40 }, (_, k) => ({ iv: 0.27 * (k % 2 ? 1.2 : 1.3), rv60: 0.2, rv252: 0.3 }))
eq('premium = median ratio', calibratePremium(samples).premium, 1.3, 1e-9)
eq('premium null under 30 samples', calibratePremium(samples.slice(0, 10)).premium, null)

// Slippage tiers + dollar volume.
eq('slippage tiers', [slippageTier(1e9), slippageTier(1e8), slippageTier(1e6)], [0.02, 0.04, 0.07])
const bars60 = Array.from({ length: 70 }, (_, i) => ({ t: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, o: 10, h: 10, l: 10, c: 10, v: 1000 }))
eq('dollar volume = avg close×volume', dollarVolumeSeries(bars60)[69], 10000, 1e-9)
eq('dollar volume null before the window fills', dollarVolumeSeries(bars60)[10], null)

// Dividend yield: trailing 12 months of amounts over the close.
const bars = []
for (let y = 2022; y <= 2023; y++) for (let m = 1; m <= 12; m++) for (const d of [3, 17]) bars.push({ t: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, o: 100, h: 101, l: 99, c: 100, v: 1e6 })
const dy = dividendYieldSeries(bars, { '2023-02-10': 0.5, '2023-05-10': 0.5, '2023-08-10': 0.5, '2023-11-10': 0.5 })
eq('yield counts the last 12 months', dy[bars.length - 1], 0.02, 1e-12)
eq('yield before any dividend is 0', dy[0], 0)

// Entries.
const e = entriesAtDates(bars, ['2022-03-17', '2022-03-18'])
eq('entry on the date, or the nearest earlier bar', [e[bars.findIndex((b) => b.t === '2022-03-17')], e.filter(Boolean).length], [true, 1])
const re = randomEntries(bars, ['2022-03-17', '2022-03-03', '2023-06-17'], mulberry32(1))
eq('random entries keep the per-month count', [re.slice(0, 48).filter((x, i) => x && bars[i].t.startsWith('2022-03')).length, re.filter((x, i) => x && bars[i].t.startsWith('2023-06')).length, re.filter(Boolean).length], [2, 1, 3])
eq('dca = first bar of each month', dcaEntries(bars).filter(Boolean).length, 24)

// Replay hooks: sticky vol, slippage per fill, overlap.
const up = bars.map((b, i) => ({ ...b, o: 100 + i, c: 100 + i, h: 101 + i, l: 99 + i }))
const sigma = trailingVol(up.map((b) => b.c), 60)
const ent = new Array(up.length).fill(false); ent[0] = true; ent[1] = true
const one = replayFromEntries(up, ent, { vol: sigma.map(() => 0.3), volAt: () => 0.3, sticky: true, slipAt: () => 0.05 })
const two = replayFromEntries(up, ent, { vol: sigma.map(() => 0.3), volAt: () => 0.3, sticky: true, slipAt: () => 0.05, allowOverlap: true })
eq('one position at a time skips the overlapping entry', one.length, 1)
eq('allowOverlap runs both', two.length, 2)
eq('slippage recorded on the trade', one[0].slip, 0.05)
eq('sticky vol = entry vol', one[0].vol, 0.3)
const cheap = replayFromEntries(up, ent, { vol: sigma.map(() => 0.3), volAt: () => 0.3, slipAt: () => 0.02 })[0]
eq('more slippage costs more', one[0].cost > cheap.cost, true)
// Dividend yield lowers a call's price at a fixed strike and lowers the
// strike that gives the same delta (so the trade's cost can go either way).
eq('dividend yield lowers the call price at a fixed strike', bsCall(100, 90, 2, 0.3, 0.04, 0.03) < bsCall(100, 90, 2, 0.3, 0.04, 0), true)
const q0 = oneTrade(up, up.map((b) => b.c), sigma.map(() => 0.3), 0, { volAt: () => 0.3 })
const q3 = oneTrade(up, up.map((b) => b.c), sigma.map(() => 0.3), 0, { volAt: () => 0.3, yieldAt: () => 0.03 })
eq('dividend yield recorded on the trade and lowers the strike for the same delta', [q3.q, q3.strike < q0.strike], [0.03, true])

// Bootstrap by cluster.
const items = [{ m: 'a', v: 1 }, { m: 'a', v: 1 }, { m: 'b', v: 3 }, { m: 'c', v: 5 }]
const bs = clusterBootstrap(items, (x) => x.v, (x) => x.m, { n: 500, seed: 3 })
eq('bootstrap mean is the plain mean', bs.mean, 2.5, 1e-12)
eq('bootstrap CI brackets the mean', bs.lo <= 2.5 && bs.hi >= 2.5 && bs.clusters === 3, true)
const d2 = clusterBootstrapDiff([{ m: 'a', v: 1 }, { m: 'b', v: 3 }, { m: 'c', v: 5 }], [{ m: 'a', v: 0 }, { m: 'b', v: 1 }, { m: 'c', v: 2 }], (x) => x.v, (x) => x.m, { n: 500, seed: 5 })
eq('two-sample bootstrap: diff of means, CI brackets it', [d2.diff, d2.lo <= d2.diff && d2.hi >= d2.diff], [2, true])
eq('market buckets', [marketBucket(-0.1), marketBucket(0.1), marketBucket(0.3), marketBucket(null)], ['down', 'flat', 'up', null])

// Verdict rule.
const good = { n: 200, months: 24, sampleFloor: true, spy: { diff: 0.2, lo: 0.05, hi: 0.4, lostHalf: 0.2 }, random: { percentile: 0.98 }, strategy: { lostHalf: 0.22 } }
const flat = { ...good, spy: { diff: 0.03, lo: -0.05, hi: 0.08, lostHalf: 0.2 }, random: { percentile: 0.6 } }
const neg = { ...good, spy: { diff: -0.02, lo: -0.1, hi: 0.06, lostHalf: 0.2 } }
const wide = { ...good, spy: { diff: 0.1, lo: -0.05, hi: 0.3, lostHalf: 0.2 }, random: { percentile: 0.9 } }
eq('edge needs both periods', verdict({ P1: good, P2: good }).verdict, 'edge')
eq('no edge: CI upper ≤ +10 in both', verdict({ P1: flat, P2: flat }).verdict, 'no edge')
eq('no edge: point estimate ≤ 0 in a period', verdict({ P1: good, P2: neg }).verdict, 'no edge')
eq('inconclusive: wide CI', verdict({ P1: wide, P2: wide }).verdict, 'inconclusive')
eq('inconclusive: floor', verdict({ P1: { ...good, sampleFloor: false }, P2: good }).verdict, 'inconclusive')
eq('edge in one period only is not edge', verdict({ P1: good, P2: wide }).verdict, 'inconclusive')

// End to end on a synthetic ticker: controls run, paired SPY returns exist,
// random distribution has `reps` entries, DCA has one trade per month.
const synth = []
let px = 100
const rng = mulberry32(9)
const d0 = new Date('2021-10-01T12:00:00Z')
for (let i = 0; i < 1300; i++) { const d = new Date(d0.getTime() + i * 86400000); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; px *= 1 + (rng() - 0.48) * 0.02; synth.push({ t: d.toISOString().slice(0, 10), o: px, h: px * 1.01, l: px * 0.99, c: px, v: 2e6 }) }
const spy = synth.map((b) => ({ ...b, c: b.c * 4, o: b.o * 4, h: b.h * 4, l: b.l * 4 }))
const model = entryModel(synth), suite = suiteModel(synth)
const sig = replaySignals(synth, model, suite)
const pricing = pricingFor(synth, { premium: 1.2 }), spyPricing = pricingFor(spy, { premium: 1.2 })
const trades = replayTrades(synth, sig, { entryRule: 'bravo', ...pricing })
if (trades.length) {
  const c = controlsForTicker({ bars: synth, spyBars: spy, trades, pricing, spyPricing, reps: 5, seed: 1 })
  eq('every strategy trade gets a SPY control', c.paired.every((t) => t.spyControl != null && t.spyHold != null), true)
  eq('random replications', c.random.length, 5)
  // The 252-day proxy vol doesn't exist for the first year, so those months have no priced trade.
  eq('dca monthly after the vol warm-up', c.dca.length > 25, true)
  const pr = periodResult(c.paired, c.random, c.dca, { period: null })
  eq('period result shapes', [typeof pr.spy.diff, typeof pr.random.percentile, pr.n], ['number', 'number', trades.length])
  eq('DCA CI brackets its point estimate', pr.dca.lo <= pr.dca.diff && pr.dca.hi >= pr.dca.diff, true)
} else failures.push('synthetic ticker produced no bravo trades')

console.log(`controls checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) { for (const x of failures) console.error('  ✗ ' + x); process.exit(1) }
