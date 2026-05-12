// bot-seed-earnings-calendar — pull upcoming earnings dates per ticker
// from Polygon (Massive) and upsert into public.earnings_calendar.
//
// The earnings_crush strategy reads this table to find tomorrow's BMO
// announcements. Without this seeder, the table is empty and the
// strategy will never fire.
//
// Source: Polygon's `/vX/reference/tickers/{ticker}/events` returns
// upcoming events including earnings. We pull events for the next
// `lookahead_days` (default 30) for every universe ticker and upsert
// (ticker, earnings_date) rows.
//
// Falls back to a NOOP-on-failure-per-ticker model: if a single
// ticker's events endpoint 404s or rate-limits, we skip that ticker
// and continue. The cron re-runs daily so a transient failure
// self-heals next run.
//
// Auth: service_role only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const MASSIVE_API_KEY = Deno.env.get('MASSIVE_API_KEY')
const POLYGON_BASE = Deno.env.get('POLYGON_BASE_URL') || 'https://api.polygon.io'

const UNIVERSE = [
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

interface PolygonEvent {
  type?: string
  date?: string
  ticker_change?: { ticker?: string }
  details?: {
    announcement_time?: string  // 'before_market' | 'after_market' | 'time_not_supplied'
    eps_consensus?: number
    revenue_consensus?: number
    estimate_count?: number
  }
}

async function fetchEarnings(ticker: string, fromDate: string, toDate: string): Promise<PolygonEvent[]> {
  if (!MASSIVE_API_KEY) return []
  const url = new URL(`${POLYGON_BASE}/vX/reference/tickers/${ticker.toUpperCase()}/events`)
  url.searchParams.set('types', 'earnings')
  url.searchParams.set('apiKey', MASSIVE_API_KEY)
  try {
    const resp = await fetch(url.toString())
    if (!resp.ok) return []
    const body = await resp.json() as { results?: { events?: PolygonEvent[] } }
    const events = body?.results?.events ?? []
    return events.filter((e) => {
      if (e.type !== 'earnings') return false
      if (!e.date) return false
      return e.date >= fromDate && e.date <= toDate
    })
  } catch {
    return []
  }
}

// Polygon's announcement_time values map to our BMO/AMC/UNKNOWN.
function mapAnnouncementTime(s: string | undefined): 'BMO' | 'AMC' | 'UNKNOWN' {
  if (!s) return 'UNKNOWN'
  const lower = s.toLowerCase()
  if (lower.includes('before')) return 'BMO'
  if (lower.includes('after')) return 'AMC'
  return 'UNKNOWN'
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
  const lookahead = Math.min(90, Math.max(7, Number(body.lookahead_days) || 30))
  const tickers: string[] = Array.isArray(body.tickers) && body.tickers.length > 0
    ? body.tickers as string[]
    : UNIVERSE

  const today = new Date().toISOString().slice(0, 10)
  const horizon = new Date()
  horizon.setUTCDate(horizon.getUTCDate() + lookahead)
  const horizonStr = horizon.toISOString().slice(0, 10)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  let inserted = 0
  const errors: string[] = []
  const tickersWithoutEarnings: string[] = []

  for (const ticker of tickers) {
    try {
      const events = await fetchEarnings(ticker, today, horizonStr)
      if (events.length === 0) {
        tickersWithoutEarnings.push(ticker)
        continue
      }
      for (const e of events) {
        const announceTime = mapAnnouncementTime(e.details?.announcement_time)
        const { error } = await supabase
          .from('earnings_calendar')
          .upsert(
            {
              ticker: ticker.toUpperCase(),
              earnings_date: e.date,
              announcement_time: announceTime,
              consensus_eps: e.details?.eps_consensus ?? null,
              consensus_revenue: e.details?.revenue_consensus ?? null,
              estimate_count: e.details?.estimate_count ?? null,
              source: 'polygon',
            },
            { onConflict: 'ticker,earnings_date' },
          )
        if (error) errors.push(`${ticker} ${e.date}: ${error.message}`)
        else inserted += 1
      }
    } catch (e) {
      errors.push(`${ticker}: ${(e as Error).message}`)
    }
  }

  return json({
    success: true,
    tickers_seen: tickers.length,
    rows_inserted: inserted,
    tickers_without_earnings: tickersWithoutEarnings.length,
    lookahead_days: lookahead,
    errors: errors.slice(0, 20),
  })
})
