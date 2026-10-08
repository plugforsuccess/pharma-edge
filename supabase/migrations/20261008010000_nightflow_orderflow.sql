-- NIGHTFLOW — Order Flow Intelligence Engine.
-- Market data, not user data: authenticated SELECT, service-role writes
-- (the dxlink-worker). The watchlist is owner-managed (profiles.is_admin).
-- Monitoring only — nothing here places orders.

create table if not exists public.orderflow_watchlist (
  symbol text primary key check (symbol ~ '^[A-Z][A-Z0-9.\-]{0,9}$'),
  active boolean not null default true,
  note text,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now()
);

-- Raw prints (dxFeed TimeAndSale) kept for replay and validation.
create table if not exists public.orderflow_prints (
  id bigint generated always as identity primary key,
  symbol text not null,
  t_ms bigint not null,
  price numeric not null,
  size numeric not null,
  type text not null default 'NEW',        -- NEW / CORRECTION / CANCEL
  src_id text,                             -- dxFeed index (for corrections / cancels)
  bid numeric, ask numeric,                -- NBBO stamped on the print
  exch text, conds text,
  eth boolean, valid boolean,
  aggressor text,                          -- feed-reported aggressor side, if any (diagnostic)
  source text not null default 'dxfeed_tastytrade'
);
create index if not exists orderflow_prints_symbol_t on public.orderflow_prints (symbol, t_ms);

-- NBBO updates (≤ 4 per second per symbol) for replay.
create table if not exists public.orderflow_quotes (
  id bigint generated always as identity primary key,
  symbol text not null,
  t_ms bigint not null,
  bid numeric, ask numeric,
  bid_size numeric, ask_size numeric,
  source text not null default 'dxfeed_tastytrade'
);
create index if not exists orderflow_quotes_symbol_t on public.orderflow_quotes (symbol, t_ms);

-- Latest engine snapshot per symbol (the live dashboard; realtime).
create table if not exists public.orderflow_state (
  symbol text primary key,
  t timestamptz not null,
  session text,
  status text,
  source text not null,
  snapshot jsonb not null
);

create table if not exists public.orderflow_alerts (
  id text primary key,
  symbol text not null,
  t timestamptz not null,
  type text not null,
  severity smallint not null,
  title text not null,
  evidence jsonb not null,
  quote_quality text,
  session text,
  source text not null,
  limitations jsonb not null
);
create index if not exists orderflow_alerts_symbol_t on public.orderflow_alerts (symbol, t desc);

-- SEC filing / float cache (orderflow-dilution edge function).
create table if not exists public.orderflow_dilution (
  symbol text primary key,
  checked_at timestamptz not null default now(),
  cik text,
  level text,
  score numeric,
  summary text,
  hits jsonb,
  float_shares numeric,
  shares_outstanding numeric
);

alter table public.orderflow_watchlist enable row level security;
alter table public.orderflow_prints enable row level security;
alter table public.orderflow_quotes enable row level security;
alter table public.orderflow_state enable row level security;
alter table public.orderflow_alerts enable row level security;
alter table public.orderflow_dilution enable row level security;

create policy orderflow_watchlist_select on public.orderflow_watchlist for select to authenticated using (true);
create policy orderflow_watchlist_admin_insert on public.orderflow_watchlist for insert to authenticated
  with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin));
create policy orderflow_watchlist_admin_update on public.orderflow_watchlist for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin));
create policy orderflow_watchlist_admin_delete on public.orderflow_watchlist for delete to authenticated
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin));
create policy orderflow_prints_select on public.orderflow_prints for select to authenticated using (true);
create policy orderflow_quotes_select on public.orderflow_quotes for select to authenticated using (true);
create policy orderflow_state_select on public.orderflow_state for select to authenticated using (true);
create policy orderflow_alerts_select on public.orderflow_alerts for select to authenticated using (true);
create policy orderflow_dilution_select on public.orderflow_dilution for select to authenticated using (true);

alter publication supabase_realtime add table public.orderflow_state;
alter publication supabase_realtime add table public.orderflow_alerts;
