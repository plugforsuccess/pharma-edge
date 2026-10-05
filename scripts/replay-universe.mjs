// Universe replay (owner, 2026-10-03: NOW +84% — "how can the app suggest
// this trade and signal the exit?"). Run by .github/workflows/replay-universe.yml.
//
// For every ticker in the app's universe: 5 years of daily bars → the same
// entry model, signal suite and confluence math as the entry chart → the
// day-by-day replay in src/utils/replay.js (no look-ahead; the LEAPS call
// priced with Black-Scholes). Then, pooled across tickers:
//   runs          every entry rule × exit rule: trades, win rate, average /
//                 median option return, share losing half or more, stock
//                 return, days held, capture of the best move in the trade
//   moves         big moves (a swing low then +30% within 6 months), found
//                 after the fact: how many each entry rule caught (a signal
//                 from 10 days before the low up to half the move), how much
//                 of the move the trade kept, and why the misses were missed
//   missed        the biggest missed moves (tap through to the entry chart)
//   walk_forward  the history filter tested out of sample: each confluence
//                 trade judged only by setups whose 6-month result was known
//                 before its signal (own record blended toward the pool,
//                 like the ranking) — does "history says yes" beat "no"?
//   by_year       the default strategy's trades by entry year (stability)
//   puts          put debit spreads on 2+ sell signals (200-day falling /
//                 any trend) under the spread rules: the same stats, big
//                 drops (swing high then −20% within 3 months) caught
//   spotlight     every trade for SPOTLIGHT tickers (default NOW)
// → one row in replay_runs (mode write), or printed (dry-run).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TICKERS (subset),
//      SPOTLIGHT=NOW,PLTR, CONCURRENCY (default 3), REPLAY_OUT=file.json
//      (also write the summary to a file).

import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { entryModel, HORIZONS } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'
import { confluenceModel, blend, SHRINK_K } from '../src/utils/confluence.js'
import { replayModel, tradeStats, moveStats, dropStats, ENTRY_RULES, EXIT_RULES, BEAR_RULES, OPTION_MODEL, PUT_MODEL, MOVE, DROP } from '../src/utils/replay.js'
import { EXIT_PLAYBOOK } from '../src/utils/afterTax.js'
import { dailyBars, mapLimit, sources, dividendsByTicker } from './lib/marketData.mjs'
import { runPrereg, calibrate, PRIMARY_RULE } from './lib/prereg.mjs'
import { crossSectionalEntries, MOMENTUM } from '../src/utils/momentum.js'

const args = process.argv.slice(2)
const MODE = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'dry-run'
if (!['write', 'dry-run'].includes(MODE)) throw new Error(`unknown mode ${MODE}`)
const CONCURRENCY = Number(process.env.CONCURRENCY) || 6
const SPOTLIGHT = new Set((process.env.SPOTLIGHT || 'NOW').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))
const H6 = HORIZONS.findIndex(([l]) => l === '6M')
const H6_BARS = HORIZONS[H6][1]

const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4)
const compactTrade = (ticker, t) => ({
  ticker, signal: t.signalT, entry: t.t, end: t.endT, open: t.open, stock: r4(t.stock), strike: r4(t.strike ?? t.long), short: r4(t.short), cost: r4(t.cost),
  vol: r4(t.vol), option: r4(t.optionReturn), stockRet: r4(t.stockReturn), best: r4(t.bestStock), days: t.days, key: t.key,
  exits: t.exits.map((x) => ({ t: x.t, frac: r4(x.frac), mult: r4(x.mult), reason: x.reason })),
})

function analyze(ticker, bars) {
  if (!bars || bars.length < 300) return null
  const model = entryModel(bars)
  const suite = suiteModel(bars)
  const rp = replayModel({ bars, model, suite })
  const conf = confluenceModel({ bars, model, suite, horizons: HORIZONS })
  // Buy setups with the day their 6-month result became known.
  const setups = conf.buy.setups
    .filter((s) => s.returns[H6] != null && s.i + H6_BARS < bars.length)
    .map((s) => ({ key: s.key, r: s.returns[H6], done: bars[s.i + H6_BARS].t }))
  // bars / model / sig stay for the pre-registered test (controls + export).
  return { ticker, asOf: bars[bars.length - 1].t, rp, setups, bars, model, sig: rp.sig }
}

