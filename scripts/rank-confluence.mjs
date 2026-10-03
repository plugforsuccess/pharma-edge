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
//           combination (own record shrunk toward the pool), and the rank —
//           only setups whose history shows an edge:
//             buy   score ≥ 2, the 200-day rising, blended 6M avg > 0;
//                   best 6M first
//             sell  score ≥ 2, blended 3M avg < 0 (the stock fell after,
//                   on average — exits are a shorter call); most negative
//                   3M first
//           ties: higher score, more buy-zone conditions (buy), fresher
//           signal → confluence_ranks
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
import { confluenceModel, poolStats, blendedEstimate, MIN_SCORE, SIDES } from '../src/utils/confluence.js'

const args = process.argv.slice(2)
const MODE = (args[args.indexOf('--mode') + 1] && args.includes('--mode')) ? args[args.indexOf('--mode') + 1] : 'dry-run'
if (!['full', 'rank-only', 'dry-run'].includes(MODE)) throw new Error(`unknown mode ${MODE}`)
const CONCURRENCY = Number(process.env.CONCURRENCY) || 4
const TOP = 10
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms))

const universe = (process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

// 5y of daily bars from Yahoo, with retries (429 / 5xx back off).
export async function yahooDaily(ticker, fetchImpl = fetch) {
  const symbol = ticker.replace(/\./g, '-')
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=5y&interval=1d&includePrePost=false`
  let last = 'no response'
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const host of HOSTS) {
      try {
        const resp = await fetchImpl(`https://${host}${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
        if (resp.status === 404) throw new Error('not found')
        if (!resp.ok) { last = String(resp.status); continue }
        const body = await resp.json()
        const r = body?.chart?.result?.[0]
        const ts = r?.timestamp ?? []
        const q = r?.indicators?.quote?.[0] ?? {}
        const bars = []
        ts.forEach((s, i) => {
          const c = Number(q.close?.[i])
          if (!Number.isFinite(c) || c <= 0) return
          bars.push({ t: etDay(s * 1000), c, o: Number(q.open?.[i]) || c, h: Number(q.high?.[i]) || c, l: Number(q.low?.[i]) || c, v: Number(q.volume?.[i]) || 0 })
        })
        // Yahoo can repeat today's date as a live bar; keep the last.
        const out = []
        for (const b of bars) { if (out.length && out[out.length - 1].t === b.t) out[out.length - 1] = b; else out.push(b) }
        if (out.length) return out
        last = 'empty'
      } catch (e) {
        if (e.message === 'not found') throw e
        last = e.message
      }
    }
    await sleep(1000 * 2 ** attempt)
  }
  throw new Error(`yahoo ${ticker}: ${last}`)
}

// One ticker → everything the ranking needs (null when too little history).
export function analyze(ticker, bars) {
  if (!bars || bars.length < 300) return null
  const model = entryModel(bars)
  const suite = suiteModel(bars)
  const conf = confluenceModel({ bars, model, suite, horizons: HORIZONS })
  const lastIdx = bars.length - 1
  const lastSignal = (flags) => { for (let i = lastIdx; i >= Math.max(0, lastIdx - 10); i--) if (Object.values(flags).some((f) => f[i])) return bars[i].t; return null }
  const c = model.status.cond
  return {
    ticker, asOf: bars[lastIdx].t, close: bars[lastIdx].c,
    trendUp: model.status.slope200 != null && model.status.slope200 > 0,
    conditionsMet: ['band', 'rising', 'trend', 'rsi', 'iv'].filter((k) => c[k]).length,
    buy: { today: conf.buy.today, setups: conf.buy.setups, lastSignal: lastSignal(conf.buy.flags) },
    sell: { today: conf.sell.today, setups: conf.sell.setups, lastSignal: lastSignal(conf.sell.flags) },
  }
}

const h = (est, label) => est?.horizons.find((x) => x.label === label)?.avg ?? null

