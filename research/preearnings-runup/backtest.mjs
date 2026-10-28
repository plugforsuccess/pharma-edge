// Pre-earnings run-up backtest (PREREG.md). Reads normalized option chains
// from disk; never calls a broker. Usage:
//   node research/preearnings-runup/backtest.mjs --events events.json --chains data/chains --bars bars.json [--oos] [--out out]
// Chain files: <chains>/<TICKER>/<YYYY-MM-DD>.json =
//   { avgOptVol20, ivRank?, spot: { "10:00": 101.2, "15:45": …, "15:55": …, "EOD": … },
//     snapshots: { "10:00": [contract…], "15:45": […], "15:55": […], "EOD": […] } }
//   contract = { expiry, strike, type: 'call'|'put', bid, ask, iv, delta?, oi, prevVol }
// Without the 10:00 / 15:45 / 15:55 snapshots a day falls back to "EOD" (PREREG §4).
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RULES, pickExpiry, pickByDelta, liquidityOk, tradeResult, controlLs, grade, metrics, holm, grid, isPrimary, bootstrapMean, weekKey } from './lib.mjs'
import { histogramSvg, equitySvg } from './charts.mjs'

const SECTOR = { NOW: 'Software', CRM: 'Software', ADBE: 'Software', MSFT: 'Software', ORCL: 'Software', SNOW: 'Software', INTU: 'Software', PANW: 'Software', SHOP: 'Software', NVDA: 'Chips', AMD: 'Chips', AVGO: 'Chips', INTC: 'Chips', QCOM: 'Chips', MU: 'Chips', AMZN: 'Internet', GOOGL: 'Internet', META: 'Internet', NFLX: 'Internet', UBER: 'Internet', PYPL: 'Internet', AAPL: 'Hardware', TSLA: 'Autos', COST: 'Retail', WMT: 'Retail', HD: 'Retail', JPM: 'Banks', GS: 'Banks', DIS: 'Media', BA: 'Industrials' }
const vixBucket = (v) => (v == null ? 'unknown' : v < 15 ? '<15' : v < 20 ? '15–20' : v < 30 ? '20–30' : '≥30')

export function loadDay(chains, tk, date, cache = new Map()) {
  const k = `${tk}|${date}`
  if (cache.has(k)) return cache.get(k)
  const f = join(chains, tk, `${date}.json`)
  const v = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
  cache.set(k, v)
  return v
}
const snap = (day, time) => { if (!day) return null; const t = day.snapshots?.[time] ? time : day.snapshots?.EOD ? 'EOD' : null; return t ? { time: t, contracts: day.snapshots[t], spot: day.spot?.[t] ?? day.spot?.EOD } : null }
const same = (a) => (c) => c.expiry === a.expiry && c.strike === a.strike && c.type === a.type

