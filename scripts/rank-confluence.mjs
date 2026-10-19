// Nightly confluence ranking (owner, 2026-10-03: rank the universe on
// confluence; "identify lows (buy entries) and extended highs (exits)").
// Run by .github/workflows/confluence-rank.yml after the close.
//
// For every ticker in the app's universe (src/lib/chartTickers.js — the
// sector ETFs + the ticker list): 5 years of Yahoo daily bars → the same
// entry model, signal suite and confluence math the entry chart runs
// (src/utils/). Then:
//   pool    every ticker's setups pooled per side and combination
//           → confluence_pool (the universe-wide record of each combination)
//   ranks   today's score per side, blended estimate for today's
//           combination (own record shrunk toward the pool), and the rank:
//             buy   score ≥ 2, the 200-day rising
//             sell  score ≥ 2
//           most signals first, then more buy-zone conditions (buy), then
//           the fresher signal, then the blended history as a tiebreaker
//           (the walk-forward test showed history adds no edge) →
//           confluence_ranks
//   alerts  (mode full) users with entry alerts on: a Tracking / holding
//           ticker entering the buy top 10, a holding entering the sell top
//           10 → an alerts row (the bell) + one email per user via Resend
//           (placeholder until RESEND_API_KEY / RESEND_FROM are set).
//
// Modes:  --mode full (cron) · rank-only (writes ranks + pool, no alerts)
//         · dry-run (computes and prints, writes nothing)
// Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (not needed for dry-run),
//         RESEND_API_KEY, RESEND_FROM, APP_URL (optional),
//         TICKERS=XLK,AAPL (optional subset), CONCURRENCY (default 4).

import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { entryModel, HORIZONS } from '../src/utils/indicators.js'
import { suiteModel } from '../src/utils/signalSuite.js'
import { confluenceModel, poolStats, blendedEstimate, baselineStats, MIN_SCORE, SIDES } from '../src/utils/confluence.js'
import { alignCloses } from '../src/utils/signalSuite.js'
import { dailyBars, mapLimit, sources } from './lib/marketData.mjs'
import { blockers, buyVerdict, sellVerdict, tradeSpec, structureStop, momentum, ownRecord, holdReason } from './lib/verdict.mjs'
import { momentumToday, moveGroups, forwardOutcome, SWING_PLAN } from '../src/utils/momentumList.js'
import { createHash } from 'node:crypto'
import { replaySignals, trailingVol, OPTION_MODEL } from '../src/utils/replay.js'
import { callHistory, callStats, exitHistory, exitStats, PLAYS, playModel, playSpan, playContract, SWING_EXIT } from '../src/utils/callHistory.js'
import { leaderSeries, leaderMisses } from '../src/utils/leaders.js'
import { leaderStints } from '../src/utils/leaderRecord.js'
import { THEMES, themeOf, returnsByDate } from '../src/utils/themes.js'
import { marketPulse } from '../src/utils/marketPulse.js'

const args = process.argv.slice(2)
const MODE = (args[args.indexOf('--mode') + 1] && args.includes('--mode')) ? args[args.indexOf('--mode') + 1] : 'dry-run'
if (!['full', 'rank-only', 'dry-run'].includes(MODE)) throw new Error(`unknown mode ${MODE}`)
const CONCURRENCY = Number(process.env.CONCURRENCY) || 6
const TOP = 10

const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

// One ticker → everything the ranking needs (null when too little history).
export function analyze(ticker, bars, spy = null) {
  if (!bars || bars.length < 300) return null
  const model = entryModel(bars)
  const suite = suiteModel(bars)
  const market = spy ? alignCloses(bars, spy) : null
  const conf = confluenceModel({ bars, model, suite, horizons: HORIZONS, market })
  const lastIdx = bars.length - 1
  const lastSignal = (flags) => { for (let i = lastIdx; i >= Math.max(0, lastIdx - 10); i--) if (Object.values(flags).filter((f) => f && Array.isArray(f)).some((f) => f[i])) return bars[i].t; return null }
  const c = model.status.cond
  // E+T+B convergence already computed in confluenceFlags; get today's value
  const etbToday = conf.buy.flags.etb?.[lastIdx]?.fired ?? false
  return {
    ticker, asOf: bars[lastIdx].t, close: bars[lastIdx].c, bars,
    trendUp: model.status.slope200 != null && model.status.slope200 > 0,
    conditionsMet: ['band', 'rising', 'trend', 'rsi', 'iv'].filter((k) => c[k]).length,
    etbConvergence: etbToday,
    cond: c, blockers: blockers(model), trade: tradeSpec(bars), stop: structureStop(bars, { sma200: model.status.sma200, bandPct: model.params.bandPct }), momentum: momentum(suite),
    closes: bars.map((b) => b.c), market, ownRecord: ownRecord(bars, model, suite),
    buy: { today: conf.buy.today, setups: conf.buy.setups, lastSignal: lastSignal(conf.buy.flags) },
    sell: { today: conf.sell.today, setups: conf.sell.setups, lastSignal: lastSignal(conf.sell.flags) },
    ...(() => {
      const { out, leaderDays } = callPaths(bars, spy)
      // The leader record (owner, 2026-10-19): each stint on the list and
      // the price change since joining (src/utils/leaderRecord.js).
      const stints = leaderStints(bars, leaderDays, { spy: spy ? new Map(spy.map((b) => [b.t, b.c])) : null })
      return { calls: out, stints }
    })(),
    leader: leaderToday(bars, spy),
  }
}

