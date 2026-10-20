-- Cash-flow quality on Leaders (owner, 2026-10-20: the check that passed the
-- basket test, "Filter: only passers listed") and the forward record of the
-- strongest-10 quality basket ("Yes, start it").
--
-- company_quality: one row per ticker the nightly ranking checked — the
--   latest annual report's verdict (src/utils/quality.js) and every past
--   step (one per 10-K filing) so the leader record judges each join on the
--   report on file that day. Kept when SEC can't be reached, so a bad night
--   reuses the last known verdict instead of emptying the list. Shared market
--   data: authenticated SELECT, service-role write.
--
-- basket_record: the strongest 10 quality leaders, logged every close from
--   the first full run on — no backfill. Members change only on the first
--   close of a month (as tested); closes are each member's close that day,
--   aligned with tickers. Append-only (append_only_fn, the service role
--   included); row_hash = SHA-256 of the canonical fields, set by trigger.

create table if not exists public.company_quality (
  ticker          text primary key,
  checked_on      date not null,
  rule            text not null check (rule in ('standard', 'oil', 'fund')),
  known           boolean not null default false,
  pass            boolean not null default false,
  misses          text[] not null default '{}',
  fcf_margin      double precision,
  net_debt_years  double precision,
  share_growth    double precision,
  period_end      date,
  why             text,
  steps           jsonb,
  updated_at      timestamptz not null default now()
);
alter table public.company_quality enable row level security;
drop policy if exists company_quality_select_authenticated on public.company_quality;
create policy company_quality_select_authenticated on public.company_quality for select to authenticated using (true);

create table if not exists public.basket_record (
  basket      text not null,
  as_of       date not null,
  tickers     text[] not null,
  closes      double precision[] not null,
  spy_close   double precision,
  rebalanced  boolean not null default false,
  row_hash    text,
  created_at  timestamptz not null default now(),
  primary key (basket, as_of),
  check (cardinality(tickers) = cardinality(closes))
);

create or replace function public.basket_record_canonical(r public.basket_record) returns text
language sql immutable set search_path = public as $$
  select '[' || to_json(r.basket)::text || ',' || to_json(r.as_of::text)::text || ',' || to_json(r.tickers)::text || ','
    || to_json(r.closes)::text || ',' || coalesce(to_json(r.spy_close)::text, 'null') || ',' || to_json(r.rebalanced)::text || ']'
$$;

create or replace function public.basket_record_hash_fn() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  new.row_hash := encode(extensions.digest(public.basket_record_canonical(new), 'sha256'), 'hex');
  return new;
end $$;
drop trigger if exists basket_record_hash on public.basket_record;
create trigger basket_record_hash before insert on public.basket_record for each row execute function public.basket_record_hash_fn();
drop trigger if exists basket_record_append_only on public.basket_record;
create trigger basket_record_append_only before update or delete on public.basket_record for each row execute function public.append_only_fn();

alter table public.basket_record enable row level security;
drop policy if exists basket_record_select_authenticated on public.basket_record;
create policy basket_record_select_authenticated on public.basket_record for select to authenticated using (true);
