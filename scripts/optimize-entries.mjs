// Rule optimizer over the universe (owner, 2026-10-04). Run by
// .github/workflows/optimize-entries.yml. See src/utils/optimizer.js for
// the grids, the score and the folds.
//
// For every ticker: 5 years of daily bars → entry model + signal suite →
// prepareTicker. Then, with trades cached per (entry, exit) candidate over
// the full history and bucketed by signal date for each fold:
//   stage 1  every entry × the default exit
//   stage 2  the top entries (per fold, by train score) × every exit
//   stage 3  every entry × the best exit (one more pass)
//   per fold: pick by train score → report the test trades it never saw
//   final:    pick on everything; expected performance = the folds' tests
//   frontier: every entry with the final exit — catch rate vs average
// → one optimizer_runs row (mode write), or printed (dry-run).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TICKERS (subset),
//      SPOTLIGHT=NOW,PLTR, CONCURRENCY (default 6), OPT_OUT=file.json.

import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { entryModel } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'
import {
  entryCandidates, exitCandidates, entryKey, exitKey, prepareTicker, candidateTrades, catchRate, compact, scoreTrades,
  pickBest, paretoFront, inTest, inTrain, FOLDS, DEFAULT_ENTRY, DEFAULT_EXIT, TOP_ENTRIES, describeEntry, describeExit,
} from '../src/utils/optimizer.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'

const args = process.argv.slice(2)
const MODE = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'dry-run'
if (!['write', 'dry-run'].includes(MODE)) throw new Error(`unknown mode ${MODE}`)
const CONCURRENCY = Number(process.env.CONCURRENCY) || 6
const SPOTLIGHT = new Set((process.env.SPOTLIGHT || 'NOW').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4)
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)
const round = (st) => Object.fromEntries(Object.entries(st).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? r4(v) : v]))

