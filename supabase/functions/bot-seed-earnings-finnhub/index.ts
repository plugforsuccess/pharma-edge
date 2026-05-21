// bot-seed-earnings-finnhub — pull upcoming earnings dates per ticker
// from Finnhub and upsert into public.earnings_calendar.
//
// Replaces the Polygon-based seeder (bot-seed-earnings-calendar) for
// projects without the Polygon Stocks tier. The earnings_calendar
// table schema is unchanged — only the source field flips to
// 'finnhub' so we can tell rows apart if both seeders ever run.
//
// Source: Finnhub's /calendar/earnings returns per-ticker rows when
// `symbol` is supplied. Free tier = 60 calls/minute, so we throttle
// at 1100ms between requests and the ~33-ticker UNIVERSE completes
// in ~36s — well inside the 10-min cron timeout.
//
// Failure model: per-ticker NOOP. If one ticker 404s or rate-limits,
// we skip it and continue. The daily cron self-heals next run.
//
// Auth: service_role only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const FINNHUB_API_KEY = Deno.env.get('FINNHUB_API_KEY')
const FINNHUB_BASE = Deno.env.get('FINNHUB_BASE_URL') || 'https://finnhub.io/api/v1'

// Same universe as the Polygon seeder so both produce compatible data
// during transition. Expand by passing { tickers: [...] } in the body
// — workflow_dispatch already supports overrides via curl.
const UNIVERSE = [
  'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','AVGO',
  'NFLX','COIN','CRM','CSCO','ORCL','SNOW','PLTR','CRWD','ADBE',
  'MSTR','HOOD','RBLX','SOFI','RIVN','LCID','RIOT','CLSK','TE',
  'LLY','NVO','MRNA','PFE','JPM','BAC','GS','WFC',
  'BTMR','BE','NOW',
  // Wheel-strategy dividend / value candidates
  'KO','KMI','F',
]

// 1100ms between requests = ~54 calls/min, comfortably under the
// 60/min free-tier cap. Bump down if you upgrade to a paid plan.
const RATE_LIMIT_MS = 1100

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

interface FinnhubEarnings {
  date?: string                  // YYYY-MM-DD
  epsActual?: number | null
  epsEstimate?: number | null
  hour?: string                  // 'bmo' | 'amc' | '' (rare: 'dmh')
  quarter?: number
  revenueActual?: number | null
  revenueEstimate?: number | null
  symbol?: string
  year?: number
}

async function fetchFinnhubEarnings(
  ticker: string,
  fromDate: string,
  toDate: string,
): Promise<FinnhubEarnings[]> {
  if (!FINNHUB_API_KEY) return []
  const url = new URL(`${FINNHUB_BASE}/calendar/earnings`)
  url.searchParams.set('from', fromDate)
  url.searchParams.set('to', toDate)
  url.searchParams.set('symbol', ticker.toUpperCase())
  url.searchParams.set('token', FINNHUB_API_KEY)
  try {
    const resp = await fetch(url.toString())
    if (!resp.ok) return []
    const body = await resp.json() as { earningsCalendar?: FinnhubEarnings[] }
    return Array.isArray(body?.earningsCalendar) ? body.earningsCalendar : []
  } catch {
    return []
  }
}

// Finnhub's `hour` field is lowercase. Map to our BMO/AMC/UNKNOWN
// constraint. 'dmh' (during market hours, rare) → UNKNOWN since
// announcement_time only allows three values.
function mapAnnouncementTime(h: string | undefined): 'BMO' | 'AMC' | 'UNKNOWN' {
  if (!h) return 'UNKNOWN'
  const lower = h.toLowerCase()
  if (lower === 'bmo') return 'BMO'
  if (lower === 'amc') return 'AMC'
  return 'UNKNOWN'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }
  if (!FINNHUB_API_KEY) {
    return json({ success: false, error: 'FINNHUB_API_KEY not set in Supabase secrets' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* default empty */ }
  const lookahead = Math.min(90, Math.max(7, Number(body.lookahead_days) || 90))
  const tickers: string[] = Array.isArray(body.tickers) && body.tickers.length > 0
    ? (body.tickers as string[]).map((t) => String(t).toUpperCase())
    : UNIVERSE

  const today = new Date().toISOString().slice(0, 10)
  const horizon = new Date()
  horizon.setUTCDate(horizon.getUTCDate() + lookahead)
  const horizonStr = horizon.toISOString().slice(0, 10)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  let inserted = 0
  const errors: string[] = []
  const tickersWithoutEarnings: string[] = []

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]
    try {
      const events = await fetchFinnhubEarnings(ticker, today, horizonStr)
      if (events.length === 0) {
        tickersWithoutEarnings.push(ticker)
      } else {
        for (const e of events) {
          if (!e.date) continue
          const announceTime = mapAnnouncementTime(e.hour)
          const { error } = await supabase
            .from('earnings_calendar')
            .upsert(
              {
                ticker,
                earnings_date: e.date,
                announcement_time: announceTime,
                consensus_eps: e.epsEstimate ?? null,
                consensus_revenue: e.revenueEstimate ?? null,
                estimate_count: null,  // Finnhub doesn't expose count on free tier
                source: 'finnhub',
              },
              { onConflict: 'ticker,earnings_date' },
            )
          if (error) errors.push(`${ticker} ${e.date}: ${error.message}`)
          else inserted += 1
        }
      }
    } catch (e) {
      errors.push(`${ticker}: ${(e as Error).message}`)
    }
    // Throttle between tickers to respect Finnhub's 60/min free-tier
    // limit. Skip on the last iteration.
    if (i < tickers.length - 1) await sleep(RATE_LIMIT_MS)
  }

  return json({
    success: true,
    tickers_seen: tickers.length,
    rows_inserted: inserted,
    tickers_without_earnings: tickersWithoutEarnings.length,
    tickers_without_earnings_sample: tickersWithoutEarnings.slice(0, 10),
    lookahead_days: lookahead,
    errors: errors.slice(0, 20),
  })
})