// Out-of-sample history estimate for each confluence trade: only setups
// whose 6M result was known before the signal — own (this ticker) blended
// toward the pool (all tickers), as the ranking does.
function walkForward(results, exitRule) {
  const byKey = new Map()
  for (const r of results) for (const s of r.setups) {
    if (!byKey.has(s.key)) byKey.set(s.key, [])
    byKey.get(s.key).push({ ...s, ticker: r.ticker })
  }
  for (const list of byKey.values()) list.sort((a, b) => a.done.localeCompare(b.done))
  const groups = { yes: [], no: [], unknown: [] }
  for (const r of results) {
    for (const t of r.rp.runs[`confluence:${exitRule}`].trades) {
      const list = byKey.get(t.key) ?? []
      let poolN = 0, poolSum = 0, ownN = 0, ownSum = 0
      for (const s of list) {
        if (s.done >= t.signalT) break
        poolN++; poolSum += s.r
        if (s.ticker === r.ticker) { ownN++; ownSum += s.r }
      }
      if (poolN < SHRINK_K) { groups.unknown.push(t); continue }
      const est = blend(ownN ? ownSum / ownN : null, ownN, poolSum / poolN)
      groups[est > 0 ? 'yes' : 'no'].push(t)
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, tradeStats(list)]))
}

