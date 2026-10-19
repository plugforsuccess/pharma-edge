-- The leader record (owner, 2026-10-19: "a live record of the price gain
-- since becoming a leader"). One row per stint on the Leaders list — joined
-- in the past year or still open — rebuilt nightly by rank-confluence.mjs
-- (src/utils/leaderRecord.js). Shared market data.
create table if not exists public.leader_stints (
  as_of       date not null,
  ticker      text not null,
  joined_on   date not null,
  join_close  numeric,
  left_on     date,
  left_close  numeric,
  last_close  numeric,
  gain        numeric,
  spy_gain    numeric,
  days        int,
  open        boolean not null default false,
  theme       text,
  primary key (as_of, ticker, joined_on)
);
alter table public.leader_stints enable row level security;
drop policy if exists leader_stints_select_authenticated on public.leader_stints;
create policy leader_stints_select_authenticated on public.leader_stints for select to authenticated using (true);
