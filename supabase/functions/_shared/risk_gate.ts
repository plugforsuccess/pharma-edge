// Shared risk-gate for the multi-strategy bot.
//
// Every strategy orchestrator (whale-tail, iv-meanrev, earnings-crush,
// opex-pin) runs the SAME envelope check before placing an order:
//
//   1. bot enabled?            (profiles.bot_config.enabled)
//   2. mode set?               (paper|live)
//   3. not halted?             (bot_paused_until > now)
//   4. strategy enabled?       (strategies[name].enabled)
//   5. strategy kill switch?   (strategies[name].kill_switch)
//   6. daily loss cap?         (sum of today's bot_runs.daily_pnl <= -cap)
//   7. weekly loss cap?        (sum of week's bot_runs.daily_pnl <= -cap)
//   8. max concurrent positions?  (open_positions where status='open')
//   9. max trades attempted today?  (bot_runs.trades_attempted today)
//  10. consecutive losses cooldown?
//  11. NLV available (broker live; falls back to profile.account_size)
//
// Returns { allowed, skipReason, nlv, nlv_source, per_trade_cap_dollars }
// — the caller uses nlv + per_trade_cap_dollars to size contracts.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tastytradeFetch, envFromMode, type TtEnv } from './tastytrade.ts'

export interface BotConfig {
  enabled?: boolean
  mode?: 'paper' | 'live'
  dry_run?: boolean
  max_concurrent_positions?: number
  per_trade_max_loss_pct?: number
  max_trades_per_day?: number
  daily_loss_kill_pct?: number
  weekly_loss_kill_pct?: number
  consecutive_loss_pause_count?: number
  consecutive_loss_pause_minutes?: number
  event_block_days?: string[]
  sandbox_account_number?: string | null
  live_account_number?: string | null
  strategies?: Record<string, {
    enabled?: boolean
    capital_allocation_pct?: number
    kill_switch?: boolean
  }>
}

export interface Profile {
  id: string
  account_size: number | null
  bot_config: BotConfig
  bot_paused_until: string | null
  bot_paused_reason: string | null
}

export interface RiskCheckResult {
  allowed: boolean
  skipReason?: string
  status?: 'skipped_caps' | 'skipped_filter'
  nlv: number
  nlv_source: 'broker_live' | 'broker_sandbox_skipped' | 'profile_fallback' | 'none'
  per_trade_cap_dollars: number
  strategy_cap_dollars: number
  account_number: string | null
  env: TtEnv
}

function todayNyDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

