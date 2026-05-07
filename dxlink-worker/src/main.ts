// Cash Moves — DXLink quote worker.
//
// Long-running Deno process that:
//   1. Logs into Tastytrade with username/password
//   2. Exchanges the session token for a DXLink streamer token
//   3. Pulls the option chain for each tracked ticker (front 2 expiries,
//      strikes within ATM ± window)
//   4. Opens a single DXLink WebSocket and subscribes to:
//        Quote(equity)         — spot bid/ask
//        Quote(option)         — bid/ask per strike
//        Greeks(option)        — gamma, IV, delta, theta, vega
//        Summary(option)       — open interest + day volume
//   5. Upserts every event into public.dxlink_quotes (debounced 750ms)
//
// The /markets compute-gex edge function reads from dxlink_quotes
// instead of the option chain provider directly. That way GEX latency
// = one DB query (~50ms) instead of REST round-trips, and the data is
// real-time instead of 15-minute delayed.
//
// Deploy: see ../README.md. Run locally with:
//   deno task dev

import {
  equityStreamerSymbol,
  fetchNestedChain,
  getStreamerAuth,
  login,
  type ChainExpiration,
  type SessionAuth,
  type StreamerAuth,
} from './tastytrade.ts'
import { fetchYahooChain } from './yahoo.ts'
import { DxLinkClient, type SubSpec } from './dxlink.ts'
import { applyEvent, registerSymbol, seedShadowFromDb, startFlushLoop } from './store.ts'
import {
  applyTrade,
  registerOption as registerOptionForFlow,
  startFlowFlushLoop,
  startFlowPruneLoop,
} from './flow.ts'
import {
  EXPIRATIONS_PER_TICKER,
  STRIKE_WINDOW_PCT,
  TRACKED_TICKERS,
} from './tickers.ts'

interface OptionMeta {
  streamer: string
  occ: string
  ticker: string
  expirationDate: string
  strike: number
  optionType: 'C' | 'P'
}

// Yahoo's free /v8/finance/chart endpoint is open (no auth) and
// reliable enough for the one-time spot estimate we need at startup.
// We use it only to choose the strike window — the real spot price
// flows in from DXLink Quote events seconds later.
async function rougheSpot(ticker: string): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'cash-moves-dxlink-worker/0.1' } },
    )
    if (!resp.ok) return null
    const body = await resp.json()
    const meta = body?.chart?.result?.[0]?.meta
    const v = Number(meta?.regularMarketPrice ?? meta?.previousClose)
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

function pickExpirations(chain: ChainExpiration[], n: number): ChainExpiration[] {
  // Include today's 0DTE expiration. The previous strict `> 0` filter
  // skipped today's column entirely, leaving the matrix's front
  // expiration blank — exactly the period when the most flow concentrates
  // and the gamma profile matters most. Today's options are still
  // tradable until 16:00 ET; only filter strictly-past-dated entries.
  return chain
    .filter((e) => e.daysToExpiration >= 0)
    .sort((a, b) => a.daysToExpiration - b.daysToExpiration)
    .slice(0, n)
}

async function buildSubscriptionPlan(
  session: SessionAuth,
): Promise<{ equity: string[]; options: OptionMeta[] }> {
  const equity: string[] = []
  const options: OptionMeta[] = []

  for (const ticker of TRACKED_TICKERS) {
    try {
      const [chain, spot] = await Promise.all([
        fetchNestedChain(session, ticker),
        rougheSpot(ticker),
      ])
      if (chain.length === 0) {
        console.warn(`[plan] empty chain for ${ticker}, skipping`)
        continue
      }
      equity.push(equityStreamerSymbol(ticker))

      const lo = spot ? spot * (1 - STRIKE_WINDOW_PCT) : 0
      const hi = spot ? spot * (1 + STRIKE_WINDOW_PCT) : Infinity
      for (const exp of pickExpirations(chain, EXPIRATIONS_PER_TICKER)) {
        for (const s of exp.strikes) {
          if (s.strike < lo || s.strike > hi) continue
          options.push({
            streamer: s.callStreamer,
            occ: s.callOcc,
            ticker,
            expirationDate: exp.expirationDate,
            strike: s.strike,
            optionType: 'C',
          })
          options.push({
            streamer: s.putStreamer,
            occ: s.putOcc,
            ticker,
            expirationDate: exp.expirationDate,
            strike: s.strike,
            optionType: 'P',
          })
        }
      }
      console.log(
        `[plan] ${ticker}: spot=${spot} ` +
          `expirations=${pickExpirations(chain, EXPIRATIONS_PER_TICKER).length} ` +
          `options=${options.filter((o) => o.ticker === ticker).length}`,
      )
    } catch (e) {
      console.error(`[plan] ${ticker} failed:`, e)
    }
  }

  return { equity, options }
}

