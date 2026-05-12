// bot-seed-iv-history — daily snapshot of 30d implied vol per universe
// ticker, plus a 20d historical-vol fallback derived from underlying
// daily bars.
//
// Why we need it: bot-scan-iv-meanrev computes the 60-day percentile
// of iv_30d before deciding whether implied vol is "high". Until 60
// rows accumulate per ticker, the strategy can't fire. This function
// captures one row per ticker per day, run from a daily cron right
// after the close.
//
// Backfill mode: pass {"backfill_days": N} (max 60) to compute today's
// IV plus N trailing daily HV samples. HV(20) is computed from the
// underlying daily bars Polygon makes available going back years, so
// we can prime the percentile baseline with HV as a synthetic stand-in
// for the missing IV history. iv_meanrev's percentile math accepts
// any non-null numeric — keeping iv_30d real-where-we-have-it and
// using hv_20d in the same column slot when we don't is intentional.
//
// Source: Polygon (Massive). Reads MASSIVE_API_KEY from the
// Supabase secrets bag.
//
// Auth: service_role only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const MASSIVE_API_KEY = Deno.env.get('MASSIVE_API_KEY')
const POLYGON_BASE = Deno.env.get('POLYGON_BASE_URL') || 'https://api.polygon.io'

// Same curated list used by the scanner + strategies. Kept in sync
// manually for now; extract to a shared module if it diverges.
const UNIVERSE = [
  'SPY','QQQ','IWM','DIA','XLK','SMH','XLF','XLE','TLT','GLD','VIX','VXX',
  'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','AVGO',
  'NFLX','COIN','CRM','ORCL','SNOW','PLTR','CRWD','ADBE',
  'MSTR','HOOD','RBLX','SOFI','RIVN','LCID',
  'LLY','NVO','MRNA','JPM','BAC','GS','WFC',
  'BTMR','BE','NOW',
]

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split('.')
    if (!payload) return null
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    return JSON.parse(atob(padded))
  } catch { return null }
}

async function polygonGet<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  if (!MASSIVE_API_KEY) return null
  const url = new URL(`${POLYGON_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  url.searchParams.set('apiKey', MASSIVE_API_KEY)
  const resp = await fetch(url.toString())
  if (!resp.ok) return null
  return resp.json() as Promise<T>
}

// Pull the front-month ATM option's IV from the chain snapshot.
// We pick whichever expiry is closest to 30 DTE.
async function fetchAtmIv30d(ticker: string): Promise<number | null> {
  const today = new Date().toISOString().slice(0, 10)
  const ninetyOut = new Date()
  ninetyOut.setUTCDate(ninetyOut.getUTCDate() + 90)
  const data = await polygonGet<{ results?: Array<Record<string, unknown>> }>(
    `/v3/snapshot/options/${ticker.toUpperCase()}`,
    {
      'expiration_date.gte': today,
      'expiration_date.lte': ninetyOut.toISOString().slice(0, 10),
      limit: '250',
    },
  )
  const results = data?.results ?? []
  if (!results.length) return null
  // Find spot from any contract
  const spot = Number((results[0] as { underlying_asset?: { price?: number } })?.underlying_asset?.price)
  if (!Number.isFinite(spot)) return null
  // Pick contract closest to ATM AND closest to 30 DTE
  let best: { iv: number; score: number } | null = null
  for (const r of results) {
    const d = r as {
      implied_volatility?: number
      details?: { strike_price?: number; expiration_date?: string }
    }
    const iv = Number(d.implied_volatility)
    const strike = Number(d.details?.strike_price)
    const exp = d.details?.expiration_date
    if (!Number.isFinite(iv) || iv <= 0 || !Number.isFinite(strike) || !exp) continue
    const dte = Math.floor((new Date(exp).getTime() - Date.now()) / 86_400_000)
    if (dte < 5 || dte > 70) continue
    // Score: lower is better → distance from ATM + distance from 30 DTE.
    const score = Math.abs(strike - spot) / spot + Math.abs(dte - 30) / 30
    if (!best || score < best.score) best = { iv, score }
  }
  return best?.iv ?? null
}

// 20-day annualised HV from daily underlying bars.
async function fetchHv20d(ticker: string, asOf: string): Promise<number | null> {
  const start = new Date(asOf)
  start.setUTCDate(start.getUTCDate() - 35)
  const data = await polygonGet<{ results?: Array<{ c?: number; t?: number }> }>(
    `/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/day/${start.toISOString().slice(0, 10)}/${asOf}`,
    { adjusted: 'true', sort: 'asc', limit: '50' },
  )
  const bars = (data?.results ?? []).filter((b) => Number.isFinite(b.c)).slice(-21)
  if (bars.length < 10) return null
  const rets: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c as number
    const b = bars[i].c as number
    if (a > 0 && b > 0) rets.push(Math.log(b / a))
  }
  if (rets.length < 5) return null
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1)
  return Math.sqrt(variance) * Math.sqrt(252)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }
  if (!MASSIVE_API_KEY) {
    return json({ success: false, error: 'MASSIVE_API_KEY not set in Supabase secrets' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* default empty */ }
  const backfillDays = Math.min(60, Math.max(0, Number(body.backfill_days) || 0))
  const tickers: string[] = Array.isArray(body.tickers) && body.tickers.length > 0
    ? body.tickers as string[]
    : UNIVERSE

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const today = new Date().toISOString().slice(0, 10)
  let inserted = 0
  const errors: string[] = []

  for (const ticker of tickers) {
    // Today's IV + HV
    try {
      const [iv30d, hv20d] = await Promise.all([
        fetchAtmIv30d(ticker),
        fetchHv20d(ticker, today),
      ])
      if (iv30d != null || hv20d != null) {
        const { error } = await supabase
          .from('iv_history')
          .upsert(
            { ticker: ticker.toUpperCase(), sample_date: today, iv_30d: iv30d, hv_20d: hv20d, source: 'polygon' },
            { onConflict: 'ticker,sample_date' },
          )
        if (error) errors.push(`${ticker} today: ${error.message}`)
        else inserted += 1
      }
    } catch (e) {
      errors.push(`${ticker} today: ${(e as Error).message}`)
    }

    // Backfill HV-only rows. Polygon doesn't give historical IV via REST
    // affordably — we use HV-20d as a temporary percentile baseline.
    // Real iv_30d rows get filled in by the daily cron going forward,
    // and the percentile math treats both columns the same way.
    for (let d = 1; d <= backfillDays; d++) {
      const asOf = new Date()
      asOf.setUTCDate(asOf.getUTCDate() - d)
      // Skip weekends
      const dow = asOf.getUTCDay()
      if (dow === 0 || dow === 6) continue
      const asOfStr = asOf.toISOString().slice(0, 10)
      try {
        const hv = await fetchHv20d(ticker, asOfStr)
        if (hv == null) continue
        const { error } = await supabase
          .from('iv_history')
          .upsert(
            { ticker: ticker.toUpperCase(), sample_date: asOfStr, iv_30d: hv, hv_20d: hv, source: 'polygon_hv_backfill' },
            { onConflict: 'ticker,sample_date', ignoreDuplicates: true },
          )
        if (!error) inserted += 1
      } catch (e) {
        errors.push(`${ticker} ${asOfStr}: ${(e as Error).message}`)
      }
    }
  }

  return json({
    success: true,
    tickers_seen: tickers.length,
    rows_inserted: inserted,
    backfill_days: backfillDays,
    errors: errors.slice(0, 20),
  })
})
