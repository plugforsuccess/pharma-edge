-- Market intelligence (owner, 2026-10-19: "the leaders, their momentum, the
-- market and risks signaled by government, geopolitical and economic news").

-- One row per close: S&P trend, breadth, leader count and groups, VIX.
-- Written by scripts/rank-confluence.mjs. Shared market data.
create table if not exists public.market_pulse (
  as_of        date primary key,
  spy_close    numeric,
  spy_200      numeric,
  spy_vs200    numeric,
  spy_slope200 numeric,
  spy_above    boolean,
  spy_1m       numeric,
  vix          numeric,
  vix_5d       numeric,
  universe     integer,
  above200     integer,
  breadth      numeric,
  leaders      integer,
  groups       jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);
alter table public.market_pulse enable row level security;
drop policy if exists market_pulse_select_authenticated on public.market_pulse;
create policy market_pulse_select_authenticated on public.market_pulse for select to authenticated using (true);

-- Scheduled US economic releases and Fed meetings, from the agencies' own
-- calendars (scripts/econ-calendar.mjs). Shared market data.
create table if not exists public.econ_events (
  kind        text not null,          -- fomc | cpi | jobs | ppi | gdp | pce | jolts
  event_date  date not null,
  event_time  text,                   -- '08:30' / '14:00' ET, null when unknown
  title       text not null,
  source      text not null,          -- fed | bls | bea
  url         text,
  updated_at  timestamptz not null default now(),
  primary key (kind, event_date)
);
alter table public.econ_events enable row level security;
drop policy if exists econ_events_select_authenticated on public.econ_events;
create policy econ_events_select_authenticated on public.econ_events for select to authenticated using (true);
create index if not exists econ_events_date_idx on public.econ_events (event_date);

-- New alert kinds: a tracked leader dropped off, the market's trend turned,
-- a major release tomorrow, earnings soon on a tracked stock.
alter table public.alerts drop constraint if exists alerts_alert_type_check;
alter table public.alerts add constraint alerts_alert_type_check check (alert_type = any (array[
  'catalyst_approaching_14d', 'catalyst_approaching_7d', 'catalyst_tomorrow', 'outcome_reminder', 'stop_loss_triggered',
  'position_stop_loss', 'position_profit_50', 'position_profit_100', 'position_profit_200', 'position_dte_21',
  'position_expiring_tomorrow', 'position_filled', 'position_closed', 'position_regime_shift', 'position_thesis_drifting',
  'position_thesis_invalidated', 'position_thesis_recovered', 'entry_buy_zone', 'entry_hardening_bull',
  'confluence_top_buy', 'confluence_top_sell',
  'leader_lost', 'market_trend', 'econ_tomorrow', 'earnings_soon'
]::text[]));
