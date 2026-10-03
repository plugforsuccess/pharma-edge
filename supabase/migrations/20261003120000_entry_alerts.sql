-- Entry alerts (owner, 2026-10-03: "ensure the next entry").
-- The entry-scan edge function checks each user's watchlist + holdings
-- tickers once a day after the close and writes one alert per entry:
--   entry_buy_zone        the LEAPS buy zone turned YES (default thresholds)
--   entry_hardening_bull  a weekly Hardening bull fired (completed week)
-- ticker + event_date identify the entry (the buy-zone cluster's first day,
-- or the Hardening week's start), and the unique index makes each alert
-- fire once per user (older alerts have a NULL ticker, and NULLs never
-- collide, so they're unaffected; a full — not partial — index so the edge
-- function's upsert can target it). Additive only: new alert types, two nullable
-- columns, an index, and a per-user opt-out. RLS on alerts is unchanged.

alter table public.alerts drop constraint if exists alerts_alert_type_check;
alter table public.alerts add constraint alerts_alert_type_check check (alert_type = any (array[
  'catalyst_approaching_14d', 'catalyst_approaching_7d', 'catalyst_tomorrow', 'outcome_reminder',
  'stop_loss_triggered', 'position_stop_loss', 'position_profit_50', 'position_profit_100',
  'position_profit_200', 'position_dte_21', 'position_expiring_tomorrow', 'position_filled',
  'position_closed', 'position_regime_shift', 'position_thesis_drifting',
  'position_thesis_invalidated', 'position_thesis_recovered',
  'entry_buy_zone', 'entry_hardening_bull'
]::text[]));

alter table public.alerts add column if not exists ticker text;
alter table public.alerts add column if not exists event_date date;

create unique index if not exists alerts_entry_once
  on public.alerts (user_id, alert_type, ticker, event_date);

-- Per-user switch (Settings → Entry alerts). On by default.
alter table public.profiles add column if not exists entry_alerts boolean not null default true;
