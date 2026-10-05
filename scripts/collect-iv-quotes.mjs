// Nightly IV + LEAPS quote collector (pre-registered test,
// docs/signal-engine/preregistration.md): for every ticker in the universe
// (+ SPY), from Yahoo's option chain with the session in marketData.mjs:
//   iv_history   the 30-day ATM implied vol (call + put at the strike nearest
//                spot, expiry nearest 30 days), source 'yahoo'
//   leaps_quotes the ~0.75-delta call on the expiry nearest 2 years (≥ 540
//                days): bid / ask / mid / IV / delta / OI / volume
// so the IV-proxy premium and the slippage tiers calibrate on the app's own
// quotes instead of staying guesses. Best effort: a ticker that fails is
// logged and skipped. Modes: --mode write | dry-run. Env: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY (write), TICKERS (subset), CONCURRENCY.

import { CHART_TICKERS } from '../src/lib/chartTickers.js'
import { normCdf } from '../src/utils/replay.js'
import { yahooJson, mapLimit } from './lib/marketData.mjs'

const args = process.argv.slice(2)
const MODE = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'dry-run'
const CONCURRENCY = Number(process.env.CONCURRENCY) || 3
const RATE = 0.04
const universe = [...new Set(['SPY', ...(process.env.TICKERS ? process.env.TICKERS.split(',') : CHART_TICKERS.map((t) => t.symbol))])]
  .map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s))

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
const dayOf = (unix) => new Date(unix * 1000).toISOString().slice(0, 10)
const dteOf = (unix) => Math.round((unix * 1000 - Date.now()) / 86400000)

function callDelta(S, K, T, iv) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return null
  const d1 = (Math.log(S / K) + (RATE + iv * iv / 2) * T) / (iv * Math.sqrt(T))
  return normCdf(d1)
}

async function chain(symbol, date) {
  const { body, error } = await yahooJson(`/v7/finance/options/${encodeURIComponent(symbol)}${date ? `?date=${date}` : ''}`)
  if (error) throw new Error(error)
  const r = body?.optionChain?.result?.[0]
  if (!r) throw new Error('empty chain')
  return r
}

async function collect(ticker) {
  const symbol = ticker.replace(/\./g, '-')
  const first = await chain(symbol)
  const spot = Number(first.quote?.regularMarketPrice)
  const exps = (first.expirationDates ?? []).filter((x) => dteOf(x) > 0)
  if (!(spot > 0) || !exps.length) throw new Error('no spot or expirations')
  const exp30 = exps.reduce((a, b) => (Math.abs(dteOf(b) - 30) < Math.abs(dteOf(a) - 30) ? b : a))
  const far = exps.filter((x) => dteOf(x) >= 540)
  const exp2y = far.length ? far.reduce((a, b) => (Math.abs(dteOf(b) - 730) < Math.abs(dteOf(a) - 730) ? b : a)) : null
  const get = async (exp) => (first.options?.[0]?.expirationDate === exp ? first.options[0] : (await chain(symbol, exp)).options?.[0])
  // 30-day ATM IV.
  const o30 = await get(exp30)
  const near = (list) => (list ?? []).filter((c) => c.impliedVolatility > 0.02 && c.impliedVolatility < 3).reduce((a, c) => (!a || Math.abs(c.strike - spot) < Math.abs(a.strike - spot) ? c : a), null)
  const c30 = near(o30?.calls), p30 = near(o30?.puts)
  const ivs = [c30, p30].filter(Boolean).map((c) => c.impliedVolatility)
  const iv30 = ivs.length ? ivs.reduce((s, x) => s + x, 0) / ivs.length : null
  // ~0.75-delta call ~2 years out.
  let quote = null
  if (exp2y) {
    const o2 = await get(exp2y)
    const T = dteOf(exp2y) / 365
    let best = null
    for (const c of o2?.calls ?? []) {
      if (!(c.impliedVolatility > 0.02 && c.impliedVolatility < 3)) continue
      const d = callDelta(spot, c.strike, T, c.impliedVolatility)
      if (d == null) continue
      if (!best || Math.abs(d - 0.75) < Math.abs(best.delta - 0.75)) best = { c, delta: d }
    }
    if (best) {
      const { c, delta } = best
      const bid = Number(c.bid) || null, ask = Number(c.ask) || null
      quote = {
        ticker, quote_date: today, spot, expiry: dayOf(exp2y), strike: c.strike, bid, ask, mid: bid != null && ask != null ? (bid + ask) / 2 : (Number(c.lastPrice) || null),
        iv: c.impliedVolatility, delta: Math.round(delta * 1e4) / 1e4, open_interest: c.openInterest ?? null, volume: c.volume ?? null, dte: dteOf(exp2y), source: 'yahoo',
      }
    }
  }
  return { iv: iv30 ? { ticker, sample_date: today, iv_30d: iv30, source: 'yahoo' } : null, quote }
}

async function main() {
  const t0 = Date.now()
  const ivRows = [], quotes = [], failed = []
  let done = 0
  await mapLimit(universe, CONCURRENCY, async (ticker) => {
    try { const r = await collect(ticker); if (r.iv) ivRows.push(r.iv); if (r.quote) quotes.push(r.quote) } catch (e) { failed.push(`${ticker}: ${e.message}`) } finally {
      done++
      if (done % 50 === 0) console.log(`  ${done}/${universe.length} · ${failed.length} failed · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      if (done === 30 && failed.length >= 24) { console.error(`Yahoo is failing (${failed.slice(0, 3).join('; ')}) — aborting.`); process.exit(1) }
    }
  }, 250)
  console.log(`Collected ${ivRows.length} IV samples and ${quotes.length} LEAPS quotes for ${universe.length} tickers in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${failed.length} failed.`)
  if (failed.length) console.log('Failed (first 10):', failed.slice(0, 10).join(' | '))
  for (const q of quotes.slice(0, 5)) console.log(`  ${q.ticker} ${q.expiry} $${q.strike} Δ${q.delta} bid ${q.bid} ask ${q.ask} iv ${(q.iv * 100).toFixed(0)}% · spread ${q.bid && q.ask ? ((q.ask - q.bid) / q.mid * 100).toFixed(1) + '% of mid' : '—'}`)
  if (MODE !== 'write') return
  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  for (let i = 0; i < ivRows.length; i += 500) {
    const { error } = await db.from('iv_history').upsert(ivRows.slice(i, i + 500), { onConflict: 'ticker,sample_date' })
    if (error) throw new Error(`iv_history upsert: ${error.message}`)
  }
  for (let i = 0; i < quotes.length; i += 500) {
    const { error } = await db.from('leaps_quotes').upsert(quotes.slice(i, i + 500), { onConflict: 'ticker,quote_date' })
    if (error) throw new Error(`leaps_quotes upsert: ${error.message}`)
  }
  console.log(`Wrote ${ivRows.length} iv_history and ${quotes.length} leaps_quotes rows.`)
}

main().catch((e) => { console.error(e); process.exit(1) })