async function main() {
  const t0 = Date.now()
  const failed = []
  let done = 0
  const preps = (await mapLimit(universe, CONCURRENCY, async (ticker) => {
    try {
      const bars = await dailyBars(ticker)
      if (bars.length < 300) return null
      return { ticker, asOf: bars[bars.length - 1].t, prep: prepareTicker(bars, entryModel(bars), suiteModel(bars)) }
    } catch (e) { failed.push(e.message); return null } finally {
      done++
      if (done % 100 === 0) console.log(`  ${done}/${universe.length} prepared · ${failed.length} failed · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      if (done === 30 && failed.length >= 24) { console.error(`Market data is failing (${failed.slice(0, 3).join('; ')}) — aborting.`); process.exit(1) }
    }
  })).filter(Boolean)
  if (!preps.length) throw new Error(`no tickers prepared (${failed.slice(0, 5).join('; ')})`)
  const asOf = preps.map((p) => p.asOf).sort().pop()
  console.log(`Prepared ${preps.length}/${universe.length} tickers in ${((Date.now() - t0) / 1000).toFixed(0)}s; Yahoo ${sources.yahoo}, edge ${sources.edge}.`)

  // Trades for one (entry, exit) over the universe, cached.
  const cache = new Map()
  let evals = 0
  const run = (e, x) => {
    const key = `${entryKey(e)}|${exitKey(x)}`
    if (cache.has(key)) return cache.get(key)
    const trades = []
    let caught = 0
    let moves = 0
    const spot = {}
    for (const { ticker, prep } of preps) {
      const list = candidateTrades(prep, e, x)
      for (const t of list) trades.push(compact(t, ticker))
      const cr = catchRate(prep.moves, list)
      caught += cr.caught
      moves += cr.moves
      if (SPOTLIGHT.has(ticker)) spot[ticker] = list.map((t) => ({ signal: t.signalT, entry: t.t, end: t.endT, open: t.open, option: r4(t.optionReturn), stock: r4(t.stockReturn), exits: t.exits.map((q) => ({ t: q.t, mult: r4(q.mult), reason: q.reason })) }))
    }
    const out = { entry: e, exit: x, key, trades, catch: moves ? caught / moves : null, caught, moves, spot }
    cache.set(key, out)
    evals++
    if (evals % 200 === 0) console.log(`  ${evals} candidates · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    return out
  }

  const entries = entryCandidates()
  const exits = exitCandidates()
  const baseline = run(DEFAULT_ENTRY, DEFAULT_EXIT)

  // Stage 1: every entry with the default exit.
  const stage1 = entries.map((e) => run(e, DEFAULT_EXIT))
  // Stage 2: top entries per fold (and overall) × every exit.
  const topKeys = new Set()
  for (const fold of [...FOLDS, null]) {
    const ranked = stage1
      .map((r) => ({ r, st: scoreTrades(fold ? r.trades.filter((t) => inTrain(t, fold)) : r.trades) }))
      .filter((o) => o.st.n >= 30).sort((a, b) => b.st.score - a.st.score).slice(0, TOP_ENTRIES)
    for (const o of ranked) topKeys.add(entryKey(o.r.entry))
  }
  const topEntries = entries.filter((e) => topKeys.has(entryKey(e)))
  console.log(`Stage 2: ${topEntries.length} entries × ${exits.length} exits`)
  const stage2 = topEntries.flatMap((e) => exits.map((x) => run(e, x)))

  // Per fold: pick on train (over stages 1 + 2), report test.
  const pool = [...stage1, ...stage2]
  const folds = FOLDS.map((fold) => {
    const best = pickBest(pool, fold)
    const test = best ? scoreTrades(best.trades.filter((t) => inTest(t, fold))) : null
    const baseTest = scoreTrades(baseline.trades.filter((t) => inTest(t, fold)))
    const baseTrain = scoreTrades(baseline.trades.filter((t) => inTrain(t, fold)))
    return {
      fold: fold.name, train_end: fold.trainEnd, test_end: fold.testEnd,
      chosen: best ? { entry: best.entry, exit: best.exit, words: `${describeEntry(best.entry)} → ${describeExit(best.exit)}`, train: round(best.stats), test: round(test), catch: r4(best.catch) } : null,
      baseline: { train: round(baseTrain), test: round(baseTest) },
    }
  })

  // Final: pick on everything; stage 3 re-sweeps entries with its exit.
  let finalPick = pickBest(pool, null)
  const stage3 = entries.map((e) => run(e, finalPick.exit))
  const again = pickBest([...pool, ...stage3], null)
  if (again && again.score > finalPick.score) finalPick = again
  const finalAll = scoreTrades(finalPick.trades)
  const validated = scoreTrades(folds.flatMap((f) => (f.chosen ? pool.find((r) => r.key === `${entryKey(f.chosen.entry)}|${exitKey(f.chosen.exit)}`).trades.filter((t) => inTest(t, FOLDS.find((x) => x.name === f.fold))) : [])))
  const baselineValidated = scoreTrades(folds.flatMap((f) => baseline.trades.filter((t) => inTest(t, FOLDS.find((x) => x.name === f.fold)))))

  // Frontier: every entry with the final exit.
  const frontierPts = stage3.map((r) => {
    const st = scoreTrades(r.trades)
    return { entry: r.entry, words: describeEntry(r.entry), catch: r4(r.catch), avg: r4(st.avg), win: r4(st.win), n: st.n, bigLoss: r4(st.bigLoss) }
  })
  const frontier = paretoFront(frontierPts.filter((p) => p.n >= 30))

  // By year for the final rule (stability).
  const byYear = {}
  for (const t of finalPick.trades) (byYear[t.signal.slice(0, 4)] ??= []).push(t)
  const years = Object.fromEntries(Object.entries(byYear).sort().map(([y, l]) => [y, round(scoreTrades(l))]))
  const baseYears = {}
  for (const t of baseline.trades) (baseYears[t.signal.slice(0, 4)] ??= []).push(t)

  const summary = {
    as_of: asOf, tickers: preps.length, universe: universe.length, failed: failed.length, seconds: Math.round((Date.now() - t0) / 1000),
    candidates: evals, grid: { entries: entries.length, exits: exits.length },
    method: { score: 'mean option return (open trades marked) − 0.5 × share lost ≥ 50%, × n/(n+30)', folds: FOLDS, selection: 'train score; reported on test', min_train: 30 },
    baseline: { entry: DEFAULT_ENTRY, exit: DEFAULT_EXIT, words: `${describeEntry(DEFAULT_ENTRY)} → ${describeExit(DEFAULT_EXIT)}`, all: round(scoreTrades(baseline.trades)), validated: round(baselineValidated), catch: r4(baseline.catch),
      by_year: Object.fromEntries(Object.entries(baseYears).sort().map(([y, l]) => [y, round(scoreTrades(l))])) },
    final: { entry: finalPick.entry, exit: finalPick.exit, words: `${describeEntry(finalPick.entry)} → ${describeExit(finalPick.exit)}`, all: round(finalAll), validated: round(validated), catch: r4(finalPick.catch), caught: finalPick.caught, moves: finalPick.moves, by_year: years, spotlight: finalPick.spot },
    folds,
    frontier,
    stable: folds.every((f) => f.chosen && entryKey(f.chosen.entry) === entryKey(finalPick.entry) && exitKey(f.chosen.exit) === exitKey(finalPick.exit)),
    baseline_spotlight: baseline.spot,
  }

  console.log(`\n${evals} candidates in ${summary.seconds}s`)
  console.log(`Baseline  ${summary.baseline.words}`)
  console.log(`  all: n ${summary.baseline.all.n} win ${pct(summary.baseline.all.win)} avg ${pct(summary.baseline.all.avg)} · validated: n ${baselineValidated.n} win ${pct(baselineValidated.win)} avg ${pct(baselineValidated.avg)} · catch ${pct(baseline.catch)}`)
  console.log(`Final     ${summary.final.words}`)
  console.log(`  all: n ${finalAll.n} win ${pct(finalAll.win)} avg ${pct(finalAll.avg)} ≤−50% ${pct(finalAll.bigLoss)} · validated: n ${validated.n} win ${pct(validated.win)} avg ${pct(validated.avg)} · catch ${pct(finalPick.catch)} · stable ${summary.stable}`)
  for (const f of folds) console.log(`  fold ${f.fold}: ${f.chosen ? `${f.chosen.words} · train avg ${pct(f.chosen.train.avg)} (n ${f.chosen.train.n}) → test avg ${pct(f.chosen.test.avg)} win ${pct(f.chosen.test.win)} (n ${f.chosen.test.n}); baseline test avg ${pct(f.baseline.test.avg)}` : 'no eligible rule'}`)
  console.log('Frontier (catch → avg):')
  for (const p of frontier) console.log(`  ${pct(p.catch).padStart(7)} caught · avg ${pct(p.avg)} · win ${pct(p.win)} · n ${p.n} · ${p.words}`)
  if (process.env.OPT_OUT) { const { writeFileSync } = await import('node:fs'); writeFileSync(process.env.OPT_OUT, JSON.stringify(summary)) }
  if (MODE === 'dry-run') return

  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const { error } = await db.from('optimizer_runs').insert({ as_of: asOf, tickers: preps.length, summary })
  if (error) throw new Error(`optimizer_runs insert: ${error.message}`)
  console.log('\nWrote optimizer_runs.')
}

main().catch((e) => { console.error(e); process.exit(1) })
