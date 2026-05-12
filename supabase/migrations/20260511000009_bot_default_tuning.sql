-- Tune bot defaults per the entry-filter + risk-cap audit:
--   per_trade_max_loss_pct: 10 → 4   (quarter-Kelly for unverified edge)
--   max_trades_per_day:      3 → 5   (faster data collection in paper window)
--   max_dte:                45 → 60  (capture more institutional conviction trades)
--
-- Update both the column DEFAULT (so new profiles get the new values)
-- AND existing rows where the field still equals the old default
-- (preserves any manual user customizations).

ALTER TABLE public.profiles
  ALTER COLUMN bot_config SET DEFAULT '{
    "enabled": false,
    "mode": "paper",
    "max_concurrent_positions": 3,
    "max_concurrent_exposure_pct": 30,
    "per_trade_max_loss_pct": 4,
    "max_trades_per_day": 5,
    "daily_loss_kill_pct": 20,
    "weekly_loss_kill_pct": 35,
    "consecutive_loss_pause_count": 3,
    "consecutive_loss_pause_minutes": 30,
    "min_premium_dollars": 500000,
    "min_otm_pct": 5,
    "max_otm_pct": 30,
    "min_dte": 7,
    "max_dte": 60,
    "min_vol_oi_ratio": 2,
    "max_bid_ask_pct": 10,
    "entry_window_start": "10:30",
    "entry_window_end": "15:30",
    "max_iv_rank": 60,
    "max_weekly_stock_move_pct": 30,
    "min_stock_daily_volume_dollars": 50000000,
    "event_block_days": ["FOMC", "CPI", "NFP", "OPEX"],
    "earnings_skip_window_days": 7,
    "sandbox_account_number": null,
    "live_account_number": null
  }'::jsonb;

-- Backfill existing rows: only update fields that still match the
-- old defaults. Anyone who's already customized stays customized.

UPDATE public.profiles
SET bot_config = bot_config || jsonb_build_object('per_trade_max_loss_pct', 4)
WHERE (bot_config->>'per_trade_max_loss_pct')::numeric = 10;

UPDATE public.profiles
SET bot_config = bot_config || jsonb_build_object('max_trades_per_day', 5)
WHERE (bot_config->>'max_trades_per_day')::numeric = 3;

UPDATE public.profiles
SET bot_config = bot_config || jsonb_build_object('max_dte', 60)
WHERE (bot_config->>'max_dte')::numeric = 45;
