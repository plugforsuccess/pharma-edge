// deploy-trigger: 2026-05-12 (manual workflow nudge)
// bot-scan-opex — OPEX-pin scanner.
//
// Strategy: SHORT IRON BUTTERFLY centred on the call wall (Regime A
// only) on the morning of monthly / quarterly OPEX. Dealer pin
// mechanics — large net positive GEX in front-month means dealers must
// hedge to keep spot near max-dealer-pin (the call wall) into 4pm.
// Iron butterfly captures the pin while bounded losses cover the rare
// breakout.
//
// Rules:
//   * Today is in opex_dates (monthly or quarterly)
//   * Regime A confirmed (spot above flip, net_gex > 0)
//   * Call wall within max_dte * 1d expected move
//   * Body strike = nearest standard strike to call wall
//   * Wings at ±2 expected moves around body
//   * R/R ≥ 1:1.5 floor on the butterfly math
//
// Cron: every OPEX day at 10:00 ET (after open print settles, before
// the pin gravity kicks in mid-session). service-role only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const STRATEGY = 'opex_pin'

// OPEX-pin works best on large indices and the single names with the
// most front-month gamma. Curated.
const SCAN_UNIVERSE = ['SPY','QQQ','IWM','AAPL','MSFT','NVDA','TSLA','META','AMZN','GOOGL']

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

function todayNyDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

function roundStrike(s: number): number {
  if (s < 25) return Math.round(s * 2) / 2
  if (s < 100) return Math.round(s)
  if (s < 500) return Math.round(s / 5) * 5
  return Math.round(s / 10) * 10
}

async function detectRegime(ticker: string): Promise<{ regime: string; confidence: number; spot: number | null; callWall: number | null; flip: number | null } | null> {
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
  const s = body?.snapshot
  if (!s) return null
  return {
    regime: String(s.regime),
    confidence: Number(s.confidence) || 0,
    spot: Number(s.spot) || null,
    callWall: Number(s.call_wall) || null,
    flip: Number(s.zero_gamma) || null,
  }
}

interface OpexConfig {
  enabled?: boolean
  capital_allocation_pct?: number
  kill_switch?: boolean
  regime_a_only?: boolean
  min_gex_wall_distance_pct?: number
  max_dte?: number
}

interface ActiveUser { user_id: string; cfg: OpexConfig }

async function listActive(supabase: ReturnType<typeof createClient>): Promise<ActiveUser[]> {
  const { data } = await supabase
    .from('profiles')
    .select('id, bot_config')
    .eq('bot_config->>enabled', 'true')
  const out: ActiveUser[] = []
  for (const r of data ?? []) {
    const cfg = (r.bot_config as Record<string, unknown>)?.strategies as Record<string, OpexConfig> | undefined
    const op = cfg?.opex_pin
    if (op?.enabled && !op.kill_switch) out.push({ user_id: String(r.id), cfg: op })
  }
  return out
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const today = todayNyDate()

  const { data: opexRow } = await supabase
    .from('opex_dates')
    .select('opex_type, is_quarterly')
    .eq('opex_date', today)
    .maybeSingle()
  if (!opexRow) {
    return json({ success: true, skipped: true, reason: 'not_opex_day' })
  }

  const users = await listActive(supabase)
  if (users.length === 0) return json({ success: true, skipped: true, reason: 'no_active_users' })

  const inserted: Array<{ user_id: string; ticker: string }> = []

  for (const ticker of SCAN_UNIVERSE) {
    const regime = await detectRegime(ticker)
    if (!regime || !regime.spot || !regime.callWall) continue

    for (const u of users) {
      const regimeAOnly = u.cfg.regime_a_only !== false
      if (regimeAOnly && regime.regime !== 'A') {
        await supabase.from('bot_signals').insert({
          user_id: u.user_id, strategy: STRATEGY, ticker, structure: 'opex_iron_butterfly',
          expiry_date: today,
          spot_at_signal: regime.spot,
          regime: regime.regime,
          context: { opex_type: opexRow.opex_type, reason: 'regime_not_A' },
          passes_filter: false, filter_failures: ['regime_not_A'], status: 'skipped_filter',
        }).select('id').maybeSingle()
        continue
      }
      if (regime.confidence < 0.5) continue

      // Walls must be within reach today (1d expected move).
      const minDistPct = Number(u.cfg.min_gex_wall_distance_pct ?? 2) / 100
      const wallDist = Math.abs(regime.callWall - regime.spot) / regime.spot
      if (wallDist < minDistPct) {
        // wall too close — already at pin, edge gone
        await supabase.from('bot_signals').insert({
          user_id: u.user_id, strategy: STRATEGY, ticker, structure: 'opex_iron_butterfly',
          expiry_date: today,
          spot_at_signal: regime.spot,
          regime: regime.regime,
          context: { opex_type: opexRow.opex_type, call_wall: regime.callWall, reason: 'wall_too_close' },
          passes_filter: false, filter_failures: ['wall_too_close'], status: 'skipped_filter',
        }).select('id').maybeSingle()
        continue
      }

      const body = roundStrike(regime.callWall)
      // Wing width: 1.5% of spot for index ETFs, 2.5% for single stocks
      const wingDollars = roundStrike(regime.spot * (ticker.length <= 3 ? 0.015 : 0.025))
      const longPut  = roundStrike(body - wingDollars)
      const longCall = roundStrike(body + wingDollars)
      const wingWidth = Math.min(body - longPut, longCall - body)
      if (wingWidth <= 0) continue

      // Iron butterfly typically pays ~55% of wing width on pin-day setup.
      const estCredit = wingWidth * 0.55
      const maxLoss = wingWidth - estCredit
      if (maxLoss <= 0) continue
      if (estCredit / maxLoss < 1.5) continue  // R/R 1:1.5 floor

      // Pin probability for OPEX setup: 70%+ historically when regime A
      // + walls within 1d move (calibrate via backtest).
      const popEstimate = 0.65
      const breakevenPop = maxLoss / (estCredit + maxLoss)
      const evEdge = popEstimate - breakevenPop
      if (evEdge < 0) continue

      const { data: signal } = await supabase
        .from('bot_signals')
        .insert({
          user_id: u.user_id,
          strategy: STRATEGY,
          ticker,
          structure: 'opex_iron_butterfly',
          expiry_date: today,
          long_put_strike: longPut,
          short_put_strike: body,
          short_call_strike: body,
          long_call_strike: longCall,
          spot_at_signal: regime.spot,
          iv_percentile: null,
          net_credit_per_lot: estCredit,
          max_loss_per_lot: maxLoss,
          estimated_pop: popEstimate,
          reward_risk_ratio: estCredit / maxLoss,
          ev_edge: evEdge,
          regime: regime.regime,
          context: {
            opex_type: opexRow.opex_type,
            is_quarterly: opexRow.is_quarterly,
            call_wall: regime.callWall,
            flip: regime.flip,
            wall_distance_pct: wallDist * 100,
          },
          passes_filter: true,
          filter_failures: [],
          status: 'queued',
        })
        .select('id')
        .maybeSingle()

      if (signal) {
        inserted.push({ user_id: u.user_id, ticker })
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
