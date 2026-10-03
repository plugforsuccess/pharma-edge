// suggest-leaps — LEAPS buy ideas on the core sleeve, for /charts.
//
// POST {} → { success, as_of, benchmark, picks: [Pick], ranked: [Score] }
//
// Mirrors the LDP engine's core sleeve (ldp/scoring.py, ldp/contracts.py,
// thresholds from ldp/config.py — keep in sync):
//   1. Score each sector ETF on 3m / 6m / 12m returns and 12m relative
//      strength vs SPY (weights 0.20 / 0.30 / 0.30 / 0.20), each metric
//      min-max normalised across the set. Below its 200-day average =
//      not eligible. Top 3 eligible = the top tier.
//   2. For each, pick a call that clears every hard reject: DTE ≥ 540,
//      delta 0.70–0.80, vol rank ≤ 70, bid/ask spread ≤ 10% of mid,
//      open interest ≥ 100. Closest to 730 DTE wins, then closest to
//      delta 0.75, then the tightest spread.
// Vol rank: the engine uses IV rank; iv_history doesn't cover the sector
// ETFs, so this uses the 20-day historical-vol rank over the last year
// of daily closes (a stand-in — labelled as such in the response).
//
// Data: Polygon (Massive) daily bars + options snapshot, MASSIVE_API_KEY.
// Market-wide, not per user: cached 30 minutes in the warm instance.
// Suggestions only — nothing is ordered here. verify_jwt=true.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'

const POLYGON_BASE = Deno.env.get('POLYGON_BASE_URL') || 'https://api.polygon.io'
const MASSIVE_API_KEY = Deno.env.get('MASSIVE_API_KEY')

const SECTORS = ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC']
const BENCHMARK = 'SPY'
// ldp/config.py CoreConfig + ContractConfig
const CORE = { topN: 3, weights: { ret_3m: 0.2, ret_6m: 0.3, ret_12m: 0.3, rel_strength: 0.2 } as Record<string, number>, requireAbove200dma: true }
const CONTRACT = { minDte: 540, targetDte: 730, deltaMin: 0.70, deltaMax: 0.80, maxVolRank: 70, maxSpreadPct: 0.10, minOpenInterest: 100 }
const CACHE_MS = 30 * 60 * 1000
const DAY_MS = 86_400_000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const withKey = (u: string) => u + (u.includes('?') ? '&' : '?') + `apiKey=${encodeURIComponent(MASSIVE_API_KEY!)}`

