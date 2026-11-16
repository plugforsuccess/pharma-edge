-- The real-quote check (owner, 2026-11-16: "Start the real quote check now").
-- One row per night per scanned stock: the bear call spread the short-window
-- test priced with a formula (sell the at-the-money call, buy the call one
-- expected move higher, ~30 days out), priced again on real quotes for the
-- listed strikes. Written by scripts/quote-check.mjs (service role); research
-- data, authenticated SELECT.
create table if not exists public.quote_checks (
  as_of        date        not null,
  ticker       text        not null,
  source       text        not null default 'yahoo',
  spot         numeric,
  expiry       date,
  dte          integer,
  k1           numeric,
  k2           numeric,
  width        numeric,
  model_vol    numeric,
  iv1          numeric,
  model_credit numeric,
  real_mid     numeric,
  real_natural numeric,
  gap          numeric,
  bid1 numeric, ask1 numeric, bid2 numeric, ask2 numeric,
  oi1 numeric, oi2 numeric,
  quoted       boolean     not null default false,
  reason       text,
  signal       jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  primary key (as_of, ticker, source)
);
alter table public.quote_checks enable row level security;
create policy quote_checks_select_auth on public.quote_checks for select to authenticated using (true);
