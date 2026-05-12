// Whale-print qualification filter.
//
// Mirrors the entry-filter contract in src/utils/botRiskEval.js — we
// can't import that module here (it's an .js with React imports), so
// the canonical filter rules are duplicated. Any change to entry
// criteria has to land in both files.
//
// Rules (all configurable per-user via bot_config):
//   * premium_dollars      >= min_premium_dollars  (default 500k)
//   * side                  ∈ {buy, sell}          (mid prints rejected)
//   * |otm_pct|             ∈ [min_otm_pct, max_otm_pct]
//   * dte                   ∈ [min_dte, max_dte]
//   * vol_oi_ratio          >= min_vol_oi_ratio    (default 2)
//   * bid_ask_spread_pct    <= max_bid_ask_pct     (default 10)
//   * iv_rank               <= max_iv_rank         (default 60)
//   * weekly_stock_move_pct <= max_weekly_stock_move_pct (default 30)
//   * stock_daily_volume_dollars >= min_stock_daily_volume_dollars (default 50M)
//   * NOT in earnings_skip_window_days
//   * NOT on event_block_days

export interface FilterConfig {
  min_premium_dollars: number
  min_otm_pct: number
  max_otm_pct: number
  min_dte: number
  max_dte: number
  min_vol_oi_ratio: number
  max_bid_ask_pct: number
  max_iv_rank: number
  max_weekly_stock_move_pct: number
  min_stock_daily_volume_dollars: number
  earnings_skip_window_days: number
  event_block_days: string[]
}

export interface PrintCandidate {
  ticker: string
  option_type: 'C' | 'P'
  strike: number
  expiry: string
  premium_dollars: number
  contracts: number
  side: 'buy' | 'sell' | 'mid'
  bid: number
  ask: number
  mid: number
  spot: number
  otm_pct: number
  dte: number
  vol_oi_ratio: number
  iv_rank: number
  is_sweep: boolean
  is_single_leg: boolean
  weekly_stock_move_pct?: number
  stock_daily_volume_dollars?: number
  next_earnings_date?: string | null
  on_event_block_day?: boolean
  uw_trade_id: string
  spot_at_print?: number
}

export interface FilterResult {
  passes: boolean
  failures: string[]
}

export function qualify(p: PrintCandidate, c: FilterConfig): FilterResult {
  const failures: string[] = []

  if (p.premium_dollars < c.min_premium_dollars) {
    failures.push(`premium $${p.premium_dollars.toFixed(0)} < $${c.min_premium_dollars}`)
  }
  if (p.side === 'mid') failures.push('mid_print')

  const absOtm = Math.abs(p.otm_pct)
  if (absOtm < c.min_otm_pct) failures.push(`otm ${absOtm.toFixed(1)}% < ${c.min_otm_pct}%`)
  if (absOtm > c.max_otm_pct) failures.push(`otm ${absOtm.toFixed(1)}% > ${c.max_otm_pct}%`)

  if (p.dte < c.min_dte) failures.push(`dte ${p.dte} < ${c.min_dte}`)
  if (p.dte > c.max_dte) failures.push(`dte ${p.dte} > ${c.max_dte}`)

  if (p.vol_oi_ratio < c.min_vol_oi_ratio) {
    failures.push(`vol/oi ${p.vol_oi_ratio.toFixed(2)} < ${c.min_vol_oi_ratio}`)
  }

  if (p.ask > 0 && p.bid >= 0) {
    const spread = ((p.ask - p.bid) / Math.max(p.ask, 0.01)) * 100
    if (spread > c.max_bid_ask_pct) {
      failures.push(`spread ${spread.toFixed(1)}% > ${c.max_bid_ask_pct}%`)
    }
  }

  if (Number.isFinite(p.iv_rank) && p.iv_rank > c.max_iv_rank) {
    failures.push(`iv_rank ${p.iv_rank.toFixed(0)} > ${c.max_iv_rank}`)
  }

  if (p.weekly_stock_move_pct !== undefined &&
      Math.abs(p.weekly_stock_move_pct) > c.max_weekly_stock_move_pct) {
    failures.push(`week_move ${p.weekly_stock_move_pct.toFixed(1)}% > ${c.max_weekly_stock_move_pct}%`)
  }

  if (p.stock_daily_volume_dollars !== undefined &&
      p.stock_daily_volume_dollars < c.min_stock_daily_volume_dollars) {
    failures.push(`stock_vol $${p.stock_daily_volume_dollars.toFixed(0)} < $${c.min_stock_daily_volume_dollars}`)
  }

  if (p.next_earnings_date) {
    const days = Math.floor(
      (new Date(p.next_earnings_date).getTime() - Date.now()) / 86_400_000,
    )
    if (days >= 0 && days <= c.earnings_skip_window_days) {
      failures.push(`earnings_in_${days}d`)
    }
  }

  if (p.on_event_block_day) failures.push('event_block_day')

  return { passes: failures.length === 0, failures }
}