async function main() {
  console.log('[main] booting Cash Moves DXLink worker')
  startFlushLoop()
  startFlowFlushLoop()
  startFlowPruneLoop()

  let session: SessionAuth = await login()
  console.log('[main] tastytrade session OK')
  let streamer: StreamerAuth = await getStreamerAuth(session)
  console.log(`[main] streamer auth OK; url=${streamer.url}`)

  const { equity, options } = await buildSubscriptionPlan(session)
  console.log(
    `[main] subscription plan: ${equity.length} equities + ${options.length} options`,
  )

  // Register all symbols with their structural metadata so the store
  // never needs to parse OCC strings on the hot path.
  for (const sym of equity) {
    registerSymbol({
      symbol: sym,
      kind: 'equity',
      underlying: null,
      expiration_date: null,
      strike: null,
      option_type: null,
    })
  }
  for (const opt of options) {
    registerSymbol({
      symbol: opt.streamer,
      kind: 'option',
      underlying: opt.ticker,
      expiration_date: opt.expirationDate,
      strike: opt.strike,
      option_type: opt.optionType,
    })
    // Mirror into the flow module so Trade events know how to bucket
    // this symbol without re-parsing the OCC string.
    registerOptionForFlow({
      symbol: opt.streamer,
      ticker: opt.ticker,
      expiration_date: opt.expirationDate,
      strike: opt.strike,
      option_type: opt.optionType,
    })
  }

  const client = new DxLinkClient({
    auth: streamer,
    refreshAuth: async () => {
      // Refresh the session if it's near expiry too.
      if (Date.now() > session.expiresAt - 60_000) session = await login()
      streamer = await getStreamerAuth(session)
      return streamer
    },
    onEvent: (ev) => {
      const sym = String(ev.eventSymbol ?? '')
      if (!sym) return
      const t = ev.eventType as string
      switch (t) {
        case 'Quote':
          applyEvent(sym, {
            bid: numOrNull(ev.bidPrice),
            ask: numOrNull(ev.askPrice),
          })
          return
        case 'Greeks':
          applyEvent(sym, {
            iv: numOrNull(ev.volatility),
            delta: numOrNull(ev.delta),
            gamma: numOrNull(ev.gamma),
            theta: numOrNull(ev.theta),
            vega: numOrNull(ev.vega),
          })
          return
        case 'Summary':
          applyEvent(sym, {
            open_interest: numOrNull(ev.openInterest),
            prev_close: numOrNull(ev.prevDayClosePrice),
            day_volume: numOrNull(ev.dayVolume),
          })
          return
        case 'Trade': {
          // Twin destinations:
          //   1. dxlink_quotes — store the latest print as `last` so
          //      compute-gex has a fresh mid value during low-quote
          //      windows.
          //   2. flow aggregator — every print becomes part of today's
          //      per-strike volume / premium bucket.
          const price = numOrNull(ev.price)
          const size = numOrNull(ev.size)
          const eventTime = numOrNull(ev.time)
          if (price != null) applyEvent(sym, { last: price })
          if (price != null && size != null) {
            applyTrade(sym, price, size, eventTime ?? undefined)
          }
          return
        }
      }
    },
  })

  await client.start()

  // Build subscription specs in chunks so we don't blow the WS frame
  // size limit (dxFeed accepts up to ~100KB per FEED_SUBSCRIPTION).
  const allSpecs: SubSpec[] = []
  for (const sym of equity) {
    allSpecs.push({ type: 'Quote', symbol: sym })
  }
  for (const opt of options) {
    allSpecs.push({ type: 'Quote', symbol: opt.streamer })
    allSpecs.push({ type: 'Greeks', symbol: opt.streamer })
    allSpecs.push({ type: 'Summary', symbol: opt.streamer })
    allSpecs.push({ type: 'Trade', symbol: opt.streamer })
  }
  // Seed the shadow Map with last-known OI / Greeks from previous
  // session(s) before subscribing — this keeps the matrix dense
  // immediately on boot, even for symbols whose Summary frame won't
  // arrive until the value next changes (which during low-churn
  // hours can be never).
  const allSymbols = [
    ...equity,
    ...options.map((o) => o.streamer),
  ]
  await seedShadowFromDb(allSymbols)

  // Authoritative OI snapshot from Yahoo Finance. dxFeed Summary
  // frames are unreliable as a first-time seed (snapshot-on-change
  // semantics — symbols whose OI hasn't moved since session start
  // never get a frame). We tried Tastytrade /market-metrics here
  // first; that endpoint is underlying-level and doesn't return
  // per-option OI in a usable shape. Yahoo's /v7/finance/options
  // works (we already use it as the compute-gex Yahoo fallback) and
  // returns the full chain per call with per-strike OI.
  await seedOpenInterestFromYahoo(options)

  const CHUNK = 500
  for (let i = 0; i < allSpecs.length; i += CHUNK) {
    await client.subscribe(allSpecs.slice(i, i + CHUNK))
  }
  console.log(`[main] sent ${allSpecs.length} subscription specs`)

  // Refresh the chain plan every 4 hours — strikes get added as spot
  // moves, and tomorrow's expirations roll in. We don't reconnect the
  // WS for this, just re-build subscriptions and apply the diff.
  setInterval(async () => {
    try {
      console.log('[main] periodic plan refresh')
      if (Date.now() > session.expiresAt - 60_000) session = await login()
      const next = await buildSubscriptionPlan(session)
      // Quick diff: add anything new. We don't bother removing stale
      // subscriptions; they age out of dxlink_quotes via updated_at.
      const seen = new Set([
        ...equity,
        ...options.map((o) => o.streamer),
      ])
      const newSpecs: SubSpec[] = []
      for (const sym of next.equity) {
        if (!seen.has(sym)) {
          registerSymbol({
            symbol: sym,
            kind: 'equity',
            underlying: null,
            expiration_date: null,
            strike: null,
            option_type: null,
          })
          newSpecs.push({ type: 'Quote', symbol: sym })
          equity.push(sym)
        }
      }
      for (const opt of next.options) {
        if (!seen.has(opt.streamer)) {
          registerSymbol({
            symbol: opt.streamer,
            kind: 'option',
            underlying: opt.ticker,
            expiration_date: opt.expirationDate,
            strike: opt.strike,
            option_type: opt.optionType,
          })
          registerOptionForFlow({
            symbol: opt.streamer,
            ticker: opt.ticker,
            expiration_date: opt.expirationDate,
            strike: opt.strike,
            option_type: opt.optionType,
          })
          newSpecs.push({ type: 'Quote', symbol: opt.streamer })
          newSpecs.push({ type: 'Greeks', symbol: opt.streamer })
          newSpecs.push({ type: 'Summary', symbol: opt.streamer })
          newSpecs.push({ type: 'Trade', symbol: opt.streamer })
          options.push(opt)
        }
      }
      if (newSpecs.length > 0) {
        for (let i = 0; i < newSpecs.length; i += CHUNK) {
          await client.subscribe(newSpecs.slice(i, i + CHUNK))
        }
        console.log(`[main] subscribed to ${newSpecs.length} new symbols`)
      }

      // Refresh the OI snapshot for the full universe — OI drifts
      // intraday as positions open and close, so a 4h refresh keeps
      // the matrix accurate. Also catches OI for any newly-added
      // strikes (e.g. when spot moves and the chain plan picks up
      // strikes outside the prior subscription window).
      await seedOpenInterestFromYahoo(options)
    } catch (e) {
      console.error('[main] plan refresh failed:', e)
    }
  }, 4 * 60 * 60 * 1000)

  // SIGTERM handling so Fly.io's graceful shutdown actually closes
  // the WS cleanly.
  Deno.addSignalListener('SIGTERM', () => {
    console.log('[main] SIGTERM, stopping')
    client.stop()
    Deno.exit(0)
  })
}