// Ranks from analyzed tickers + the pools. Pure (tested by dry runs).
export function rankAll(results, pools) {
  const rows = []
  for (const side of SIDES) {
    const cands = []
    for (const r of results) {
      const est = blendedEstimate({ today: r[side].today, setups: r[side].setups, pool: pools[side], horizons: HORIZONS, side })
      const now = r[side].today.now
      const row = {
        side, ticker: r.ticker, as_of: r.asOf, close: r.close, score: now?.score ?? 0, lit: now?.lit ?? [],
        combo: now?.key || null, conditions_met: side === 'buy' ? r.conditionsMet : null, trend_up: r.trendUp,
        own_n: est?.ownN ?? 0, pool_n: est?.poolN ?? 0, est_at_turn: est?.atTurn ?? null,
        est_3m: h(est, '3M'), est_6m: h(est, '6M'), est_12m: h(est, '12M'),
        est_win_6m: est?.horizons.find((x) => x.label === '6M')?.winRate ?? null,
        last_signal: r[side].lastSignal, rank: null,
      }
      rows.push(row)
      const eligible = row.score >= MIN_SCORE && (side === 'buy'
        ? row.trend_up && row.est_6m != null && row.est_6m > 0
        : row.est_3m != null && row.est_3m < 0)
      if (eligible) cands.push(row)
    }
    cands.sort((a, b) => (side === 'buy' ? b.est_6m - a.est_6m : a.est_3m - b.est_3m)
      || b.score - a.score
      || (side === 'buy' ? (b.conditions_met ?? 0) - (a.conditions_met ?? 0) : 0)
      || String(b.last_signal ?? '').localeCompare(String(a.last_signal ?? '')))
    cands.forEach((row, k) => { row.rank = k + 1 })
  }
  return rows
}

export function poolRows(pools, results, asOf) {
  const out = []
  for (const side of SIDES) {
    for (const p of Object.values(pools[side])) {
      const hz = (label) => p.horizons.find((x) => x.label === label)
      out.push({
        side, combo: p.key, lit: p.lit, score: p.score, n: p.n, graded: p.graded, at_turn: p.atTurn,
        avg_3m: hz('3M')?.avg ?? null, avg_6m: hz('6M')?.avg ?? null, avg_12m: hz('12M')?.avg ?? null,
        win_3m: hz('3M')?.winRate ?? null, win_6m: hz('6M')?.winRate ?? null, win_12m: hz('12M')?.winRate ?? null,
        tickers: results.length, as_of: asOf, updated_at: new Date().toISOString(),
      })
    }
  }
  return out
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const k = next++
      out[k] = await fn(items[k], k)
      await sleep(150)
    }
  }))
  return out
}

const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)