// Leaders (owner, 2026-10-16: "We only want leaders"; src/utils/leaders.js):
// today's traits and the rules missed ([] = a leader).
function leaderToday(bars, spy) {
  const tr = leaderSeries(bars, spy ?? []).at(bars.length - 1)
  const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000)
  // How far the close sits under its 20-day high (the dip swing's entry).
  const n = bars.length
  let hi = 0
  for (let j = Math.max(0, n - 20); j < n; j++) hi = Math.max(hi, bars[j].h)
  const off20 = hi > 0 ? r3(1 - bars[n - 1].c / hi) : null
  return { misses: leaderMisses(tr), traits: tr ? { mom12: r3(tr.mom12), vs200: r3(tr.vs200), slope200: r3(tr.slope200), volRank: r3(tr.volRank), spyUp: tr.spyUp, off20 } : null }
}

// The at-the-money plays (owner, 2026-10-15; leaders 2026-10-16): after
// each past day the stock was a leader (one per 21 trading days — the
// Leaders rule, no timing signal), the stock's gain over 1M / 3M / 6M /
// 12M / 2Y beside the matching ATM call held to expiry
// (src/utils/callHistory.js).
function callPaths(bars, spy) {
  const vols = trailingVol(bars.map((b) => b.c), OPTION_MODEL.volBars)
  const ls = leaderSeries(bars, spy ?? [], { vol: vols })
  const leaderDays = bars.map((_, i) => leaderMisses(ls.at(i)).length === 0)
  const out = {}
  for (const p of PLAYS) {
    out[p.key] = {
      leader: callHistory(bars, leaderDays, { vols, opt: playModel(p), horizons: playSpan(p) }),
      // The same leader days graded on the exit plan (owner, 2026-10-16).
      exit: exitHistory(bars, leaderDays, p, { vols }),
    }
  }
  return { out, leaderDays }
}

// Universe-wide play history per rule (shared by every row).
export function callPool(results) {
  const out = { tickers: results.length }
  for (const p of PLAYS) {
    const all = (k) => results.flatMap((r) => r.calls?.[p.key]?.[k] ?? [])
    out[p.key] = { leader: callStats(all('leader'), playSpan(p)), exit: exitStats(all('exit')) }
  }
  return out
}

const h = (est, label) => est?.horizons.find((x) => x.label === label)?.avg ?? null
const hz = (est, label, k) => est?.horizons.find((x) => x.label === label)?.[k] ?? null