async function main() {
  const t0 = Date.now()
  const failed = []
  let done = 0
  const results = (await mapLimit(universe, CONCURRENCY, async (ticker) => {
    try { return analyze(ticker, await dailyBars(ticker)) } catch (e) { failed.push(e.message); return null } finally {
      done++
      if (done % 50 === 0) console.log(`  ${done}/${universe.length} · ${failed.length} failed · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      if (done === 30 && failed.length >= 24) { console.error(`Market data is failing (${failed.slice(0, 3).join('; ')}) — aborting.`); process.exit(1) }
    }
  })).filter(Boolean)
  if (!results.length) throw new Error(`no tickers analyzed (${failed.slice(0, 5).join('; ')})`)
  const asOf = results.map((r) => r.asOf).sort().pop()

  // ── Pre-registered test: SPY, real IV history, premium, controls ──
  let spyBars = null
  try { spyBars = await dailyBars('SPY') } catch (e) { console.log(`SPY unavailable (${e.message}) — the pre-registered test is skipped this run.`) }
  let ivRows = []
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const db0 = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db0.from('iv_history').select('ticker, sample_date, iv_30d, source').not('source', 'ilike', '%backfill%').gt('iv_30d', 0.02).lt('iv_30d', 3).range(from, from + 999)
        if (error) throw error
        ivRows.push(...(data ?? []))
        if (!data || data.length < 1000) break
      }
    } catch (e) { console.log(`iv_history unavailable (${e.message}) — premium can't be calibrated this run.`) }
  }
  const ivByTicker = new Map()
  for (const row of ivRows) { if (!ivByTicker.has(row.ticker)) ivByTicker.set(row.ticker, {}); ivByTicker.get(row.ticker)[String(row.sample_date)] = Number(row.iv_30d) }
  const cal = calibrate(results, ivRows)
  console.log(`IV premium: ${cal.premium == null ? 'not calibrated' : cal.premium.toFixed(3)} from ${cal.n} real-IV samples on ${cal.tickers} tickers.`)
  let prereg = null
  let tradeRows = []
  if (spyBars) {
    const t1 = Date.now()
    // Cross-sectional momentum entries (12-1, top decile above the 200-day,
    // month ends) — computed across the universe, then replayed per ticker.
    const mom = crossSectionalEntries(results.map((r) => ({ ticker: r.ticker, bars: r.bars, s200: r.model.s200 })))
    const scored = mom.months.filter((m) => m.picked > 0)
    console.log(`Momentum: ${scored.length} scored months, ${scored.reduce((s, m) => s + m.picked, 0)} picks (avg ${scored.length ? Math.round(scored.reduce((s, m) => s + m.names, 0) / scored.length) : 0} eligible names / month).`)
    const pr = runPrereg({ results, spyBars, ivByTicker, dividendsByTicker, premium: cal.premium, premiumN: cal.n, log: (m) => console.log(m),
      extraEntries: new Map([['momentum', mom.entries]]),
      extraSummary: { momentum: { params: MOMENTUM, months: mom.months } } })
    prereg = { ...pr.summary, seconds: Math.round((Date.now() - t1) / 1000) }
    tradeRows = pr.rows
  }

  const runs = {}
  for (const [entryRule, entryLabel] of ENTRY_RULES) {
    for (const [exitRule, exitLabel] of EXIT_RULES) {
      const key = `${entryRule}:${exitRule}`
      const all = results.flatMap((r) => r.rp.runs[key].trades.map((t) => ({ ...t, ticker: r.ticker })))
      const closed = all.filter((t) => !t.open).sort((a, b) => b.optionReturn - a.optionReturn)
      runs[key] = {
        entryRule, exitRule, entryLabel, exitLabel, ...tradeStats(all),
        best: closed.slice(0, 5).map((t) => compactTrade(t.ticker, t)),
        worst: closed.slice(-5).reverse().map((t) => compactTrade(t.ticker, t)),
      }
    }
  }

  const moves = {}
  let missed = []
  for (const [entryRule, label] of ENTRY_RULES) {
    const graded = results.flatMap((r) => r.rp.graded[entryRule].graded.map((g) => ({ ...g, ticker: r.ticker })))
    const why = {}
    for (const g of graded) if (!g.caught && !g.held) why[g.why] = (why[g.why] ?? 0) + 1
    moves[entryRule] = { label, ...moveStats(graded), why }
    if (entryRule === 'confluence') {
      missed = graded.filter((g) => !g.caught && !g.held).sort((a, b) => b.gain - a.gain).slice(0, 60)
        .map((g) => ({ ticker: g.ticker, low: g.lowT, peak: g.peakT, gain: r4(g.gain), why: g.why, best: g.bestScore, combo: g.bestKey || null }))
    }
  }

  const walk = Object.fromEntries(EXIT_RULES.map(([exitRule]) => [exitRule, walkForward(results, exitRule)]))

  const puts = {}
  for (const [rule, label] of BEAR_RULES) {
    const all = results.flatMap((r) => r.rp.puts[rule].trades.map((t) => ({ ...t, ticker: r.ticker })))
    const closed = all.filter((t) => !t.open).sort((a, b) => b.optionReturn - a.optionReturn)
    const graded = results.flatMap((r) => r.rp.puts[rule].graded.map((g) => ({ ...g, ticker: r.ticker })))
    const why = {}
    for (const g of graded) if (!g.caught && !g.held) why[g.why] = (why[g.why] ?? 0) + 1
    const skipped = results.reduce((a, r) => a + (r.rp.puts[rule].skipped ?? 0), 0)
    puts[rule] = {
      rule, label, ...tradeStats(all, { bear: true }), skipped, drops: { ...dropStats(graded), why },
      best: closed.slice(0, 5).map((t) => compactTrade(t.ticker, t)),
      worst: closed.slice(-5).reverse().map((t) => compactTrade(t.ticker, t)),
    }
  }

  const byYear = {}
  for (const r of results) for (const t of r.rp.runs['confluence:targets'].trades) {
    const y = t.t.slice(0, 4)
    ;(byYear[y] ??= []).push(t)
  }
  const years = Object.fromEntries(Object.entries(byYear).sort().map(([y, list]) => [y, tradeStats(list)]))

  const spotlight = {}
  for (const r of results.filter((x) => SPOTLIGHT.has(x.ticker))) {
    spotlight[r.ticker] = {
      runs: Object.fromEntries(Object.entries(r.rp.runs).map(([k, v]) => [k, { stats: v.stats, trades: v.trades.map((t) => compactTrade(r.ticker, t)) }])),
      moves: r.rp.graded.confluence.graded.map((g) => ({ low: g.lowT, peak: g.peakT, gain: r4(g.gain), caught: g.caught, held: !!g.held, why: g.why ?? null, kept: r4(g.kept ?? null) })),
      puts: Object.fromEntries(Object.entries(r.rp.puts).map(([k, v]) => [k, { stats: v.stats, trades: v.trades.map((t) => compactTrade(r.ticker, t)) }])),
    }
  }

  const summary = {
    as_of: asOf, tickers: results.length, universe: universe.length, failed: failed.length,
    sources: { ...sources }, seconds: Math.round((Date.now() - t0) / 1000),
    option_model: OPTION_MODEL, plan: { targets: EXIT_PLAYBOOK.targets, fractions: EXIT_PLAYBOOK.fractions, runnerTrailPct: EXIT_PLAYBOOK.runnerTrailPct, rollDays: EXIT_PLAYBOOK.rollDays },
    move_rule: MOVE, drop_rule: DROP, put_model: PUT_MODEL, runs, moves, missed, walk_forward: walk, by_year: years, puts, spotlight,
    prereg,
  }

  const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)
  console.log(`Replayed ${results.length}/${universe.length} tickers in ${summary.seconds}s; ${failed.length} failed; as of ${asOf}; Yahoo ${sources.yahoo}, edge ${sources.edge}.`)
  if (failed.length) console.log('Failed (first 10):', failed.slice(0, 10).join(' | '))
  console.log('\nentry:exit            trades  win    avg      median   ≤−50%  days  capture')
  for (const [k, r] of Object.entries(runs)) console.log(`  ${k.padEnd(20)} ${String(r.n).padStart(5)}  ${pct(r.winRate).padStart(6)} ${pct(r.avg).padStart(8)} ${pct(r.median).padStart(8)} ${pct(r.bigLoss).padStart(6)} ${String(Math.round(r.avgDays ?? 0)).padStart(5)} ${pct(r.capture).padStart(7)}`)
  console.log('\nBig moves (+30% in 6 months from a swing low):')
  for (const [k, m] of Object.entries(moves)) console.log(`  ${k.padEnd(11)} ${m.caught}/${m.moves - m.held} caught (${pct(m.catchRate)}), kept ${pct(m.avgKept)} of the move · misses: ${JSON.stringify(m.why)}`)
  console.log('\nWalk-forward (confluence entries, history known before each signal):')
  for (const [k, w] of Object.entries(walk)) console.log(`  ${k.padEnd(8)} yes ${w.yes.n} avg ${pct(w.yes.avg)} win ${pct(w.yes.winRate)} · no ${w.no.n} avg ${pct(w.no.avg)} win ${pct(w.no.winRate)} · unknown ${w.unknown.n}`)
  console.log('\nPuts (put debit spreads on 2+ sell signals):')
  for (const [k, r] of Object.entries(puts)) console.log(`  ${k.padEnd(8)} ${String(r.n).padStart(5)} trades  win ${pct(r.winRate)}  avg ${pct(r.avg)}  median ${pct(r.median)}  ≤−50% ${pct(r.bigLoss)}  days ${Math.round(r.avgDays ?? 0)}  skipped ${r.skipped} · drops caught ${r.drops.caught}/${r.drops.drops - r.drops.held} (${pct(r.drops.catchRate)})`)
  for (const [t, s] of Object.entries(spotlight)) {
    console.log(`\n${t}:`)
    for (const tr of s.runs['confluence:targets'].trades) console.log(`  ${tr.entry} → ${tr.end}${tr.open ? ' (open)' : ''}  option ${pct(tr.option)}  stock ${pct(tr.stockRet)}  ${tr.exits.map((x) => `${x.reason}@${x.mult.toFixed(2)}x`).join(' ')}`)
    for (const m of s.moves) console.log(`  move ${m.low} → ${m.peak} ${pct(m.gain)}: ${m.caught ? `caught, kept ${pct(m.kept)}` : m.held ? 'held' : `missed (${m.why})`}`)
  }
  if (prereg) {
    const g = prereg.grid[String(prereg.premium.calibrated ?? prereg.premium.grid[0])]?.[PRIMARY_RULE]
    console.log(`\nPre-registered test (${PRIMARY_RULE} → targets, premium ${prereg.premium.calibrated ?? 'uncalibrated'}): ${prereg.verdict.verdict.toUpperCase()} — ${prereg.verdict.why}`)
    if (g) for (const k of ['all', 'P1', 'P2']) { const p = g.marked[k]; console.log(`  ${k.padEnd(3)} n ${p.n} months ${p.months} · strategy ${pct(p.strategy.mean)} · SPY ${pct(p.spy.mean)} · diff ${pct(p.spy.diff)} [${pct(p.spy.lo)}, ${pct(p.spy.hi)}] · random pctl ${p.random.percentile == null ? '—' : Math.round(p.random.percentile * 100)} · DCA diff ${pct(p.dca.diff)} · lost½ ${pct(p.strategy.lostHalf)} vs ${pct(p.spy.lostHalf)}`) }
    console.log('  by premium (all, diff vs SPY):', prereg.premium.grid.map((pm) => `${pm}: ${pct(prereg.grid[String(pm)]?.[PRIMARY_RULE]?.marked.all.spy.diff)}`).join(' · '))
  }
  if (process.env.REPLAY_OUT) { const { writeFileSync } = await import('node:fs'); writeFileSync(process.env.REPLAY_OUT, JSON.stringify(summary)) }
  if (process.env.REPLAY_TRADES_OUT && tradeRows.length) {
    const { writeFileSync } = await import('node:fs')
    const cols = Object.keys(tradeRows[0])
    const esc = (v) => (v == null ? '' : Array.isArray(v) ? `"${v.join('+')}"` : typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v))
    writeFileSync(process.env.REPLAY_TRADES_OUT, [cols.join(','), ...tradeRows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'))
    console.log(`Wrote ${tradeRows.length} trade rows to ${process.env.REPLAY_TRADES_OUT}.`)
  }
  if (MODE === 'dry-run') return

  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const { data: run, error } = await db.from('replay_runs').insert({ as_of: asOf, tickers: results.length, summary }).select('id').single()
  if (error) throw new Error(`replay_runs insert: ${error.message}`)
  console.log('\nWrote replay_runs.')
  for (let i = 0; i < tradeRows.length; i += 500) {
    const batch = tradeRows.slice(i, i + 500).map((r) => ({ ...r, run_id: run.id }))
    const { error: e2 } = await db.from('replay_trades').insert(batch)
    if (e2) throw new Error(`replay_trades insert (batch ${i / 500 + 1}): ${e2.message}`)
  }
  if (tradeRows.length) console.log(`Wrote ${tradeRows.length} replay_trades rows.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