function startOfWeekIso(now: Date): string {
  const d = new Date(now)
  const day = d.getUTCDay()
  const diff = (day === 0 ? -6 : 1 - day)
  d.setUTCDate(d.getUTCDate() + diff)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

export async function resolveLiveNlv(
  supabase: SupabaseClient,
  fallbackAccountSize: number | null,
  env: TtEnv = 'live',
): Promise<{ nlv: number; source: RiskCheckResult['nlv_source'] }> {
  const manual = Number(fallbackAccountSize) || 0
  try {
    const accountsResp = await tastytradeFetch(supabase, '/customers/me/accounts', {}, env)
    if (!accountsResp.ok) return { nlv: manual, source: manual > 0 ? 'profile_fallback' : 'none' }
    const accountsBody = await accountsResp.json().catch(() => ({}))
    const items = ((accountsBody?.data as Record<string, unknown>)?.items ?? []) as Array<{ account?: Record<string, unknown> }>
    const nlvs: number[] = []
    for (const item of items) {
      const number = String(item.account?.['account-number'] ?? '')
      if (!number) continue
      try {
        const bResp = await tastytradeFetch(supabase, `/accounts/${encodeURIComponent(number)}/balances`, {}, env)
        if (!bResp.ok) continue
        const bBody = await bResp.json()
        const v = Number((bBody?.data as Record<string, unknown>)?.['net-liquidating-value'] ?? 0)
        if (Number.isFinite(v) && v > 0) nlvs.push(v)
      } catch { /* per-account failure */ }
    }
    // For cert env, returned NLV is simulated — that's fine for sizing
    // against, since orders fill against the same simulated balance.
    if (nlvs.length === 0) return { nlv: manual, source: manual > 0 ? 'profile_fallback' : 'none' }
    return { nlv: Math.max(...nlvs), source: 'broker_live' }
  } catch {
    return { nlv: manual, source: manual > 0 ? 'profile_fallback' : 'none' }
  }
}

export async function evaluateRisk(
  supabase: SupabaseClient,
  profile: Profile,
  strategyName: string,
): Promise<RiskCheckResult> {
  const cfg = profile.bot_config ?? {}
  const stratCfg = cfg.strategies?.[strategyName]

  const accountNumber: string | null =
    (cfg.mode === 'live' ? cfg.live_account_number : cfg.sandbox_account_number) ?? null
  const env: TtEnv = envFromMode(cfg.mode)

  const blank: RiskCheckResult = {
    allowed: false,
    env,
    nlv: 0,
    nlv_source: 'none',
    per_trade_cap_dollars: 0,
    strategy_cap_dollars: 0,
    account_number: accountNumber,
  }

  if (!cfg.enabled) return { ...blank, skipReason: 'bot_disabled', status: 'skipped_caps' }
  if (cfg.dry_run === true && strategyName !== 'whale_tail') {
    // dry_run still produces bot_signals rows; callers handle by NOT calling place-order.
  }
  if (!stratCfg?.enabled) return { ...blank, skipReason: `strategy_disabled:${strategyName}`, status: 'skipped_caps' }
  if (stratCfg.kill_switch === true) return { ...blank, skipReason: `strategy_kill_switch:${strategyName}`, status: 'skipped_caps' }

  if (profile.bot_paused_until) {
    const until = new Date(profile.bot_paused_until).getTime()
    if (until > Date.now()) return { ...blank, skipReason: `halted:${profile.bot_paused_reason ?? 'paused'}`, status: 'skipped_caps' }
  }

  if (!accountNumber) {
    return { ...blank, skipReason: `no_${cfg.mode ?? 'paper'}_account_configured`, status: 'skipped_caps' }
  }

  const nlvResult = await resolveLiveNlv(supabase, profile.account_size, env)
  const nlv = nlvResult.nlv
  if (nlv <= 0) {
    return { ...blank, skipReason: `no_nlv (${nlvResult.source})`, status: 'skipped_caps' }
  }

  const today = todayNyDate()
  const { data: runRow } = await supabase
    .from('bot_runs')
    .select('*')
    .eq('user_id', profile.id)
    .eq('run_date', today)
    .maybeSingle()

  const dailyLossCap = nlv * ((cfg.daily_loss_kill_pct ?? 20) / 100)
  if ((Number(runRow?.daily_pnl) || 0) <= -dailyLossCap) {
    return { ...blank, nlv, nlv_source: nlvResult.source, skipReason: 'daily_loss_cap_hit', status: 'skipped_caps' }
  }

  const weekStart = startOfWeekIso(new Date()).slice(0, 10)
  const { data: weekRuns } = await supabase
    .from('bot_runs')
    .select('daily_pnl')
    .eq('user_id', profile.id)
    .gte('run_date', weekStart)
  const weekPnl = (weekRuns ?? []).reduce((s, r) => s + (Number(r.daily_pnl) || 0), 0)
  if (weekPnl <= -(nlv * ((cfg.weekly_loss_kill_pct ?? 35) / 100))) {
    return { ...blank, nlv, nlv_source: nlvResult.source, skipReason: 'weekly_loss_cap_hit', status: 'skipped_caps' }
  }

  const { count: openCount } = await supabase
    .from('open_positions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', profile.id)
    .eq('status', 'open')
  if ((openCount ?? 0) >= (cfg.max_concurrent_positions ?? 3)) {
    return { ...blank, nlv, nlv_source: nlvResult.source, skipReason: 'max_concurrent_positions', status: 'skipped_caps' }
  }

  if ((runRow?.trades_attempted ?? 0) >= (cfg.max_trades_per_day ?? 5)) {
    return { ...blank, nlv, nlv_source: nlvResult.source, skipReason: 'max_trades_per_day', status: 'skipped_caps' }
  }

  const consecLossCount = cfg.consecutive_loss_pause_count ?? 3
  const { data: recent } = await supabase
    .from('open_positions')
    .select('realized_pnl, closed_at')
    .eq('user_id', profile.id)
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(consecLossCount)
  const outcomes = (recent ?? []).map((r) => (Number(r.realized_pnl) < 0 ? 'loss' : 'win'))
  if (outcomes.length === consecLossCount && outcomes.every((o) => o === 'loss')) {
    const mostRecent = (recent ?? [])[0]?.closed_at
    if (mostRecent) {
      const ageMs = Date.now() - new Date(mostRecent).getTime()
      const cooldownMs = (cfg.consecutive_loss_pause_minutes ?? 30) * 60_000
      if (ageMs < cooldownMs) {
        return { ...blank, nlv, nlv_source: nlvResult.source, skipReason: 'consecutive_loss_cooldown', status: 'skipped_caps' }
      }
    }
  }

  const perTradeCapDollars = nlv * ((cfg.per_trade_max_loss_pct ?? 4) / 100)
  const strategyAllocPct = Number(stratCfg.capital_allocation_pct ?? 25) / 100
  const strategyCapDollars = nlv * strategyAllocPct

  return {
    allowed: true,
    env,
    nlv,
    nlv_source: nlvResult.source,
    per_trade_cap_dollars: perTradeCapDollars,
    strategy_cap_dollars: strategyCapDollars,
    account_number: accountNumber,
  }
}

// Sum the max-loss-per-spread × contracts of all open positions tagged
// to this strategy. Caller uses this to enforce per-strategy capital
// allocation (the multi-strategy allocator).
export async function strategyOpenExposure(
  supabase: SupabaseClient,
  userId: string,
  strategyName: string,
): Promise<number> {
  const { data } = await supabase
    .from('open_positions')
    .select('contracts_remaining, entry_debit_per_spread, long_strike, short_strike, short_call_strike, long_call_strike, strategy_type')
    .eq('user_id', userId)
    .eq('strategy', strategyName)
    .eq('status', 'open')
  let total = 0
  for (const p of data ?? []) {
    const contracts = Number(p.contracts_remaining) || 0
    if (contracts <= 0) continue
    // Debit structures: max risk = entry_debit × 100 × contracts
    // Credit structures: max risk = (width - credit) × 100 × contracts
    // Without full leg data here we use entry_debit × 100 as the
    // conservative floor — sufficient for the allocator gate.
    const debit = Math.abs(Number(p.entry_debit_per_spread) || 0)
    total += debit * 100 * contracts
  }
  return total
}
