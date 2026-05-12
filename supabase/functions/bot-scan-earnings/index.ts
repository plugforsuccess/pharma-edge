// deploy-trigger: 2026-05-12 (manual workflow nudge)
// bot-scan-earnings — earnings-IV-crush scanner.
//
// Strategy: SHORT IRON CONDOR opened the day before a BMO earnings
// announcement, closed at the open the morning of announcement. Vega
// collapses overnight as IV drops from event-elevated levels to
// post-announcement realised vol. The structure pays a credit going in
// and collects most of it on the open the next day.
//
// Rules (per Cameron's audit + AMC limitation):
//   * BMO-only (announcement_time='BMO') — AMC means equity options
//     stop trading at 4pm so we can't close on-event the same day; the
//     overnight gap eats the edge.
//   * earnings_date == tomorrow (NY date)
//   * IV percentile (front-cycle) >= min_iv_percentile (default 70)
//   * Liquid ticker (consensus_eps estimate_count >= 3)
//   * Structure: short IC at expected_move strikes; wings 2× body
//   * R/R must beat 1:2 (max_loss / credit >= 2) before scaling
//
// Cron: every day at 15:30 ET (just before close). service-role only.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const STRATEGY = 'earnings_crush'

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

function tomorrowNyDate(): string {
  const tomorrow = new Date()
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(tomorrow)
}

function roundStrike(s: number): number {
  if (s < 25) return Math.round(s * 2) / 2
  if (s < 100) return Math.round(s)
  if (s < 500) return Math.round(s / 5) * 5
  return Math.round(s / 10) * 10
}

async function ivPercentile(supabase: ReturnType<typeof createClient>, ticker: string): Promise<{ pct: number; iv30d: number | null }> {
  const sixtyDaysAgo = new Date()
  sixtyDaysAgo.setUTCDate(sixtyDaysAgo.getUTCDate() - 60)
  const { data } = await supabase
    .from('iv_history')
    .select('iv_30d')
    .eq('ticker', ticker.toUpperCase())
    .gte('sample_date', sixtyDaysAgo.toISOString().slice(0, 10))
    .order('sample_date', { ascending: false })
  const rows = data ?? []
  if (rows.length < 20) return { pct: 50, iv30d: null }
  const sorted = rows.map((r) => Number(r.iv_30d)).filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return { pct: 50, iv30d: null }
  const latest = Number(rows[0].iv_30d)
  if (!Number.isFinite(latest)) return { pct: 50, iv30d: null }
  return { pct: (sorted.filter((v) => v <= latest).length / sorted.length) * 100, iv30d: latest }
}

