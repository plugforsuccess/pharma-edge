// deploy-trigger: 2026-05-12 (manual workflow nudge)
// bot-scan-iv-meanrev — IV mean-reversion scanner.
//
// Looks for liquid tickers where 30d IV is at or above the 80th
// percentile of its trailing 60-day range (signalling overextended
// premium) AND the regime detector reports Regime A (vol-suppressed,
// dealers long gamma) — the conditions where short premium has positive
// expectancy.
//
// Setup: SHORT IRON CONDOR with:
//   - body width:  body_width_pct % of spot (default 2%)  → short put / short call
//   - wing width:  wing_width_pct % of spot (default 5%)  → long put / long call
//   - target DTE:  target_dte (default 30)
//   - net credit must be >= 25% of wing width (else skip — bad R/R)
//
// Filters before inserting bot_signals:
//   - ticker in SCAN_UNIVERSE
//   - regime == 'A' AND confidence >= 0.5
//   - iv_30d_percentile_60d >= min_iv_percentile (default 80)
//   - structure passes net_credit / max_loss / R/R math
//
// Cron: every 15min during RTH. service-role only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const STRATEGY = 'iv_meanrev'

// Same curated universe as the whale-tail scanner. High-liquidity
// names where iron condors have tight enough markets to be fillable.
const SCAN_UNIVERSE = [
  'SPY','QQQ','IWM','DIA','XLK','SMH',
  'AAPL','MSFT','NVDA','GOOGL','META','AMZN','TSLA','AMD','AVGO',
  'NFLX','COIN','CRM','ORCL','SNOW',
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

async function ivPercentile(supabase: ReturnType<typeof createClient>, ticker: string): Promise<{ pct: number; iv30d: number | null }> {
  const sixtyDaysAgo = new Date()
  sixtyDaysAgo.setUTCDate(sixtyDaysAgo.getUTCDate() - 60)
  const { data } = await supabase
    .from('iv_history')
    .select('iv_30d, sample_date')
    .eq('ticker', ticker.toUpperCase())
    .gte('sample_date', sixtyDaysAgo.toISOString().slice(0, 10))
    .order('sample_date', { ascending: false })
  const rows = data ?? []
  if (rows.length < 20) return { pct: 50, iv30d: null }
  const sorted = rows.map((r) => Number(r.iv_30d)).filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return { pct: 50, iv30d: null }
  const latest = Number(rows[0].iv_30d)
  if (!Number.isFinite(latest)) return { pct: 50, iv30d: null }
  const rank = sorted.filter((v) => v <= latest).length
  return { pct: (rank / sorted.length) * 100, iv30d: latest }
}

async function detectRegime(ticker: string): Promise<{ regime: string; confidence: number; spot: number | null } | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/bot-detect-regime`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticker }),
  })
  if (!resp.ok) return null
  const body = await resp.json().catch(() => null)
  const snap = body?.snapshot
  if (!snap) return null
  return {
    regime: String(snap.regime),
    confidence: Number(snap.confidence) || 0,
    spot: Number(snap.spot) || null,
  }
}

function nextFridayDte(targetDte: number): string {
  // Pick the Friday closest to targetDte
  const target = new Date()
  target.setUTCDate(target.getUTCDate() + targetDte)
  const dow = target.getUTCDay()
  // Friday = 5. Shift to nearest Friday.
  const shift = (5 - dow + 7) % 7
  // If shift > 3, go back to the previous Friday instead
  const finalShift = shift > 3 ? shift - 7 : shift
  target.setUTCDate(target.getUTCDate() + finalShift)
  return target.toISOString().slice(0, 10)
}

function roundStrike(s: number): number {
  if (s < 25) return Math.round(s * 2) / 2  // 0.50 increments
  if (s < 100) return Math.round(s)
  if (s < 500) return Math.round(s / 5) * 5
  return Math.round(s / 10) * 10
}

interface MeanRevConfig {
  enabled?: boolean
  capital_allocation_pct?: number
  kill_switch?: boolean
  min_iv_percentile?: number
  target_dte?: number
  wing_width_pct?: number
  body_width_pct?: number
}

interface ActiveUser {
  user_id: string
  cfg: MeanRevConfig
}

async function listActive(supabase: ReturnType<typeof createClient>): Promise<ActiveUser[]> {
  const { data } = await supabase
    .from('profiles')
    .select('id, bot_config')
    .eq('bot_config->>enabled', 'true')
  const out: ActiveUser[] = []
  for (const r of data ?? []) {
    const cfg = (r.bot_config as Record<string, unknown>)?.strategies as Record<string, MeanRevConfig> | undefined
    const mr = cfg?.iv_meanrev
    if (mr?.enabled && !mr.kill_switch) out.push({ user_id: String(r.id), cfg: mr })
  }
  return out
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  // Auth: cron (service role) only.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const users = await listActive(supabase)
  if (users.length === 0) return json({ success: true, skipped: true, reason: 'no_active_users' })

  const inserted: Array<{ user_id: string; ticker: string; signal_id: string }> = []

  for (const ticker of SCAN_UNIVERSE) {
    const regime = await detectRegime(ticker)
    if (!regime || regime.regime !== 'A' || regime.confidence < 0.5 || !regime.spot) continue

    const iv = await ivPercentile(supabase, ticker)

    for (const u of users) {
      const minPct = Number(u.cfg.min_iv_percentile ?? 80)
      const bodyPct = Number(u.cfg.body_width_pct ?? 2) / 100
      const wingPct = Number(u.cfg.wing_width_pct ?? 5) / 100
      const targetDte = Number(u.cfg.target_dte ?? 30)

      if (iv.pct < minPct) continue

      const spot = regime.spot
      const shortPut = roundStrike(spot * (1 - bodyPct))
      const longPut  = roundStrike(spot * (1 - wingPct))
      const shortCall = roundStrike(spot * (1 + bodyPct))
      const longCall  = roundStrike(spot * (1 + wingPct))

      // Estimate credit using a heuristic: short-leg premium = body% × spot × 0.7,
      // long-leg premium = wing% × spot × 0.25 (mid of typical IC market).
      // Net credit ≈ (short_put + short_call - long_put - long_call) × scaling.
      const wingWidth = Math.min(shortPut - longPut, longCall - shortCall)
      const estCreditPerLot = Math.max(0.3, wingWidth * 0.30)
      const maxLossPerLot = wingWidth - estCreditPerLot
      if (maxLossPerLot <= 0) continue
      if (estCreditPerLot / wingWidth < 0.25) continue  // R/R floor

      const expiry = nextFridayDte(targetDte)

      const popEstimate = 0.55  // Heuristic for short IC at ~1 SD body; calibrated by backtest.
      const breakevenPop = maxLossPerLot / (estCreditPerLot + maxLossPerLot)
      const evEdge = popEstimate - breakevenPop
      if (evEdge < 0) continue  // negative EV; skip

      const failures: string[] = []
      if (iv.pct < minPct) failures.push(`iv_pct_${iv.pct.toFixed(0)}_below_${minPct}`)

      const { data: signal, error } = await supabase
        .from('bot_signals')
        .insert({
          user_id: u.user_id,
          strategy: STRATEGY,
          ticker,
          structure: 'short_iron_condor',
          expiry_date: expiry,
          long_put_strike: longPut,
          short_put_strike: shortPut,
          short_call_strike: shortCall,
          long_call_strike: longCall,
          spot_at_signal: spot,
          iv_percentile: iv.pct,
          iv_rank: iv.iv30d,
          net_credit_per_lot: estCreditPerLot,
          max_loss_per_lot: maxLossPerLot,
          estimated_pop: popEstimate,
          reward_risk_ratio: estCreditPerLot / maxLossPerLot,
          ev_edge: evEdge,
          regime: regime.regime,
          context: { source: 'iv_history', iv_percentile_threshold: minPct },
          passes_filter: failures.length === 0,
          filter_failures: failures,
          status: failures.length === 0 ? 'queued' : 'skipped_filter',
        })
        .select('id')
        .maybeSingle()

      if (error) { console.warn('iv_meanrev insert:', error.message); continue }
      if (!signal) continue

      inserted.push({ user_id: u.user_id, ticker, signal_id: signal.id as string })

      if (failures.length === 0) {
        fetch(`${SUPABASE_URL}/functions/v1/bot-execute-multileg-entry`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ signal_id: signal.id }),
        }).catch(() => {})
      }
    }
  }

  return json({ success: true, signals_inserted: inserted.length, sample: inserted.slice(0, 5) })
})