// Ranks from analyzed tickers + the pools. Pure (tested by dry runs).
// Buy side: rows meeting the entry rule (verdict enter) first, then
// Tier 1: E+T+B convergence (Echo + Tango + Bravo within 10 bars)
// Tier 2: other combos
// Within each tier, sorted by: score, conditions_met, last_signal, est_6m
export function rankAll(results, pools, calls = null) {
  const rows = []
  for (const side of SIDES) {
    const cands = []
    for (const r of results) {
      const est = blendedEstimate({ today: r[side].today, setups: r[side].setups, pool: pools[side], horizons: HORIZONS, side })
      const now = r[side].today.now
      const hold = side === 'buy' ? holdReason(r.ownRecord, r.ticker) : null
      const row = {
        side, ticker: r.ticker, as_of: r.asOf, close: r.close, score: now?.score ?? 0, lit: now?.lit ?? [],
        combo: now?.key || null, conditions_met: side === 'buy' ? r.conditionsMet : null, trend_up: r.trendUp,
        own_n: est?.ownN ?? 0, pool_n: est?.poolN ?? 0, est_at_turn: est?.atTurn ?? null,
        est_3m: h(est, '3M'), est_6m: h(est, '6M'), est_12m: h(est, '12M'),
        est_win_6m: est?.horizons.find((x) => x.label === '6M')?.winRate ?? null,
        est_win_3m: est?.horizons.find((x) => x.label === '3M')?.winRate ?? null,
        est_med_3m: hz(est, '3M', 'median'), est_med_6m: hz(est, '6M', 'median'),
        est_badq_3m: hz(est, '3M', 'badq'), est_badq_6m: hz(est, '6M', 'badq'),
        est_beat_3m: hz(est, '3M', 'beat'), est_beat_6m: hz(est, '6M', 'beat'),
        last_signal: r[side].lastSignal, etb_convergence: side === 'buy' ? r.etbConvergence : false, rank: null,
        verdict: side === 'buy' ? buyVerdict({ leader: r.leader?.misses?.length === 0 }) : sellVerdict({ score: now?.score ?? 0, lit: now?.lit ?? [] }),
        hold_reason: hold,
        blockers: side === 'buy' ? r.blockers : null, trade: side === 'buy' ? r.trade : null,
        stop_price: r.stop?.price ?? null, stop_date: r.stop?.date ?? null, momentum: r.momentum,
        own_record: side === 'buy' ? r.ownRecord : null,
        leader: side === 'buy' ? r.leader?.misses?.length === 0 : null,
        leader_traits: side === 'buy' && r.leader ? { ...r.leader.traits, misses: r.leader.misses, since: (() => { const o = r.stints?.find((x) => x.open); return o ? { on: o.joined_on, close: o.join_close, gain: o.gain, spy_gain: o.spy_gain } : null })() } : null,
        // The row's sparkline: the last 3 months of closes (owner, 2026-10-16: Robinhood-style list).
        spark: side === 'buy' ? r.closes.slice(-63).map((c) => Math.round(c * 100) / 100) : null,
        call_hist: side === 'buy' && r.calls ? {
          plays: Object.fromEntries(PLAYS.map((p) => [p.key, {
            own: { leader: callStats(r.calls[p.key].leader, playSpan(p))[0], exit: exitStats(r.calls[p.key].exit) },
            pool: { leader: calls[p.key].leader[0], exit: calls[p.key].exit },
          }])),
        } : null,
      }
      rows.push(row)
      // Eligible — buy: a leader today, no timing signal (owner, 2026-10-16:
      // the leader-timing study found leaders bought any day did as well as
      // leaders with 2+ signals — 60% / +50% vs 61% / +54% on 2024+ — so the
      // signals no longer gate). Sell: 2+ sell signals (not shown in the app).
      const eligible = side === 'buy' ? row.leader : row.score >= MIN_SCORE
      if (eligible) cands.push(row)
    }
    // Tier 1: E+T+B convergence (buy side only), then Tier 2: other 3+ signals
    cands.sort((a, b) => {
      // Buy side: leaders, strongest first (12-1 return; owner, 2026-10-16).
      if (side === 'buy') {
        const m = (r) => r.leader_traits?.mom12 ?? 0
        if (m(b) !== m(a)) return m(b) - m(a)
      }
      // Tier by E+T+B convergence (buy side) — tier 1 first
      if (side === 'buy') {
        if (b.etb_convergence !== a.etb_convergence) return (b.etb_convergence ? 1 : 0) - (a.etb_convergence ? 1 : 0)
      }
      // Within tier: score, conditions_met, last_signal, est_6m
      return b.score - a.score
        || (side === 'buy' ? (b.conditions_met ?? 0) - (a.conditions_met ?? 0) : 0)
        || String(b.last_signal ?? '').localeCompare(String(a.last_signal ?? ''))
        || (side === 'buy' ? (b.est_6m ?? 0) - (a.est_6m ?? 0) : (a.est_3m ?? 0) - (b.est_3m ?? 0))
    })
    cands.forEach((row, k) => { row.rank = k + 1 })
    // Cluster risk (owner, 2026-10-16): leaders whose last 120 days of
    // returns correlate ≥ 0.7 move together — buying several is one bet.
    // Peers listed in rank order on the row's leader_traits.moves_with.
    if (side === 'buy' && cands.length > 1) {
      const closesOf = new Map(results.map((r) => [r.ticker, r.closes]))
      const groups = moveGroups(cands.map((c) => ({ ticker: c.ticker, closes: closesOf.get(c.ticker) ?? [] })))
      const rankOf = new Map(cands.map((c) => [c.ticker, c.rank]))
      for (const c of cands) {
        const peers = groups.get(c.ticker)?.peers ?? []
        if (c.leader_traits) c.leader_traits.moves_with = peers.sort((a, b) => rankOf.get(a) - rankOf.get(b))
      }
    }
    // The kind of bet (owner, 2026-10-16): the industry fund it tracks.
    if (side === 'buy') {
      const themeOfTicker = new Map(results.map((r) => [r.ticker, r.theme]))
      for (const c of cands) if (c.leader_traits) c.leader_traits.theme = themeOfTicker.get(c.ticker) ?? null
    }
  }
  return rows
}

// Baseline row per side: combo '__any_day__' — every ticker, every day.
export const ANY_DAY = '__any_day__'

