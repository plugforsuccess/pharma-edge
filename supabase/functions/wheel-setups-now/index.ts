// wheel-setups-now — Wheel Strategy First Slice endpoint (build
// prompt §6 `GET /api/wheel/setups/now`, §14 item 5).
//
// Pulls the live GEX matrix from compute-gex for ONE ticker, sources
// IV rank from the existing iv_history table, maps both into the pure
// wheelStrategy decision engine and returns the structured setup. No
// persistence in the First Slice — this proves the decision logic
// end-to-end against real data before any UI/cron investment.
//
// Auth: verify_jwt = true (Supabase default — no config.toml entry).
// The gateway enforces a valid user JWT; we forward that same JWT to
// compute-gex (which is verify_jwt=false but accepts user tokens
// cleanly, per the suggest-plays pipeline).
//
// IV rank handling (Cameron's call deferred → fail closed): iv_rank is
// the 60-day percentile of iv_30d (hv_20d fallback) from iv_history.
// If iv_history has too few / no samples for the ticker we return
// iv_rank: null and the engine fails the §4.1 gate closed — a real-
// capital gate must not silently skip a missing condition.
//
// Required secrets: SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  evaluateWheelSetup,
  identifyWall,
  type WheelInput,
  type WallObservation,
} from '../_shared/wheelStrategy.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

// Minimum iv_history samples before a percentile is meaningful. Mirror
// the bot scanners' "60-day percentile" window; below this the gate
// fails closed.
const IV_LOOKBACK = 60
const IV_MIN_SAMPLES = 20

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
  } catch {
    return null
  }
}

function todayUtcMs(): number {
  const n = new Date()
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
}

// DTE of `dateStr` relative to an "as of" UTC-midnight instant. The
// asOfMs param lets the SAME 7–10 DTE expiration rule be applied to a
// historical snapshot as of the day it was taken (apples-to-apples
// wall comparison), not relative to today.
function dteFromDate(dateStr: string, asOfMs: number = todayUtcMs()): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return Number.POSITIVE_INFINITY
  return Math.round((Date.UTC(y, m - 1, d) - asOfMs) / 86_400_000)
}

