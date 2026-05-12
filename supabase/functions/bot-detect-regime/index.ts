// bot-detect-regime — classify a ticker as Regime A / B / mixed.
//
// Regime A (positive gamma, dealers long): spot > zero_gamma AND net_gex > 0
//   → dealers sell rallies + buy dips → vol-suppressed, pinning
//   → strategies favoured: short premium, pin trades, fade-against-walls
//
// Regime B (negative gamma, dealers short): spot < zero_gamma AND net_gex < 0
//   → dealers buy rallies + sell dips → trend-amplifying, vol-expansion
//   → strategies favoured: long premium, breakout trades
//
// Mixed: spot is within 1% of zero_gamma, or net_gex sign disagrees
// with spot-vs-flip placement.
//
// Confidence: scaled distance of spot from zero_gamma normalised by
// expected daily move (clamped 0..1). Strategy code rejects entries
// when confidence < 0.4.
//
// Auth: service_role only (called by the bot's per-strategy scanners).
// Caches results to regime_snapshots (default TTL 30 min). Repeat
// callers within TTL get the cached row.
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const DEFAULT_TTL_MIN = 30

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

interface GexMatrix {
  spot?: number
  zero_gamma?: number
  net_gex?: number
  walls?: { call_wall?: number; put_wall?: number }
  call_wall?: number
  put_wall?: number
  expected_move_1d_pct?: number
  flow?: { calls_dollar_volume?: number; puts_dollar_volume?: number }
}

function classify(matrix: GexMatrix): {
  regime: 'A' | 'B' | 'mixed' | 'unknown'
  confidence: number
  reasoning: string[]
} {
  const reasoning: string[] = []
  const spot = Number(matrix.spot)
  const flip = Number(matrix.zero_gamma)
  const netGex = Number(matrix.net_gex)

  if (!Number.isFinite(spot) || !Number.isFinite(flip) || !Number.isFinite(netGex)) {
    return { regime: 'unknown', confidence: 0, reasoning: ['missing spot/flip/net_gex'] }
  }

  const distancePct = ((spot - flip) / spot) * 100
  const aboveFlip = spot > flip
  const positiveGex = netGex > 0

  reasoning.push(`spot=${spot.toFixed(2)} flip=${flip.toFixed(2)} (Δ=${distancePct.toFixed(2)}%)`)
  reasoning.push(`net_gex=${netGex.toFixed(0)}`)

  // Mixed: within 0.5% of flip OR sign disagreement
  if (Math.abs(distancePct) < 0.5) {
    reasoning.push('spot within 0.5% of flip — transition zone')
    return { regime: 'mixed', confidence: 0.3, reasoning }
  }
  if (aboveFlip !== positiveGex) {
    reasoning.push('spot/net_gex direction disagree — transition signal')
    return { regime: 'mixed', confidence: 0.4, reasoning }
  }

  // Pure regime — confidence scales with distance, normalised against
  // expected 1d move (default 1.0% for major indices if missing).
  const expectedMove = Number(matrix.expected_move_1d_pct) || 1.0
  const distanceInMoves = Math.abs(distancePct) / expectedMove
  // Map 0..3+ standard moves to 0..1 confidence
  const confidence = Math.min(1, Math.max(0.4, distanceInMoves / 3))

  const regime: 'A' | 'B' = aboveFlip && positiveGex ? 'A' : 'B'
  reasoning.push(`regime ${regime} (dist=${distanceInMoves.toFixed(2)} expected-moves)`)

  return { regime, confidence, reasoning }
}

async function loadRecentSnapshot(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
  ttlMin: number,
): Promise<{ snapshot: Record<string, unknown>; age_minutes: number } | null> {
  const { data } = await supabase
    .from('regime_snapshots')
    .select('*')
    .eq('ticker', ticker.toUpperCase())
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const ageMs = Date.now() - new Date(data.snapshot_at as string).getTime()
  const ageMin = ageMs / 60_000
  if (ageMin > (data.ttl_minutes ?? ttlMin)) return null
  return { snapshot: data, age_minutes: ageMin }
}

async function fetchGexMatrix(ticker: string): Promise<GexMatrix | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/compute-gex`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticker, refresh: false }),
  })
  if (!resp.ok) return null
  const body = await resp.json().catch(() => null)
  return (body?.data ?? body) as GexMatrix | null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON' }, 400) }

  const ticker = String(body.ticker ?? '').toUpperCase()
  const refresh = body.refresh === true
  const ttlMin = Number(body.ttl_minutes) > 0 ? Number(body.ttl_minutes) : DEFAULT_TTL_MIN
  if (!ticker) return json({ success: false, error: 'ticker required' }, 400)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  if (!refresh) {
    const cached = await loadRecentSnapshot(supabase, ticker, ttlMin)
    if (cached) {
      return json({
        success: true,
        cached: true,
        age_minutes: cached.age_minutes,
        snapshot: cached.snapshot,
      })
    }
  }

  const matrix = await fetchGexMatrix(ticker)
  if (!matrix) {
    return json({ success: false, error: 'compute-gex unavailable' }, 502)
  }

  const result = classify(matrix)

  const callWall = Number(matrix.walls?.call_wall ?? matrix.call_wall ?? 0) || null
  const putWall  = Number(matrix.walls?.put_wall  ?? matrix.put_wall  ?? 0) || null

  let flowDirection: string | null = null
  if (matrix.flow && Number.isFinite(matrix.flow.calls_dollar_volume) && Number.isFinite(matrix.flow.puts_dollar_volume)) {
    const c = Number(matrix.flow.calls_dollar_volume)
    const p = Number(matrix.flow.puts_dollar_volume)
    const total = c + p
    if (total > 0) {
      const callShare = c / total
      flowDirection = callShare > 0.6 ? 'calls_dominant' : callShare < 0.4 ? 'puts_dominant' : 'balanced'
    }
  }

  const { data: inserted } = await supabase
    .from('regime_snapshots')
    .insert({
      ticker,
      regime: result.regime,
      confidence: result.confidence,
      spot: Number(matrix.spot) || null,
      zero_gamma: Number(matrix.zero_gamma) || null,
      net_gex: Number(matrix.net_gex) || null,
      call_wall: callWall,
      put_wall: putWall,
      flow_direction: flowDirection,
      context: { reasoning: result.reasoning, raw: matrix },
      ttl_minutes: ttlMin,
    })
    .select('*')
    .maybeSingle()

  return json({
    success: true,
    cached: false,
    snapshot: inserted,
  })
})