async function main() {
  const t0 = Date.now()
  const failed = []
  const results = (await mapLimit(universe, CONCURRENCY, async (ticker) => {
    try { return analyze(ticker, await yahooDaily(ticker)) } catch (e) { failed.push(`${ticker}: ${e.message}`); return null }
  })).filter(Boolean)
  if (!results.length) throw new Error(`no tickers analyzed (${failed.slice(0, 5).join('; ')})`)
  const asOf = results.map((r) => r.asOf).sort().pop()
  const pools = Object.fromEntries(SIDES.map((side) => [side, poolStats(results.map((r) => r[side].setups), HORIZONS, side)]))
  const rows = rankAll(results, pools)
  const pool = poolRows(pools, results, asOf)
  console.log(`Analyzed ${results.length}/${universe.length} tickers in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${failed.length} failed; as of ${asOf}.`)
  if (failed.length) console.log('Failed (first 10):', failed.slice(0, 10).join(' | '))
  for (const side of SIDES) {
    const top = rows.filter((r) => r.side === side && r.rank != null).sort((a, b) => a.rank - b.rank).slice(0, TOP)
    console.log(`\nTop ${TOP} ${side}:`)
    for (const r of top) console.log(`  ${String(r.rank).padStart(2)}. ${r.ticker.padEnd(6)} ${r.score}/5 ${r.combo.padEnd(28)} 3M ${pct(r.est_3m)} 6M ${pct(r.est_6m)}  at turn ${pct(r.est_at_turn)}  (own ${r.own_n}, pool ${r.pool_n})`)
  }
  if (MODE === 'dry-run') return

  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  const db = createClient(url, key, { auth: { persistSession: false } })

  // Yesterday's top 10s, for "entered the top 10".
  const { data: prevRows } = await db.from('confluence_ranks').select('side, ticker, rank').not('rank', 'is', null).lte('rank', TOP)
  const prevTop = new Set((prevRows ?? []).map((r) => `${r.side}:${r.ticker}`))

  for (let k = 0; k < rows.length; k += 500) {
    const { error } = await db.from('confluence_ranks').upsert(rows.slice(k, k + 500).map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: 'side,ticker' })
    if (error) throw new Error(`confluence_ranks: ${error.message}`)
  }
  for (let k = 0; k < pool.length; k += 500) {
    const { error } = await db.from('confluence_pool').upsert(pool.slice(k, k + 500), { onConflict: 'side,combo' })
    if (error) throw new Error(`confluence_pool: ${error.message}`)
  }
  console.log(`\nWrote ${rows.length} rank rows and ${pool.length} pool rows.`)
  if (MODE !== 'full') return

  // Alerts: new entries into a top 10 among each user's tickers.
  const entered = rows.filter((r) => r.rank != null && r.rank <= TOP && !prevTop.has(`${r.side}:${r.ticker}`))
  if (!entered.length) { console.log('No new top-10 entries.'); return }
  const { data: users } = await db.from('profiles').select('id').eq('entry_alerts', true)
  const ids = (users ?? []).map((u) => u.id)
  if (!ids.length) return
  const [{ data: wl }, { data: pos }] = await Promise.all([
    db.from('watchlist').select('user_id, ticker').in('user_id', ids),
    db.from('leaps_positions').select('user_id, ticker').in('user_id', ids).is('closed_at', null).not('ticker', 'is', null),
  ])
  const follows = new Map()
  const holds = new Map()
  const add = (m, u, t) => { const s = String(t ?? '').toUpperCase(); if (!m.has(u)) m.set(u, new Set()); m.get(u).add(s) }
  for (const r of wl ?? []) add(follows, r.user_id, r.ticker)
  for (const r of pos ?? []) { add(follows, r.user_id, r.ticker); add(holds, r.user_id, r.ticker) }

  const app = process.env.APP_URL || 'https://cashmoves.io'
  let written = 0
  const mail = new Map()
  for (const id of ids) {
    for (const r of entered) {
      const mine = r.side === 'buy' ? follows.get(id)?.has(r.ticker) : holds.get(id)?.has(r.ticker)
      if (!mine) continue
      const kind = r.side === 'buy' ? 'confluence_top_buy' : 'confluence_top_sell'
      const message = r.side === 'buy'
        ? `${r.ticker} is #${r.rank} for lows (buy) — ${r.score} of 5 signals agree; this setup averaged ${pct(r.est_6m)} over 6 months.`
        : `${r.ticker} is #${r.rank} for extended highs (exit) — ${r.score} of 5 sell signals agree; after this setup the stock averaged ${pct(r.est_3m)} over 3 months.`
      const { data, error } = await db.from('alerts').upsert({ user_id: id, alert_type: kind, ticker: r.ticker, event_date: r.as_of, message, sent_via: 'email' },
        { onConflict: 'user_id,alert_type,ticker,event_date', ignoreDuplicates: true }).select('id')
      if (error) { console.warn('alert insert failed', error.message); continue }
      if (!data?.length) continue
      written++
      if (!mail.has(id)) mail.set(id, [])
      mail.get(id).push({ message, url: `${app}/charts/entry/${encodeURIComponent(r.ticker)}` })
    }
  }
  console.log(`Alerts written: ${written} for ${mail.size} user(s).`)
  await sendEmails(db, mail)
}

// Resend email — a placeholder until the account and sender are set up:
// with no RESEND_API_KEY it logs and skips (the bell still has the alert).
async function sendEmails(db, mail) {
  const key = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM || 'Cash Moves <alerts@cashmoves.io>'
  if (!key) { console.log(`Resend not configured — ${mail.size} email(s) skipped (placeholder).`); return }
  for (const [id, items] of mail) {
    const { data } = await db.auth.admin.getUserById(id)
    const to = data?.user?.email
    if (!to) continue
    const html = `<p>New confluence calls on your tickers:</p><ul>${items.map((x) => `<li>${x.message} <a href="${x.url}">Open the chart</a></li>`).join('')}</ul><p style="color:#888">Suggestions, not advice. Stock returns, not option returns.</p>`
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: `Cash Moves: ${items.length} new confluence call${items.length === 1 ? '' : 's'}`, html }),
    })
    if (!resp.ok) console.warn('resend failed', resp.status)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