// One trade for one variant on one (pseudo-)event. → { trade } | { skip }
export function runOne(v, ev, ctx) {
  const { sessions, closes, getDay } = ctx
  const L = ev.L, after = ev.after
  const eIdx = v.entry === 'same-day' ? L : L - v.entry
  if (eIdx < 5) return { skip: 'no history' }
  const eTime = v.entry === 'same-day' ? RULES.times.sameDay : RULES.times.entry
  const xIdx = v.exit === 'pre-release' ? L : after
  const xTime = v.exit === 'pre-release' ? RULES.times.exit : RULES.times.heldExit
  const eDay = getDay(ev.tk, sessions[eIdx]), xDay = getDay(ev.tk, sessions[xIdx])
  const es = snap(eDay, eTime), xs = snap(xDay, xTime)
  if (!es || !xs) return { skip: 'no chain data' }
  if (v.entry === 'same-day' && es.time === 'EOD') return { skip: 'same-day needs intraday quotes' }
  if (v.exit === 'pre-release' && v.entry !== 'same-day' && eIdx === xIdx) return { skip: 'entry is the exit' }
  const expiry = pickExpiry(es.contracts.map((c) => c.expiry), sessions[after])
  if (!expiry) return { skip: 'no expiry after the report' }
  let types = v.direction === 'straddle' ? ['call', 'put'] : v.direction === 'trend' ? [closes[eIdx] > closes[eIdx - 5] ? 'call' : 'put'] : [v.direction]
  const legs = []
  for (const type of types) {
    const c = pickByDelta(es.contracts, { type, target: v.delta, expiry, spot: es.spot, asOf: sessions[eIdx] })
    const why = liquidityOk(c, eDay.avgOptVol20)
    if (why) return { skip: why }
    const out = xs.contracts.find(same(c))
    if (!out || !(out.ask >= out.bid && out.bid >= 0)) return { skip: 'no exit quote' }
    legs.push({ entry: c, exit: out })
  }
  const r = tradeResult(legs), w = tradeResult(legs, { mode: 'worst' })
  if (r.skip) return { skip: r.skip }
  const ivIn = legs.reduce((s, l) => s + (l.entry.iv ?? 0), 0) / legs.length, ivOut = legs.reduce((s, l) => s + (l.exit.iv ?? 0), 0) / legs.length
  return { trade: { tk: ev.tk, date: sessions[L], timing: ev.timing, ret: r.ret, pnl: r.pnl, worstRet: w.ret, worstPnl: w.pnl, ivIn, ivOut, stockMove: xs.spot && es.spot ? xs.spot / es.spot - 1 : null, ivRank: eDay.ivRank ?? null, quoteTimes: `${es.time}→${xs.time}`, vix: ctx.vix?.get(sessions[eIdx]) ?? null } }
}

