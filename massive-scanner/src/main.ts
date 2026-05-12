// Cash Moves Massive (Polygon) options-flow scanner — entry point.
//
// Loop:
//   1. Check market hours
//   2. List active bot users
//   3. Scan SCAN_UNIVERSE for qualifying prints
//   4. For each print, for each user: qualify against their bot_config
//      filter, upsert whale_tail_alerts (dedupe via uw_trade_id), and
//      if passes_filter, fire bot-execute-entry
//   5. Sleep, repeat
//
// Service-role only. Long-running process on Fly.io.

import { scanUniverse } from './scanner.ts'
import { qualify, type FilterConfig } from './filter.ts'
import { SCAN_UNIVERSE } from './universe.ts'
import {
  listActiveBotUsers,
  upsertWhaleTailAlert,
  triggerExecuteEntry,
  getEarningsDate,
  type BotConfig,
} from './supabase.ts'

const POLL_RTH = Number(Deno.env.get('POLL_INTERVAL_MS_RTH') || '5000')
const POLL_OFF = Number(Deno.env.get('POLL_INTERVAL_MS_OFF') || '60000')
const SCANNER_USER_IDS = (Deno.env.get('SCANNER_USER_IDS') || '').split(',').map((s) => s.trim()).filter(Boolean)

let running = true

function isMarketHours(now = new Date()): boolean {
  // NY time: Mon-Fri 09:30-16:00
  const nyStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).format(now)
  // e.g. "Mon, 09:31"
  const m = nyStr.match(/(\w+),?\s+(\d{1,2}):(\d{2})/)
  if (!m) return false
  const [, dow, hStr, mnStr] = m
  if (['Sat','Sun'].includes(dow)) return false
  const h = Number(hStr); const mn = Number(mnStr)
  const min = h * 60 + mn
  return min >= 9 * 60 + 30 && min <= 16 * 60
}

function configToFilter(c: BotConfig): FilterConfig {
  return {
    min_premium_dollars:           Number(c.min_premium_dollars ?? 500_000),
    min_otm_pct:                   Number(c.min_otm_pct ?? 5),
    max_otm_pct:                   Number(c.max_otm_pct ?? 30),
    min_dte:                       Number(c.min_dte ?? 7),
    max_dte:                       Number(c.max_dte ?? 60),
    min_vol_oi_ratio:              Number(c.min_vol_oi_ratio ?? 2),
    max_bid_ask_pct:               Number(c.max_bid_ask_pct ?? 10),
    max_iv_rank:                   Number(c.max_iv_rank ?? 60),
    max_weekly_stock_move_pct:     Number(c.max_weekly_stock_move_pct ?? 30),
    min_stock_daily_volume_dollars: Number(c.min_stock_daily_volume_dollars ?? 50_000_000),
    earnings_skip_window_days:     Number(c.earnings_skip_window_days ?? 7),
    event_block_days:              Array.isArray(c.event_block_days) ? c.event_block_days as string[] : [],
  }
}

async function loop() {
  while (running) {
    const rth = isMarketHours()
    const interval = rth ? POLL_RTH : POLL_OFF
    if (!rth) {
      await sleep(interval)
      continue
    }

    try {
      const users = await listActiveBotUsers(SCANNER_USER_IDS.length ? SCANNER_USER_IDS : undefined)
      if (users.length === 0) {
        await sleep(interval)
        continue
      }

      // Use the most-permissive premium floor across all active users
      // so we don't drop prints for users whose floor is lower.
      const minPremium = Math.min(
        ...users.map((u) => Number(u.bot_config.min_premium_dollars ?? 500_000)),
      )
      const prints = await scanUniverse(SCAN_UNIVERSE, minPremium)
      if (prints.length === 0) {
        await sleep(interval)
        continue
      }

      // Earnings lookup cache (per-scan-iteration)
      const earningsByTicker = new Map<string, string | null>()
      async function nextEarnings(t: string) {
        if (earningsByTicker.has(t)) return earningsByTicker.get(t)!
        const d = await getEarningsDate(t)
        earningsByTicker.set(t, d)
        return d
      }

      for (const print of prints) {
        const earnings = await nextEarnings(print.ticker)
        for (const user of users) {
          // whale_tail strategy gate
          const wt = user.bot_config.strategies?.whale_tail
          if (wt && (wt.enabled === false || wt.kill_switch === true)) continue

          const filterCfg = configToFilter(user.bot_config)
          const result = qualify({ ...print, next_earnings_date: earnings ?? null }, filterCfg)
          const status: 'observed' | 'queued' | 'skipped_filter' =
            result.passes ? 'queued' : 'skipped_filter'

          const alertId = await upsertWhaleTailAlert({
            user_id: user.user_id,
            uw_trade_id: print.uw_trade_id,
            ticker: print.ticker,
            option_type: print.option_type,
            strike: print.strike,
            expiry_date: print.expiry,
            premium_dollars: print.premium_dollars,
            contracts: print.contracts,
            side: print.side,
            is_sweep: print.is_sweep,
            is_single_leg: print.is_single_leg,
            spot_at_print: print.spot_at_print ?? print.spot,
            otm_pct: print.otm_pct,
            dte: print.dte,
            vol_oi_ratio: print.vol_oi_ratio,
            iv_rank: print.iv_rank,
            bid: print.bid,
            ask: print.ask,
            mid: print.mid,
            passes_filter: result.passes,
            filter_failures: result.failures,
            status,
          })

          if (alertId && result.passes) {
            // Fire-and-forget; orchestrator handles risk gate + execution
            triggerExecuteEntry(alertId).catch(() => {})
          }
        }
      }
    } catch (err) {
      console.error('scanner loop error:', err)
    }

    await sleep(interval)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Graceful shutdown on SIGTERM (Fly deploys)
Deno.addSignalListener('SIGTERM', () => { running = false })
Deno.addSignalListener('SIGINT', () => { running = false })

console.log(`[scanner] starting — universe=${SCAN_UNIVERSE.length} tickers`)
await loop()
console.log('[scanner] exiting')
