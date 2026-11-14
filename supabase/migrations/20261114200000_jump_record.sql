-- The jump record (owner, 2026-11-14: "Yes build it. Make sure we include the
-- earnings dates in your reporting"). A forward record of every fresh jump on
-- the pre-revenue scan (a close up >= 10% on >= 3x volume), logged the night it
-- happens by scripts/tape-scan.mjs, with whether it came on an earnings report
-- (SEC 8-K item 2.02) and the next report date; the price path from the jump
-- close fills in at every quarter month (1W ... 6M) as it is reached. The
-- signal fields are written once: a trigger refuses deletes and any change to
-- them, even from the service role. Market data: authenticated SELECT,
-- service-role write.

create table if not exists public.jump_record (
  ticker          text        not null,
  jump_date       date        not null,
  jump_close      numeric     not null,
  jump_pct        numeric     not null,
  logged_on       date        not null default current_date,
  earnings_jump   boolean     not null default false,
  report_date     date,
  next_report     date,
  next_report_est boolean     not null default false,
  si_pct          numeric,
  cash            numeric,
  burn            numeric,
  path            jsonb       not null default '{}'::jsonb,
  last_close      numeric,
  updated_at      timestamptz not null default now(),
  primary key (ticker, jump_date)
);

create index if not exists jump_record_jump_date on public.jump_record (jump_date desc);

alter table public.jump_record enable row level security;

create policy jump_record_select_auth on public.jump_record
  for select to authenticated using (true);

create or replace function public.jump_record_guard_fn()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'jump_record is append-only';
  end if;
  if new.ticker is distinct from old.ticker
     or new.jump_date is distinct from old.jump_date
     or new.jump_close is distinct from old.jump_close
     or new.jump_pct is distinct from old.jump_pct
     or new.logged_on is distinct from old.logged_on
     or new.earnings_jump is distinct from old.earnings_jump
     or new.report_date is distinct from old.report_date
     or new.si_pct is distinct from old.si_pct
     or new.cash is distinct from old.cash
     or new.burn is distinct from old.burn then
    raise exception 'jump_record signal fields are written once';
  end if;
  return new;
end;
$$;

create trigger jump_record_guard
  before update or delete on public.jump_record
  for each row execute function public.jump_record_guard_fn();
