// Yahoo Finance options endpoint — undocumented but widely used.
//
// Why Yahoo instead of Tastytrade for GEX:
//   Tastytrade's REST /market-data/* endpoints return 502 on
//   production — live equity + option quotes only ride DXLink
//   streaming. We need a single REST call that gives us spot + the
//   whole option chain with OI + IV per strike. Yahoo's
//   /v7/finance/options/{symbol} does exactly that.
//
// Caveats:
//   - Unofficial endpoint; can rate-limit or change shape without notice
//   - Quotes lag real-time by up to 15 min on free Yahoo data
//   - For dealer GEX positioning, that's plenty fresh — flow accumulates
//     over hours, not seconds. The 5-min cache absorbs most volatility.
//
// We send a browser-like User-Agent because Yahoo will sometimes
// reject the default Deno fetch UA.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface YahooStrike {
  strike: number
  callOI: number
  putOI: number
  callIV: number | null  // decimal, 0.42 = 42%
  putIV: number | null
}

export interface YahooChain {
  ticker: string
  spot: number
  expirations: number[]      // unix-seconds for every available expiry
  expirationDate: string     // YYYY-MM-DD of the expiry returned
  expirationUnix: number
  daysToExpiration: number
  strikes: YahooStrike[]
}

export class YahooError extends Error {
  status?: number
  constructor(msg: string, status?: number) {
    super(msg)
    this.status = status
  }
}

async function fetchYahooRaw(ticker: string, dateUnix?: number): Promise<unknown> {
  const sym = encodeURIComponent(ticker.toUpperCase())
  const qs = dateUnix ? `?date=${dateUnix}` : ''
  // query1 and query2 are symmetric mirrors; round-robin gives us a
  // free retry against transient gateway errors on one of them.
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']
  let lastStatus = 0
  let lastErr: Error | null = null
  for (const host of hosts) {
    try {
      const resp = await fetch(`https://${host}/v7/finance/options/${sym}${qs}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      })
      if (resp.ok) {
        return await resp.json()
      }
      lastStatus = resp.status
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
  }
  throw new YahooError(
    `yahoo options ${ticker}: ${lastStatus || lastErr?.message || 'no response'}`,
    lastStatus,
  )
}

function dateFromUnix(unix: number): { date: string; daysAhead: number } {
  const d = new Date(unix * 1000)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const daysAhead = Math.round((d.getTime() - today.getTime()) / 86_400_000)
  return { date: `${yyyy}-${mm}-${dd}`, daysAhead }
}

function parseChain(raw: unknown, ticker: string): YahooChain {
  const result = (raw as { optionChain?: { result?: Array<Record<string, unknown>> } })
    ?.optionChain?.result?.[0]
  if (!result) throw new YahooError(`yahoo options ${ticker}: empty result`)

  const quote = result['quote'] as Record<string, unknown> | undefined
  const spot = Number(
    quote?.['regularMarketPrice'] ??
      quote?.['postMarketPrice'] ??
      quote?.['preMarketPrice'] ??
      quote?.['previousClose'] ??
      0,
  )
  if (!Number.isFinite(spot) || spot <= 0) {
    throw new YahooError(`yahoo options ${ticker}: no spot price in quote`)
  }

  const expirationDates = (result['expirationDates'] as number[] | undefined) ?? []

  const opts = (result['options'] as Array<Record<string, unknown>> | undefined)?.[0]
  if (!opts) throw new YahooError(`yahoo options ${ticker}: no options block`)

  const expirationUnix = Number(opts['expirationDate'])
  const { date: expirationDate, daysAhead } = dateFromUnix(expirationUnix)

  const byStrike = new Map<number, YahooStrike>()
  const num = (v: unknown): number | null => {
    if (v == null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  const calls = (opts['calls'] as Array<Record<string, unknown>> | undefined) ?? []
  for (const c of calls) {
    const k = num(c['strike'])
    if (k == null) continue
    byStrike.set(k, {
      strike: k,
      callOI: num(c['openInterest']) ?? 0,
      putOI: 0,
      callIV: num(c['impliedVolatility']),
      putIV: null,
    })
  }
  const puts = (opts['puts'] as Array<Record<string, unknown>> | undefined) ?? []
  for (const p of puts) {
    const k = num(p['strike'])
    if (k == null) continue
    const existing = byStrike.get(k) ?? {
      strike: k,
      callOI: 0,
      putOI: 0,
      callIV: null,
      putIV: null,
    }
    existing.putOI = num(p['openInterest']) ?? 0
    existing.putIV = num(p['impliedVolatility'])
    byStrike.set(k, existing)
  }

  const strikes = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike)

  return {
    ticker: ticker.toUpperCase(),
    spot,
    expirations: expirationDates,
    expirationDate,
    expirationUnix,
    daysToExpiration: Math.max(daysAhead, 0),
    strikes,
  }
}

// Public API: fetch the chain for the closest expiration to preferredDte
// (defaults to ~30 days). Yahoo only returns one expiry per call, so if
// the closest expiry isn't the front month we round-trip a second time.
export async function fetchYahooChain(
  ticker: string,
  preferredDte = 30,
): Promise<YahooChain> {
  // First call: nearest expiration + the full list of available dates.
  const raw = await fetchYahooRaw(ticker)
  const chain = parseChain(raw, ticker)

  if (chain.expirations.length <= 1) return chain
  if (Math.abs(chain.daysToExpiration - preferredDte) <= 4) return chain

  // Pick the expiration with the smallest |days - preferred| from the
  // list, then re-fetch with that explicit date.
  const todayUnix = Math.floor(Date.now() / 1000)
  let bestUnix = chain.expirations[0]
  let bestDelta = Infinity
  for (const u of chain.expirations) {
    const days = (u - todayUnix) / 86_400
    if (days < 0) continue
    const delta = Math.abs(days - preferredDte)
    if (delta < bestDelta) {
      bestDelta = delta
      bestUnix = u
    }
  }
  if (bestUnix === chain.expirationUnix) return chain

  try {
    const raw2 = await fetchYahooRaw(ticker, bestUnix)
    return parseChain(raw2, ticker)
  } catch {
    // If the targeted call fails, fall back to whatever the first call gave.
    return chain
  }
}