// Seed open_interest into the shadow Map by pulling chain data from
// Yahoo. We hit one Yahoo call per (ticker, expiration) pair — that's
// ~70 tickers × 2 expirations = ~140 calls per refresh, well under
// Yahoo's tolerance with the cookie+crumb auth. Per-call sequential
// to avoid hammering Yahoo, but fast enough that the full sweep
// completes in <2 min on boot.
async function seedOpenInterestFromYahoo(opts: OptionMeta[]) {
  if (opts.length === 0) return
  // Build a lookup: ticker → set of expiration dates we care about,
  // and ticker|expiration|strike|type → streamer symbol.
  const wantedExps = new Map<string, Set<string>>()
  const streamerLookup = new Map<string, string>()
  for (const o of opts) {
    if (!o.ticker || !o.expirationDate || !o.streamer) continue
    let exps = wantedExps.get(o.ticker)
    if (!exps) {
      exps = new Set()
      wantedExps.set(o.ticker, exps)
    }
    exps.add(o.expirationDate)
    const key = `${o.ticker}|${o.expirationDate}|${o.strike}|${o.optionType}`
    streamerLookup.set(key, o.streamer)
  }

  let totalApplied = 0
  let totalFetched = 0
  for (const [ticker, exps] of wantedExps) {
    for (const exp of exps) {
      try {
        const chain = await fetchYahooChain(ticker, 0, exp)
        totalFetched += chain.strikes.length * 2
        for (const s of chain.strikes) {
          const callKey = `${ticker}|${exp}|${s.strike}|C`
          const putKey = `${ticker}|${exp}|${s.strike}|P`
          const callStreamer = streamerLookup.get(callKey)
          const putStreamer = streamerLookup.get(putKey)
          if (callStreamer && Number.isFinite(s.callOI) && s.callOI > 0) {
            applyEvent(callStreamer, { open_interest: s.callOI })
            totalApplied++
          }
          if (putStreamer && Number.isFinite(s.putOI) && s.putOI > 0) {
            applyEvent(putStreamer, { open_interest: s.putOI })
            totalApplied++
          }
        }
      } catch (e) {
        // Yahoo can rate-limit or transiently fail — log per-ticker
        // but keep going so a bad ticker doesn't poison the whole sweep.
        console.warn(`[yahoo-oi] ${ticker} ${exp}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }
  console.log(
    `[yahoo-oi] seeded OI for ${totalApplied} legs across ` +
      `${wantedExps.size} tickers (${totalFetched} legs fetched)`,
  )
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

main().catch((e) => {
  console.error('[main] fatal:', e)
  Deno.exit(1)
})