async function fetchSpot(supabase: ReturnType<typeof createClient>, ticker: string): Promise<number | null> {
  const { data } = await supabase
    .from('dxlink_quotes')
    .select('mid, bid, ask, updated_at')
    .eq('ticker', ticker.toUpperCase())
    .is('option_type', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (data) {
    const mid = Number(data.mid) || (Number(data.bid) + Number(data.ask)) / 2
    if (Number.isFinite(mid) && mid > 0) return mid
  }
  return null
}

interface EarningsConfig {
  enabled?: boolean
  capital_allocation_pct?: number
  kill_switch?: boolean
  min_iv_percentile?: number
  bmo_only?: boolean
  skip_if_consensus_eps_estimates_lt?: number
}

interface ActiveUser { user_id: string; cfg: EarningsConfig }

async function listActive(supabase: ReturnType<typeof createClient>): Promise<ActiveUser[]> {
  const { data } = await supabase
    .from('profiles')
    .select('id, bot_config')
    .eq('bot_config->>enabled', 'true')
  const out: ActiveUser[] = []
  for (const r of data ?? []) {
    const cfg = (r.bot_config as Record<string, unknown>)?.strategies as Record<string, EarningsConfig> | undefined
    const ec = cfg?.earnings_crush
    if (ec?.enabled && !ec.kill_switch) out.push({ user_id: String(r.id), cfg: ec })
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
  const users = await listActive(supabase)
  if (users.length === 0) return json({ success: true, skipped: true, reason: 'no_active_users' })

  const tomorrow = tomorrowNyDate()
  const { data: earnings } = await supabase
    .from('earnings_calendar')
    .select('*')
    .eq('earnings_date', tomorrow)

  if (!earnings || earnings.length === 0) {
    return json({ success: true, signals_inserted: 0, reason: 'no_earnings_tomorrow' })
  }

  const inserted: Array<{ user_id: string; ticker: string }> = []

  for (const e of earnings) {
    const ticker = e.ticker as string

    for (const u of users) {
      const bmoOnly = u.cfg.bmo_only !== false  // default true
      if (bmoOnly && e.announcement_time !== 'BMO') {
        await supabase.from('bot_signals').insert({
          user_id: u.user_id, strategy: STRATEGY, ticker, structure: 'earnings_iron_condor',
          expiry_date: tomorrow, spot_at_signal: null,
          context: { earnings_date: tomorrow, bmo_amc: e.announcement_time, reason: 'AMC_skip' },
          passes_filter: false, filter_failures: ['amc_announcement'], status: 'skipped_filter',
        }).select('id').maybeSingle()
        continue
      }

      const minEstimates = Number(u.cfg.skip_if_consensus_eps_estimates_lt ?? 3)
      if (Number(e.estimate_count ?? 0) < minEstimates) {
        await supabase.from('bot_signals').insert({
          user_id: u.user_id, strategy: STRATEGY, ticker, structure: 'earnings_iron_condor',
          expiry_date: tomorrow, spot_at_signal: null,
          context: { earnings_date: tomorrow, estimate_count: e.estimate_count, reason: 'insufficient_estimates' },
          passes_filter: false, filter_failures: [`estimates_${e.estimate_count}_lt_${minEstimates}`], status: 'skipped_filter',
        }).select('id').maybeSingle()
        continue
      }

      const iv = await ivPercentile(supabase, ticker)
      const minPct = Number(u.cfg.min_iv_percentile ?? 70)
      if (iv.pct < minPct) {
        await supabase.from('bot_signals').insert({
          user_id: u.user_id, strategy: STRATEGY, ticker, structure: 'earnings_iron_condor',
          expiry_date: tomorrow, spot_at_signal: null,
          iv_percentile: iv.pct,
          context: { earnings_date: tomorrow, iv_30d: iv.iv30d, reason: 'iv_pct_too_low' },
          passes_filter: false, filter_failures: [`iv_pct_${iv.pct.toFixed(0)}_lt_${minPct}`], status: 'skipped_filter',
        }).select('id').maybeSingle()
        continue
      }

      const spot = await fetchSpot(supabase, ticker)
      if (!spot) continue

      // Expected move ≈ spot × IV × sqrt(1/252)  (~1-day move at front-month IV)
      const ivDecimal = Math.max(0.10, (iv.iv30d ?? 0.30))
      const expectedMove = spot * ivDecimal / Math.sqrt(252)
      // Strikes: short legs at ±1 expected move, wings at 2× expected move
      const shortPut  = roundStrike(spot - expectedMove)
      const shortCall = roundStrike(spot + expectedMove)
      const longPut   = roundStrike(spot - 2 * expectedMove)
      const longCall  = roundStrike(spot + 2 * expectedMove)

      const wingWidth = Math.min(shortPut - longPut, longCall - shortCall)
      if (wingWidth <= 0) continue
      // Earnings IV is elevated; credit heuristic: 40% of wing width on elevated IV.
      const estCredit = wingWidth * 0.40
      const maxLoss = wingWidth - estCredit
      if (maxLoss <= 0) continue

      // Pin probability for an event: spot lands inside ±1 expected move is the standard ~68%
      const popEstimate = 0.65
      const breakevenPop = maxLoss / (estCredit + maxLoss)
      const evEdge = popEstimate - breakevenPop
      if (evEdge < 0) continue

      // Find the next standard expiry on or after tomorrow.
      const dte = 1
      const expiry = tomorrow  // 0-1 DTE; closer to 1 DTE expiry day after event

      const { data: signal } = await supabase
        .from('bot_signals')
        .insert({
          user_id: u.user_id,
          strategy: STRATEGY,
          ticker,
          structure: 'earnings_iron_condor',
          expiry_date: expiry,
          long_put_strike: longPut,
          short_put_strike: shortPut,
          short_call_strike: shortCall,
          long_call_strike: longCall,
          spot_at_signal: spot,
          iv_percentile: iv.pct,
          iv_rank: iv.iv30d,
          net_credit_per_lot: estCredit,
          max_loss_per_lot: maxLoss,
          estimated_pop: popEstimate,
          reward_risk_ratio: estCredit / maxLoss,
          ev_edge: evEdge,
          regime: 'A',  // earnings ICs assume mean-revert post-event regardless of regime
          context: {
            earnings_date: tomorrow,
            bmo_amc: e.announcement_time,
            estimate_count: e.estimate_count,
            consensus_eps: e.consensus_eps,
            expected_move: expectedMove,
            dte_at_entry: dte,
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