async function dailyCloses(ticker: string): Promise<number[]> {
  const to = Date.now()
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/day/${ymd(to - 400 * DAY_MS)}/${ymd(to)}?adjusted=true&sort=asc&limit=5000`
  const resp = await fetch(withKey(url), { signal: AbortSignal.timeout(8000) })
  if (!resp.ok) throw new Error(`bars ${ticker} ${resp.status}`)
  const body: { results?: Array<{ c: number }> } = await resp.json()
  return (body.results ?? []).map((r) => r.c).filter((c) => Number.isFinite(c) && c > 0)
}

const ret = (c: number[], n: number) => (c.length > n ? c[c.length - 1] / c[c.length - 1 - n] - 1 : null)

// 20-day historical vol, annualised, at each day; rank of today's within the last year.
function volRank(c: number[]): number | null {
  const lr = c.slice(1).map((v, i) => Math.log(v / c[i]))
  const hv: number[] = []
  for (let i = 20; i <= lr.length; i++) {
    const w = lr.slice(i - 20, i)
    const m = w.reduce((s, x) => s + x, 0) / 20
    hv.push(Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / 19) * Math.sqrt(252))
  }
  const year = hv.slice(-252)
  if (year.length < 120) return null
  const lo = Math.min(...year)
  const hi = Math.max(...year)
  return hi > lo ? ((year[year.length - 1] - lo) / (hi - lo)) * 100 : 50
}

interface Snap {
  details?: { contract_type?: string; expiration_date?: string; strike_price?: number; ticker?: string }
  open_interest?: number
  implied_volatility?: number
  greeks?: { delta?: number }
  last_quote?: { bid?: number; ask?: number }
}

async function longCalls(ticker: string, spot: number): Promise<Snap[]> {
  const today = Date.now()
  const url = new URL(`${POLYGON_BASE}/v3/snapshot/options/${ticker}`)
  url.searchParams.set('contract_type', 'call')
  url.searchParams.set('expiration_date.gte', ymd(today + CONTRACT.minDte * DAY_MS))
  url.searchParams.set('expiration_date.lte', ymd(today + 1100 * DAY_MS))
  // Delta 0.70–0.80 calls are in the money: well under spot.
  url.searchParams.set('strike_price.gte', String(Math.floor(spot * 0.4)))
  url.searchParams.set('strike_price.lte', String(Math.ceil(spot * 1.0)))
  url.searchParams.set('limit', '250')
  let next: string | null = url.toString()
  const out: Snap[] = []
  for (let page = 0; next && page < 8; page++) {
    const resp = await fetch(withKey(next), { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) throw new Error(`chain ${ticker} ${resp.status}`)
    const body: { results?: Snap[]; next_url?: string } = await resp.json()
    out.push(...(body.results ?? []))
    next = body.next_url ?? null
  }
  return out
}

function pickContract(chain: Snap[], vol: number | null) {
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
  const centre = (CONTRACT.deltaMin + CONTRACT.deltaMax) / 2
  let checked = 0
  const passing = []
  for (const s of chain) {
    const exp = s.details?.expiration_date
    const strike = Number(s.details?.strike_price)
    const delta = Math.abs(Number(s.greeks?.delta))
    const bid = Number(s.last_quote?.bid)
    const ask = Number(s.last_quote?.ask)
    const oi = Number(s.open_interest)
    if (!exp || !(strike > 0)) continue
    checked++
    const dte = Math.round((Date.parse(`${exp}T00:00:00Z`) - today) / DAY_MS)
    const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : null
    const spreadPct = mid ? (ask - bid) / mid : null
    const ok = dte >= CONTRACT.minDte
      && Number.isFinite(delta) && delta >= CONTRACT.deltaMin && delta <= CONTRACT.deltaMax
      && vol != null && vol <= CONTRACT.maxVolRank
      && spreadPct != null && spreadPct <= CONTRACT.maxSpreadPct
      && Number.isFinite(oi) && oi >= CONTRACT.minOpenInterest
    if (ok) {
      passing.push({ symbol: s.details?.ticker ?? '', expiration: exp, strike, dte, delta, bid, ask, mid: mid!,
        spread_pct: spreadPct!, open_interest: oi, iv: Number(s.implied_volatility) || null })
    }
  }
  passing.sort((a, b) => Math.abs(a.dte - CONTRACT.targetDte) - Math.abs(b.dte - CONTRACT.targetDte)
    || Math.abs(a.delta - centre) - Math.abs(b.delta - centre) || a.spread_pct - b.spread_pct)
  return { contract: passing[0] ?? null, checked, passed: passing.length }
}

let cache: { at: number; body: unknown } | null = null

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!MASSIVE_API_KEY) return json({ success: false, error: 'market data not configured' }, 503)
  if (cache && Date.now() - cache.at < CACHE_MS) return json(cache.body)

  try {
    const tickers = [BENCHMARK, ...SECTORS]
    const closes = Object.fromEntries(await Promise.all(tickers.map(async (t) => [t, await dailyCloses(t)] as const)))
    const bench12 = ret(closes[BENCHMARK], 252)

    const metrics = SECTORS.map((t) => {
      const c = closes[t]
      const sma200 = c.length >= 200 ? c.slice(-200).reduce((s, x) => s + x, 0) / 200 : null
      const r12 = ret(c, 252)
      return {
        ticker: t, spot: c[c.length - 1],
        ret_3m: ret(c, 63), ret_6m: ret(c, 126), ret_12m: r12,
        rel_strength: r12 != null && bench12 != null ? r12 - bench12 : null,
        above_200dma: sma200 != null && c[c.length - 1] > sma200,
        vol_rank: volRank(c),
      }
    }).filter((m) => m.ret_3m != null && m.ret_6m != null && m.ret_12m != null && m.rel_strength != null)

    // ldp/scoring.py score_sectors
    const keys = Object.keys(CORE.weights)
    const totalW = keys.reduce((s, k) => s + CORE.weights[k], 0)
    const lo = Object.fromEntries(keys.map((k) => [k, Math.min(...metrics.map((m) => m[k as keyof typeof m] as number))]))
    const hi = Object.fromEntries(keys.map((k) => [k, Math.max(...metrics.map((m) => m[k as keyof typeof m] as number))]))
    const ranked = metrics.map((m) => {
      const comps = Object.fromEntries(keys.map((k) => [k, hi[k] === lo[k] ? 0.5 : ((m[k as keyof typeof m] as number) - lo[k]) / (hi[k] - lo[k])]))
      const score = keys.reduce((s, k) => s + comps[k] * CORE.weights[k], 0) / totalW
      return { ...m, score: Math.round(score * 1e6) / 1e6, components: comps, eligible: m.above_200dma || !CORE.requireAbove200dma }
    }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.ticker.localeCompare(b.ticker))
      .map((m, i) => ({ ...m, rank: i + 1 }))

    const top = ranked.filter((m) => m.eligible).slice(0, CORE.topN)
    const picks = await Promise.all(top.map(async (m) => {
      try {
        const sel = pickContract(await longCalls(m.ticker, m.spot), m.vol_rank)
        const reason = sel.contract ? null
          : m.vol_rank == null ? 'not enough price history to measure volatility'
          : m.vol_rank > CONTRACT.maxVolRank ? `volatility rank ${Math.round(m.vol_rank)} > ${CONTRACT.maxVolRank} — options are expensive`
          : `none of ${sel.checked} long-dated calls cleared the contract rules`
        return { ...m, contract: sel.contract, checked: sel.checked, passed: sel.passed, reason }
      } catch (e) {
        return { ...m, contract: null, checked: 0, passed: 0, reason: `couldn't load the option chain (${(e as Error).message})` }
      }
    }))

    const body = {
      success: true, as_of: new Date().toISOString(), benchmark: BENCHMARK, vol_rank_source: 'hv20_1y',
      rules: { ...CONTRACT, topN: CORE.topN, weights: CORE.weights }, picks, ranked,
    }
    cache = { at: Date.now(), body }
    return json(body)
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 502)
  }
})
