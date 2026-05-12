// Supabase service-role client + idempotent upserts for whale_tail_alerts.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')
}

export const supabase: SupabaseClient = createClient(
  SUPABASE_URL ?? '',
  SUPABASE_SERVICE_ROLE_KEY ?? '',
)

export interface BotConfig {
  enabled?: boolean
  mode?: 'paper' | 'live'
  strategies?: Record<string, { enabled?: boolean; kill_switch?: boolean }>
  min_premium_dollars?: number
  min_otm_pct?: number
  max_otm_pct?: number
  min_dte?: number
  max_dte?: number
  min_vol_oi_ratio?: number
  max_bid_ask_pct?: number
  max_iv_rank?: number
  max_weekly_stock_move_pct?: number
  min_stock_daily_volume_dollars?: number
  earnings_skip_window_days?: number
  event_block_days?: string[]
  [k: string]: unknown
}

export interface ActiveUser {
  user_id: string
  bot_config: BotConfig
}

export async function listActiveBotUsers(filterUserIds?: string[]): Promise<ActiveUser[]> {
  let q = supabase
    .from('profiles')
    .select('id, bot_config')
    .eq('bot_config->>enabled', 'true')
  if (filterUserIds && filterUserIds.length > 0) {
    q = q.in('id', filterUserIds)
  }
  const { data, error } = await q
  if (error) {
    console.error('listActiveBotUsers failed:', error.message)
    return []
  }
  return (data ?? []).map((r) => ({ user_id: String(r.id), bot_config: (r.bot_config ?? {}) as BotConfig }))
}

export async function upsertWhaleTailAlert(row: {
  user_id: string
  uw_trade_id: string
  ticker: string
  option_type: 'C' | 'P'
  strike: number
  expiry_date: string
  premium_dollars: number
  contracts: number
  side: 'buy' | 'sell' | 'mid'
  is_sweep: boolean
  is_single_leg: boolean
  spot_at_print: number
  otm_pct: number
  dte: number
  vol_oi_ratio: number
  iv_rank: number
  bid: number
  ask: number
  mid: number
  passes_filter: boolean
  filter_failures: string[]
  status: 'observed' | 'queued' | 'skipped_filter'
  raw_uw_payload?: Record<string, unknown>
}): Promise<string | null> {
  const { data, error } = await supabase
    .from('whale_tail_alerts')
    .upsert(row, { onConflict: 'user_id,uw_trade_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle()
  if (error) {
    if (!String(error.message).includes('duplicate')) {
      console.error('upsertWhaleTailAlert failed:', error.message)
    }
    return null
  }
  return data?.id ?? null
}

export async function triggerExecuteEntry(alertId: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/bot-execute-entry`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ alert_id: alertId }),
    })
  } catch (err) {
    console.error('triggerExecuteEntry failed:', err)
  }
}

export async function getEarningsDate(ticker: string): Promise<string | null> {
  const { data } = await supabase
    .from('earnings_calendar')
    .select('earnings_date')
    .eq('ticker', ticker.toUpperCase())
    .gte('earnings_date', new Date().toISOString().slice(0, 10))
    .order('earnings_date', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data?.earnings_date as string) ?? null
}