export function poolRows(pools, results, asOf, baselines = null) {
  const out = []
  const row = (side, p, combo, lit, score) => {
    const hz = (label) => p.horizons.find((x) => x.label === label)
    return {
      side, combo, lit, score, n: p.n, graded: p.graded ?? 0, at_turn: p.atTurn ?? null,
      avg_3m: hz('3M')?.avg ?? null, avg_6m: hz('6M')?.avg ?? null, avg_12m: hz('12M')?.avg ?? null,
      win_3m: hz('3M')?.winRate ?? null, win_6m: hz('6M')?.winRate ?? null, win_12m: hz('12M')?.winRate ?? null,
      med_3m: hz('3M')?.median ?? null, med_6m: hz('6M')?.median ?? null, med_12m: hz('12M')?.median ?? null,
      badq_3m: hz('3M')?.badq ?? null, badq_6m: hz('6M')?.badq ?? null, badq_12m: hz('12M')?.badq ?? null,
      beat_3m: hz('3M')?.beat ?? null, beat_6m: hz('6M')?.beat ?? null, beat_12m: hz('12M')?.beat ?? null,
      tickers: results.length, as_of: asOf, updated_at: new Date().toISOString(),
    }
  }
  for (const side of SIDES) {
    for (const p of Object.values(pools[side])) out.push(row(side, p, p.key, p.lit, p.score))
    if (baselines?.[side]) out.push(row(side, baselines[side], ANY_DAY, [], 0))
  }
  return out
}

const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)