// ET (America/New_York) calendar date as YYYY-MM-DD. Groups
// gex_history snapshots into trading days the way the desk sees them
// (handles DST + the UTC date-boundary skew automatically).
function etDateString(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function utcMidnightOfEtDate(etDate: string): number {
  const [y, m, day] = etDate.split('-').map(Number)
  return Date.UTC(y, m - 1, day)
}

// §4.2 targets 7–10 DTE. Prefer the soonest expiration inside that
// window; otherwise the one closest to its midpoint (never an already-
// expired one).
function pickExpirationIndex(
  expirations: Array<{ date?: string }>,
  asOfMs: number = todayUtcMs(),
): { index: number; date: string; dte: number } | null {
  let inWindow: { index: number; date: string; dte: number } | null = null
  let nearest: { index: number; date: string; dte: number } | null = null
  for (let i = 0; i < expirations.length; i++) {
    const date = expirations[i]?.date
    if (typeof date !== 'string') continue
    const dte = dteFromDate(date, asOfMs)
    if (!Number.isFinite(dte) || dte < 1) continue
    if (dte >= 7 && dte <= 10) {
      if (inWindow === null || dte < inWindow.dte) inWindow = { index: i, date, dte }
    }
    const d = Math.abs(dte - 8.5)
    if (nearest === null || d < Math.abs(nearest.dte - 8.5)) nearest = { index: i, date, dte }
  }
  return inWindow ?? nearest
}

// 60-day percentile rank of the latest IV sample. Returns null when
// there is not enough history → engine fails the gate closed.
async function sourceIvRank(
  admin: ReturnType<typeof createClient>,
  ticker: string,
): Promise<{ iv_rank: number | null; samples: number }> {
  const { data, error } = await admin
    .from('iv_history')
    .select('sample_date, iv_30d, hv_20d')
    .eq('ticker', ticker)
    .order('sample_date', { ascending: false })
    .limit(IV_LOOKBACK)
  if (error || !data || data.length === 0) return { iv_rank: null, samples: 0 }

  const series: number[] = []
  for (const row of data) {
    const v = row.iv_30d ?? row.hv_20d
    if (v != null && Number.isFinite(Number(v))) series.push(Number(v))
  }
  if (series.length < IV_MIN_SAMPLES) return { iv_rank: null, samples: series.length }

  const latest = series[0] // ordered newest-first
  const atOrBelow = series.filter((v) => v <= latest).length
  const rank = (atOrBelow / series.length) * 100
  return { iv_rank: Math.round(rank * 100) / 100, samples: series.length }
}

// Reconstruct the call wall from a historical GEX matrix payload using
// the EXACT same wall logic as the live path (identifyWall), against
// the comparable 7–10 DTE expiration as of that snapshot's day. A
// re-implemented historical wall would silently drift from the live
// definition — same failure mode the verdict-fixtures guard prevents.
function callWallStrikeFromPayload(payload: unknown, asOfMs: number): number | null {
  const m = payload as {
    strikes?: unknown[]
    expirations?: Array<{ date?: string }>
    oi_call_cells?: Array<Array<number | null>>
  } | null
  if (!m || !Array.isArray(m.strikes) || !Array.isArray(m.expirations)) return null
  const exp = pickExpirationIndex(m.expirations, asOfMs)
  if (!exp) return null
  const strikes = m.strikes.map(Number)
  const callCells = m.oi_call_cells ?? []
  const callOi = strikes.map((_, i) => Number(callCells[i]?.[exp.index] ?? 0) || 0)
  return identifyWall(strikes, callOi)?.strike ?? null
}

// Wall-migration history (owner directive). Pull recent gex_history,
// fold to ONE snapshot per ET trading day (the latest of that day),
// then reconstruct the call wall at ~1 / 3 / 5 trading days ago. The
// pure engine classifies the trajectory; absent points → it fails
// safe to UNKNOWN.
const WALL_HISTORY_TARGETS = [1, 3, 5]

async function sourceWallHistory(
  admin: ReturnType<typeof createClient>,
  ticker: string,
  nowEtDate: string,
): Promise<WallObservation[]> {
  // 16 calendar days comfortably spans 5 trading days through
  // weekends + a holiday or two.
  const cutoff = new Date(Date.now() - 16 * 86_400_000).toISOString()
  const { data, error } = await admin
    .from('gex_history')
    .select('snapshot_at, payload')
    .eq('ticker', ticker)
    .gte('snapshot_at', cutoff)
    .order('snapshot_at', { ascending: false })
    .limit(1200)
  if (error || !data || data.length === 0) return []

  // rows are newest-first → first row seen for an ET date is that
  // day's latest (closest-to-close) snapshot.
  const latestByDate = new Map<string, unknown>()
  for (const row of data) {
    const etDate = etDateString(new Date(row.snapshot_at as string))
    if (etDate >= nowEtDate) continue // exclude today / future
    if (!latestByDate.has(etDate)) latestByDate.set(etDate, row.payload)
  }

  const priorDates = [...latestByDate.keys()].sort().reverse() // desc
  const out: WallObservation[] = []
  for (const tradingDaysAgo of WALL_HISTORY_TARGETS) {
    const etDate = priorDates[tradingDaysAgo - 1]
    if (!etDate) continue
    const strike = callWallStrikeFromPayload(
      latestByDate.get(etDate),
      utcMidnightOfEtDate(etDate),
    )
    out.push({ trading_days_ago: tradingDaysAgo, date: etDate, call_wall_strike: strike })
  }
  return out
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'POST only' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'server not configured' }, 500)
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '')
  const claims = decodeJwtPayload(jwt)
  const userId = typeof claims?.sub === 'string' ? claims.sub : null
  if (!userId) return json({ success: false, error: 'unauthorized' }, 401)

  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  // First Slice is single-ticker "now" — default NOW (the spec's
  // golden-fixture ticker), overridable for ad-hoc debugging.
  const ticker = String(body.ticker ?? 'NOW').trim().toUpperCase()
  if (!ticker || !/^[A-Z.\-]{1,10}$/.test(ticker)) {
    return json({ success: false, error: 'invalid ticker' }, 400)
  }

  // ── Live GEX matrix. Wide strike window so single-name walls aren't
  // clipped; forward the caller's JWT, fall back to service role.
  const computeGexAuth = authHeader || `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  let gexResp: Response
  try {
    gexResp = await fetch(`${SUPABASE_URL}/functions/v1/compute-gex`, {
      method: 'POST',
      headers: {
        Authorization: computeGexAuth,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ticker,
        matrix: true,
        matrix_max_expirations: 6,
        matrix_max_strikes: 60,
        matrix_strike_window_pct: 0.25,
      }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'compute-gex unreachable'
    return json({ success: false, error: msg }, 502)
  }
  if (!gexResp.ok) {
    const detail = await gexResp.text().catch(() => '')
    return json(
      { success: false, error: `compute-gex ${gexResp.status}: ${detail.slice(0, 200)}` },
      502,
    )
  }
  const matrix = await gexResp.json().catch(() => null)
  if (!matrix || matrix.error || !Array.isArray(matrix.strikes)) {
    return json({ success: false, error: matrix?.error ?? 'compute-gex returned no matrix' }, 502)
  }

  const exp = pickExpirationIndex(matrix.expirations ?? [])
  if (!exp) {
    return json({ success: false, error: 'no usable expiration in GEX matrix' }, 502)
  }

  const strikes: number[] = matrix.strikes.map(Number)
  const callCells = matrix.oi_call_cells ?? []
  const putCells = matrix.oi_put_cells ?? []
  const callOi = strikes.map((_, i) => Number(callCells[i]?.[exp.index] ?? 0) || 0)
  const putOi = strikes.map((_, i) => Number(putCells[i]?.[exp.index] ?? 0) || 0)

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const [iv, wallHistory] = await Promise.all([
    sourceIvRank(admin, ticker),
    sourceWallHistory(admin, ticker, etDateString(new Date())),
  ])

  const input: WheelInput = {
    ticker,
    spot: Number(matrix.spot),
    net_gex: Number(matrix.net_gex),
    // compute-gex returns pinning_probability on a 0–1 scale; §4.1
    // gates on a 0–100 scale.
    pin_probability: Number(matrix.pinning_probability ?? 0) * 100,
    expected_move: Number(matrix.expected_move),
    iv_rank: iv.iv_rank,
    expiration: { date: exp.date, dte: exp.dte },
    strikes,
    call_oi: callOi,
    put_oi: putOi,
    wall_history: wallHistory,
  }

  const decision = evaluateWheelSetup(input)

  return json({
    success: true,
    data: {
      ...decision,
      user_id: userId,
      gex_source: matrix.source ?? null,
      iv_rank_source: iv.iv_rank === null ? 'unavailable' : 'iv_history',
      iv_history_samples: iv.samples,
      computed_at: new Date().toISOString(),
    },
  })
})