export function run({ events, sessions, closesBy, getDay, oos = false, vix = null }) {
  const inSet = (d) => (oos ? d >= RULES.oosFrom : d < RULES.oosFrom)
  const evs = events.filter((e) => e.status === 'confirmed' && RULES.universe.includes(e.tk))
  const byTk = new Map()
  for (const e of evs) { const L = sessions.indexOf(e.L); if (L < 0) continue; (byTk.get(e.tk) ?? byTk.set(e.tk, []).get(e.tk)).push({ ...e, L, after: L + 1 }) }
  const variants = grid()
  const results = {}
  for (const v of variants) {
    const trades = [], controls = [], skips = {}
    for (const [tk, list] of byTk) {
      const ctx = { sessions, closes: closesBy.get(tk) ?? [], getDay, vix }
      const realLs = list.map((e) => e.L)
      for (const ev of list) {
        if (!inSet(sessions[ev.L])) continue
        if (v.amcOnly && ev.timing !== 'AMC') continue
        const got = runOne(v, ev, ctx)
        if (got.trade) trades.push(got.trade); else skips[got.skip] = (skips[got.skip] ?? 0) + 1
        for (const pl of controlLs(sessions, realLs, ev.L, { salt: tk.charCodeAt(0) })) {
          if (!inSet(sessions[pl])) continue
          const c = runOne(v, { tk, timing: ev.timing, L: pl, after: pl + 1 }, ctx)
          if (c.trade) controls.push(c.trade)
        }
      }
    }
    const g = grade(trades, controls)
    const worst = metrics(trades.map((t) => ({ ...t, ret: t.worstRet, pnl: t.worstPnl })))
    const split = (keyFn) => { const m = new Map(); for (const t of trades) { const k = keyFn(t); (m.get(k) ?? m.set(k, []).get(k)).push(t) } return Object.fromEntries([...m].sort().map(([k, ts]) => [k, metrics(ts)])) }
    const tercile = (t) => (t.ivRank == null ? 'unknown' : t.ivRank < 33.3 ? 'low' : t.ivRank < 66.7 ? 'mid' : 'high')
    const ivMove = bootstrapMean(trades.filter((t) => t.ivIn > 0).map((t) => ({ cluster: weekKey(t.date), x: t.ivOut - t.ivIn })), { reps: 2000 })
    results[v.key] = { ...v, primary: isPrimary(v), ...g, worst, skips, controls: controls.length, splits: { ivRank: split(tercile), sector: split((t) => SECTOR[t.tk] ?? 'Other'), vix: split((t) => vixBucket(t.vix)), year: split((t) => t.date.slice(0, 4)), timing: split((t) => t.timing) }, drivers: { ivChange: ivMove.mean, stockMoveMedian: metrics(trades.map((t) => ({ ...t, ret: t.stockMove ?? 0 }))).median }, trades }
  }
  const pre = Object.values(results).filter((r) => r.exit === 'pre-release' && !r.primary && r.metrics.n >= RULES.pass.minTrades)
  const survivors = holm(Object.fromEntries(pre.map((r) => [r.key, r.boot.p])))
  for (const r of Object.values(results)) r.holm = r.primary ? 'primary' : survivors.has(r.key)
  const primary = Object.values(results).find((r) => r.primary)
  const passers = Object.values(results).filter((r) => r.exit === 'pre-release' && r.verdict === 'pass' && (r.primary || r.holm === true))
  const graded = Object.values(results).filter((r) => r.exit === 'pre-release' && (r.primary || r.holm === true))
  const verdict = !oos ? 'in-sample (not graded)' : passers.length ? 'edge' : graded.every((r) => r.metrics.n < RULES.pass.minTrades) && primary.metrics.n < RULES.pass.minTrades ? 'inconclusive' : 'no edge'
  return { rules: RULES.version, period: oos ? `out-of-sample, L ≥ ${RULES.oosFrom}` : `in-sample, L < ${RULES.oosFrom}`, verdict, events: evs.length, results }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
  const oos = process.argv.includes('--oos')
  const chains = arg('--chains', 'data/chains'), out = arg('--out', 'out')
  if (!existsSync(chains) || !readdirSync(chains).length) { console.log(`No option chain data at ${chains}. The graded test cannot run until historical chains exist (REPORT.md lists the gap).`); process.exit(2) }
  const events = JSON.parse(readFileSync(arg('--events', 'events.json'), 'utf8')).events
  const bars = JSON.parse(readFileSync(arg('--bars', 'bars.json'), 'utf8'))
  const sessions = bars.sessions, closesBy = new Map(Object.entries(bars.closes))
  const vix = bars.vix ? new Map(sessions.map((d, i) => [d, bars.vix[i]])) : null
  const cache = new Map()
  const res = run({ events, sessions, closesBy, getDay: (tk, d) => loadDay(chains, tk, d, cache), oos, vix })
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, oos ? 'results-oos.json' : 'results-is.json'), JSON.stringify(res, null, 1))
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)
  console.log(`${res.period} · verdict: ${res.verdict} · confirmed events ${res.events}`)
  for (const r of Object.values(res.results)) console.log(`  ${r.key.padEnd(34)} n ${String(r.metrics.n).padStart(4)}  exp ${pct(r.metrics.expectancy).padStart(7)} [${pct(r.boot.lo)}, ${pct(r.boot.hi)}]  med ${pct(r.metrics.median).padStart(7)}  win ${pct(r.metrics.win).padStart(6)}  ctrl ${pct(r.controlMean).padStart(7)}  worst-fill ${pct(r.worst.expectancy).padStart(7)}  ${r.primary ? 'PRIMARY ' : ''}${oos ? r.verdict : ''}`)
  const best = Object.values(res.results).filter((r) => r.exit === 'pre-release').sort((a, b) => (b.metrics.expectancy ?? -9) - (a.metrics.expectancy ?? -9))[0]
  for (const [name, r] of [['primary', Object.values(res.results).find((x) => x.primary)], ['best', best]]) {
    if (!r?.trades.length) continue
    writeFileSync(join(out, `${name}-histogram${oos ? '-oos' : ''}.svg`), histogramSvg(r.trades.map((t) => t.ret), `${r.key} · return per trade`))
    writeFileSync(join(out, `${name}-equity${oos ? '-oos' : ''}.svg`), equitySvg(r.trades, `${r.key} · $1,000 per trade`))
  }
}