async function main() {
  const t0 = Date.now()
  const failed = []
  let done = 0
  // The S&P 500 once, for "beat the market" (null → the record has no beat rate).
  let spy = null
  try { spy = await dailyBars('SPY') } catch (e) { console.log(`SPY unavailable (${e.message}) — no market comparison this run.`) }
  // Industry funds, for naming what kind of bet each leader is (themes.js).
  const fundReturns = new Map()
  await mapLimit(THEMES.map(([etf]) => etf), CONCURRENCY, async (etf) => {
    try { fundReturns.set(etf, returnsByDate(await dailyBars(etf))) } catch (e) { console.log(`theme fund ${etf} unavailable (${e.message})`) }
  })
  console.log(`Theme funds: ${fundReturns.size}/${THEMES.length}`)
  const results = (await mapLimit(universe, CONCURRENCY, async (ticker) => {
    try { const bars = await dailyBars(ticker); const a = analyze(ticker, bars, spy); return a && { ...a, theme: themeOf(ticker, bars, fundReturns) } } catch (e) { failed.push(`${ticker}: ${e.message}`); return null } finally {
      done++
      if (done % 50 === 0) console.log(`  ${done}/${universe.length} · ${failed.length} failed · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      // Yahoo blocking this runner: stop instead of retrying for hours.
      if (done === 30 && failed.length >= 24) { console.error(`Yahoo is failing (${failed.slice(0, 3).join('; ')}) — aborting.`); process.exit(1) }
    }
  })).filter(Boolean)
  if (!results.length) throw new Error(`no tickers analyzed (${failed.slice(0, 5).join('; ')})`)
  const asOf = results.map((r) => r.asOf).sort().pop()
  const pools = Object.fromEntries(SIDES.map((side) => [side, poolStats(results.map((r) => r[side].setups), HORIZONS, side)]))
  const baselines = Object.fromEntries(SIDES.map((side) => [side, baselineStats(results.map((r) => ({ closes: r.closes, market: r.market })), HORIZONS, side)]))
  const calls = callPool(results)
  const rows = rankAll(results, pools, calls)
  for (const p of PLAYS) for (const k of ['leader']) { const x = calls[p.key][k][0]; console.log(`Play ${p.span.padEnd(3)} ${k.padEnd(10)} n ${x.n} · stock avg ${pct(x.stock)} med ${pct(x.stockMedian)} up ${Math.round((x.stockWin ?? 0) * 100)}% · ATM call to expiry avg ${pct(x.avg)} med ${pct(x.median)} up ${Math.round((x.win ?? 0) * 100)}%`) }
  const pool = poolRows(pools, results, asOf, baselines)
  for (const side of SIDES) { const b = baselines[side].horizons; console.log(`Baseline ${side}: any day, 3M win ${(b[0].winRate * 100).toFixed(0)}% median ${(b[0].median * 100).toFixed(1)}% · 6M win ${(b[1].winRate * 100).toFixed(0)}% median ${(b[1].median * 100).toFixed(1)}% beat ${b[1].beat == null ? '—' : (b[1].beat * 100).toFixed(0) + '%'}`) }
  console.log(`Analyzed ${results.length}/${universe.length} tickers in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${failed.length} failed; as of ${asOf}; bars from Yahoo ${sources.yahoo}, edge ${sources.edge}.`)
  if (failed.length) console.log('Failed (first 10):', failed.slice(0, 10).join(' | '))
  for (const side of SIDES) {
    const top = rows.filter((r) => r.side === side && r.rank != null).sort((a, b) => a.rank - b.rank).slice(0, TOP)
    console.log(`\nTop ${TOP} ${side}:`)
    for (const r of top) console.log(side === 'buy'
      ? `  ${String(r.rank).padStart(2)}. ${r.ticker.padEnd(6)} 12-1 ${pct(r.leader_traits?.mom12)}  vs200 ${pct(r.leader_traits?.vs200)}  200d slope ${pct(r.leader_traits?.slope200)}  vol rank ${pct(r.leader_traits?.volRank)}${r.leader_traits?.theme ? `  [${r.leader_traits.theme.name} ${r.leader_traits.theme.corr}]` : ''}${r.leader_traits?.moves_with?.length ? `  moves with ${r.leader_traits.moves_with.join(', ')}` : ''}`
      : `  ${String(r.rank).padStart(2)}. ${r.ticker.padEnd(6)} ${r.score}/5 ${String(r.combo ?? '').padEnd(28)} 3M ${pct(r.est_3m)} 6M ${pct(r.est_6m)}  at turn ${pct(r.est_at_turn)}  (own ${r.own_n}, pool ${r.pool_n})`)
  }
  // Momentum list (owner, 2026-10-07): today's top decile on the 12-1 rule,
  // each with the call the replay would price and the names it moves with.
  const mom = momentumToday(results.map((r) => ({ ticker: r.ticker, bars: r.bars })))
  const byTicker = new Map(results.map((r) => [r.ticker, r]))
  const groups = moveGroups(mom.picks.map((p) => ({ ticker: p.ticker, closes: byTicker.get(p.ticker).closes })))
  const momRows = mom.picks.map((p) => ({
    as_of: p.asOf, ticker: p.ticker, rank: p.rank, score: p.score, close: p.close, vs200: p.vs200, r1m: p.r1m, off_high: p.offHigh, hv60: p.hv60,
    trade: tradeSpec(byTicker.get(p.ticker).bars), move_group: groups.get(p.ticker)?.group ?? p.ticker, peers: groups.get(p.ticker)?.peers ?? [], eligible: mom.eligible,
  }))
  console.log(`\nMomentum: ${mom.scored} scored, ${mom.eligible} above their 200-day, top decile ${momRows.length}:`)
  for (const m of momRows) console.log(`  ${String(m.rank).padStart(2)}. ${m.ticker.padEnd(6)} 12-1 ${pct(m.score)}  vs200 ${pct(m.vs200)}  ${m.trade ? `call $${m.trade.strike} ${m.trade.expiry} ≈$${Math.round(m.trade.cost * 100)}` : ''}${m.peers.length ? `  moves with ${m.peers.join(', ')}` : ''}`)
  if (MODE === 'dry-run') return

  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  const db = createClient(url, key, { auth: { persistSession: false } })

  // Yesterday's top 10s, for "entered the top 10".
  let prevRows = []
  try {
    const { data } = await db.from('confluence_ranks').select('side, ticker, rank').eq('side', 'buy').not('rank', 'is', null)
    prevRows = data ?? []
  } catch (e) {
    // Table may not exist yet or be inaccessible; continue without alert check
  }
  const prevTop = new Set((prevRows ?? []).map((r) => `${r.side}:${r.ticker}`))

  // onConflict must name the table's primary key (side, ticker) — PostgREST
  // rejects any other column set and the client reports it only via `error`.
  const batchSize = 1000
  const now = new Date().toISOString()
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map((r) => ({ ...r, updated_at: now }))
    const { error } = await db.from('confluence_ranks').upsert(batch, { onConflict: 'side,ticker' })
    if (error) throw new Error(`confluence_ranks batch ${i / batchSize + 1}: ${error.message}`)
  }

  // Same for pool
  if (pool.length > 0) {
    for (let i = 0; i < pool.length; i += batchSize) {
      const batch = pool.slice(i, i + batchSize)
      const { error } = await db.from('confluence_pool').upsert(batch, { onConflict: 'side,combo' })
      if (error) throw new Error(`confluence_pool batch ${i / batchSize + 1}: ${error.message}`)
    }
  }
  console.log(`\nWrote ${rows.length} rank rows and ${pool.length} pool rows.`)
  if (momRows.length) {
    const { error } = await db.from('momentum_picks').upsert(momRows.map((m) => ({ ...m, updated_at: now })), { onConflict: 'as_of,ticker' })
    if (error) throw new Error(`momentum_picks: ${error.message}`)
    console.log(`Wrote ${momRows.length} momentum picks for ${momRows[0].as_of}.`)
  }
  // The leader record (owner, 2026-10-19): every stint on the Leaders list
  // in the past year (plus any still open), rebuilt each night.
  {
    const stintRows = results.flatMap((r) => (r.stints ?? []).map((x) => ({ as_of: asOf, ticker: r.ticker, theme: r.theme?.name ?? null, ...x })))
    let bad = null
    for (let i = 0; i < stintRows.length && !bad; i += batchSize) {
      const { error } = await db.from('leader_stints').upsert(stintRows.slice(i, i + batchSize), { onConflict: 'as_of,ticker,joined_on' })
      if (error) bad = error.message
    }
    if (bad) console.error(`leader_stints: ${bad}`)
    else {
      await db.from('leader_stints').delete().lt('as_of', asOf)
      const open = stintRows.filter((x) => x.open).length
      console.log(`Leader record: ${stintRows.length} stints (${open} open).`)
    }
  }
  // The market on one screen (owner, 2026-10-19): S&P trend, breadth, the
  // leaders and their groups, VIX → market_pulse.
  let vix = []
  try { vix = await dailyBars('^VIX') } catch (e) { console.log(`VIX unavailable (${e.message})`) }
  const { data: prevPulse } = await db.from('market_pulse').select('as_of, spy_above').lt('as_of', asOf).order('as_of', { ascending: false }).limit(1).maybeSingle()
  const pulse = marketPulse({
    asOf, spy: spy ?? [], vix,
    stocks: results.map((r) => ({ ticker: r.ticker, vs200: r.leader?.traits?.vs200 ?? null })),
    leaders: rows.filter((r) => r.side === 'buy' && r.rank != null).sort((a, b) => a.rank - b.rank).map((r) => ({ ticker: r.ticker, theme: r.leader_traits?.theme?.name ?? null })),
  })
  {
    const { error } = await db.from('market_pulse').upsert({ ...pulse, updated_at: now }, { onConflict: 'as_of' })
    if (error) console.error(`market_pulse: ${error.message}`)
    else console.log(`Market: S&P ${pulse.spy_above ? 'above' : 'below'} its 200-day (${pct(pulse.spy_vs200)}), breadth ${pct(pulse.breadth)}, ${pulse.leaders} leaders, VIX ${pulse.vix ?? '—'}.`)
  }
  if (MODE !== 'full') return

  try { await forwardRecord(db, { asOf, momRows, rows, byTicker }) } catch (e) { console.error(`Forward record failed: ${e.message}`) }

  await sendAlerts(db, { asOf, rows, prevTop, pulse, prevPulse })
}

// Alerts (owner, 2026-10-16; widened 2026-10-19 to the market and its risks),
// for users with entry alerts on — facts, never instructions:
//   confluence_top_buy  new leader: a favorite or holding is ranked today
//   leader_lost         a tracked ticker dropped off the Leaders list
//   market_trend        the S&P 500 crossed its 200-day (everyone)
//   econ_tomorrow       a major release or Fed decision on the next weekday (everyone)
//   earnings_soon       a tracked ticker reports within 3 days
// One row per (user, kind, ticker, date) — re-runs are no-ops.
const nextWeekday = (d) => { const t = new Date(`${d}T12:00:00Z`); do t.setUTCDate(t.getUTCDate() + 1); while ([0, 6].includes(t.getUTCDay())); return t.toISOString().slice(0, 10) }
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }

async function sendAlerts(db, { asOf, rows, prevTop, pulse, prevPulse }) {
  const { data: users } = await db.from('profiles').select('id').eq('entry_alerts', true)
  const ids = (users ?? []).map((u) => u.id)
  if (!ids.length) { console.log('No users with alerts on.'); return }
  const [{ data: wl }, { data: pos }] = await Promise.all([
    db.from('watchlist').select('user_id, ticker').in('user_id', ids),
    db.from('leaps_positions').select('user_id, ticker').in('user_id', ids).is('closed_at', null).not('ticker', 'is', null),
  ])
  const follows = new Map()
  const add = (u, t) => { const s = String(t ?? '').toUpperCase(); if (!follows.has(u)) follows.set(u, new Set()); follows.get(u).add(s) }
  for (const r of wl ?? []) add(r.user_id, r.ticker)
  for (const r of pos ?? []) add(r.user_id, r.ticker)

  const ranked = rows.filter((r) => r.side === 'buy' && r.rank != null)
  const rankedNow = new Set(ranked.map((r) => r.ticker))
  const entered = ranked.filter((r) => !prevTop.has(`buy:${r.ticker}`))
  const lost = [...prevTop].map((k) => k.split(':')[1]).filter((t) => !rankedNow.has(t))
  const app = process.env.APP_URL || 'https://cashmoves.io'
  const chart = (t) => `${app}/charts/entry/${encodeURIComponent(t)}`

  const items = [] // { user, kind, ticker, date, message, url }
  for (const id of ids) {
    const mine = follows.get(id) ?? new Set()
    for (const r of entered) if (mine.has(r.ticker)) items.push({ user: id, kind: 'confluence_top_buy', ticker: r.ticker, date: asOf, url: chart(r.ticker),
      message: `New leader: ${r.ticker} (#${r.rank}) — ${pct(r.leader_traits?.mom12)} past year, ${pct(r.leader_traits?.vs200)} above a rising 200-day.` })
    for (const t of lost) if (mine.has(t)) items.push({ user: id, kind: 'leader_lost', ticker: t, date: asOf, url: chart(t),
      message: `${t} dropped off the Leaders list — it no longer meets every leader rule.` })
  }
  // The market's trend turned (S&P vs its 200-day).
  if (prevPulse && pulse.spy_above != null && prevPulse.spy_above != null && prevPulse.spy_above !== pulse.spy_above) {
    const message = pulse.spy_above
      ? `The S&P 500 closed back above its 200-day average (${pct(pulse.spy_vs200)}). New leaders can qualify again.`
      : `The S&P 500 closed below its 200-day average (${pct(pulse.spy_vs200)}). No stock qualifies as a leader while it stays below.`
    for (const id of ids) items.push({ user: id, kind: 'market_trend', ticker: 'SPY', date: asOf, url: `${app}/charts`, message })
  }
  // Major releases and Fed decisions on the next weekday.
  const tomorrow = nextWeekday(asOf)
  const { data: ev } = await db.from('econ_events').select('kind, event_date, event_time, title').eq('event_date', tomorrow)
  for (const e of ev ?? []) {
    const message = `Tomorrow${e.event_time ? ` at ${e.event_time} ET` : ''}: ${e.title}. Markets often move most around these releases.`
    for (const id of ids) items.push({ user: id, kind: 'econ_tomorrow', ticker: e.kind.toUpperCase(), date: e.event_date, url: `${app}/charts`, message })
  }
  // Earnings within 3 days on a tracked ticker.
  const followed = [...new Set([...follows.values()].flatMap((s) => [...s]))]
  if (followed.length) {
    const { data: er } = await db.from('earnings_calendar').select('ticker, earnings_date, announcement_time')
      .in('ticker', followed).gt('earnings_date', asOf).lte('earnings_date', addDays(asOf, 3))
    for (const e of er ?? []) {
      const when = e.announcement_time === 'BMO' ? ' before the open' : e.announcement_time === 'AMC' ? ' after the close' : ''
      for (const id of ids) if (follows.get(id)?.has(e.ticker)) items.push({ user: id, kind: 'earnings_soon', ticker: e.ticker, date: e.earnings_date, url: chart(e.ticker),
        message: `${e.ticker} reports earnings ${e.earnings_date}${when}. The price can gap either way on the results.` })
    }
  }

  let written = 0
  const mail = new Map()
  for (const it of items) {
    const { data, error } = await db.from('alerts').upsert({ user_id: it.user, alert_type: it.kind, ticker: it.ticker, event_date: it.date, message: it.message, sent_via: 'email' },
      { onConflict: 'user_id,alert_type,ticker,event_date', ignoreDuplicates: true }).select('id')
    if (error) { console.warn(`alert ${it.kind} insert failed`, error.message); continue }
    if (!data?.length) continue
    written++
    if (!mail.has(it.user)) mail.set(it.user, [])
    mail.get(it.user).push({ message: it.message, url: it.url })
  }
  console.log(`Alerts: ${entered.length} new leaders, ${lost.length} dropped, ${ev?.length ?? 0} releases tomorrow; ${written} written for ${mail.size} user(s).`)
  await sendEmails(db, mail)
}

// Resend email — a placeholder until the account and sender are set up:
// with no RESEND_API_KEY it logs and skips (the bell still has the alert).
// The forward record (owner, 2026-10-07): log every setup the night it
// first appears — momentum picks and BUY SETUP rows — with the call it
// priced and the plan it is graded by (SWING_PLAN), one open log per
// ticker and kind at a time; seal the day with a root hash; then walk every
// open log forward on today's bars. setup_log / setup_log_days refuse
// updates and deletes in the database; setup_outcomes is the grading.
const DIP_SWING = Object.freeze({ dip: 0.03, target: SWING_EXIT.target, holdDays: 15, label: 'Dip swing: 1M ATM call, all out at +40% on the call, else after 3 weeks' })

async function forwardRecord(db, { asOf, momRows, rows, byTicker }) {
  const { data: logs, error: e1 } = await db.from('setup_log').select('id, logged_on, kind, ticker, strike, expiry, cost, target, hold_days')
  if (e1) throw new Error(`setup_log read: ${e1.message}`)
  const { data: outs, error: e2 } = await db.from('setup_outcomes').select('log_id, status')
  if (e2) throw new Error(`setup_outcomes read: ${e2.message}`)
  const closed = new Set((outs ?? []).filter((o) => o.status !== 'open').map((o) => o.log_id))
  const openKey = new Set((logs ?? []).filter((l) => !closed.has(l.id)).map((l) => `${l.kind}:${l.ticker}`))
  const candidates = [
    ...momRows.filter((m) => m.trade).map((m) => ({ kind: 'momentum', ticker: m.ticker, rank: m.rank, close: m.close, trade: m.trade, payload: { score: m.score, vs200: m.vs200, peers: m.peers } })),
    ...rows.filter((r) => r.side === 'buy' && r.verdict === 'enter' && r.trade).map((r) => ({ kind: 'leader', ticker: r.ticker, rank: r.rank, close: r.close, trade: r.trade, payload: { combo: r.combo, score: r.score, momentum: r.momentum, stop: r.stop_price, leader: r.leader_traits } })),
    // The dip swing (owner, 2026-10-16: "Ok" to paper-tracking it — the swing
    // test's lead, never shown as a suggestion): a leader closing ≥ 3% under
    // its 20-day high → the 1M at-the-money call, all out at +40% on the
    // call or after 3 weeks (15 trading days).
    ...rows.filter((r) => r.side === 'buy' && r.verdict === 'enter' && r.trade && (r.leader_traits?.off20 ?? 0) >= DIP_SWING.dip).map((r) => {
      const t = playContract({ S: r.close, vol: r.trade.vol, asOf, play: PLAYS[0] })
      return t && { kind: 'swing_dip', ticker: r.ticker, rank: r.rank, close: r.close, trade: t, plan: DIP_SWING, payload: { off20: r.leader_traits.off20, leader: r.leader_traits } }
    }).filter(Boolean),
  ]
  const fresh = candidates.filter((c) => !openKey.has(`${c.kind}:${c.ticker}`)).map((c) => {
    const plan = c.plan ?? SWING_PLAN
    return {
      logged_on: asOf, kind: c.kind, ticker: c.ticker, rank: c.rank ?? null, close: c.close,
      strike: c.trade.strike, expiry: c.trade.expiry, cost: c.trade.cost, target: plan.target, hold_days: plan.holdDays,
      payload: { ...c.payload, delta: c.trade.delta, vol: c.trade.vol, plan: plan.label },
    }
  })
  if (fresh.length) {
    const { error } = await db.from('setup_log').upsert(fresh, { onConflict: 'logged_on,kind,ticker', ignoreDuplicates: true })
    if (error) throw new Error(`setup_log insert: ${error.message}`)
  }
  // Seal the day: SHA-256 over the day's row hashes, ordered by kind, ticker.
  const { data: day } = await db.from('setup_log').select('kind, ticker, row_hash').eq('logged_on', asOf).order('kind').order('ticker')
  if (day?.length) {
    const root = createHash('sha256').update(day.map((d) => d.row_hash).join('\n')).digest('hex')
    const { error } = await db.from('setup_log_days').upsert({ logged_on: asOf, n: day.length, root_hash: root }, { onConflict: 'logged_on', ignoreDuplicates: true })
    if (error) console.error(`setup_log_days: ${error.message}`)
  }
  // Grade every open log on today's bars.
  const { data: all } = await db.from('setup_log').select('id, logged_on, kind, ticker, strike, expiry, cost, target, hold_days')
  const updates = []
  for (const l of all ?? []) {
    if (closed.has(l.id)) continue
    const r = byTicker.get(l.ticker)
    if (!r) continue
    const o = forwardOutcome(r.bars, l)
    if (o.status === 'unknown') continue
    if (o.days === 0 && o.status === 'open') { updates.push({ log_id: l.id, status: 'open', last_date: l.logged_on, stock_ret: 0, call_ret: 0, peak_call_ret: 0, days: 0, closed_on: null, updated_at: new Date().toISOString() }); continue }
    updates.push({ log_id: l.id, status: o.status, last_date: o.last_date, stock_ret: o.stock_ret, call_ret: o.call_ret, peak_call_ret: o.peak_call_ret, days: o.days, closed_on: o.closed_on ?? null, updated_at: new Date().toISOString() })
  }
  for (let i = 0; i < updates.length; i += 500) {
    const { error } = await db.from('setup_outcomes').upsert(updates.slice(i, i + 500), { onConflict: 'log_id' })
    if (error) throw new Error(`setup_outcomes: ${error.message}`)
  }
  console.log(`Forward record: logged ${fresh.length} new setups (${fresh.filter((f) => f.kind === 'momentum').length} momentum, ${fresh.filter((f) => f.kind === 'leader').length} leader); graded ${updates.length}.`)
}

async function sendEmails(db, mail) {
  const key = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM || 'Cash Moves <alerts@cashmoves.io>'
  if (!key) { console.log(`Resend not configured — ${mail.size} email(s) skipped (placeholder).`); return }
  for (const [id, items] of mail) {
    const { data } = await db.auth.admin.getUserById(id)
    const to = data?.user?.email
    if (!to) continue
    const html = `<p>Today on Cash Moves:</p><ul>${items.map((x) => `<li>${x.message} <a href="${x.url}">Open</a></li>`).join('')}</ul><p style="color:#888">General information, the same for every subscriber — not personalized investment advice.</p>`
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: `Cash Moves: ${items.length} alert${items.length === 1 ? '' : 's'}`, html }),
    })
    if (!resp.ok) console.warn('resend failed', resp.status)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
