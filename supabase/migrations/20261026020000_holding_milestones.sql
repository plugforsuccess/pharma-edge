-- Milestone ledger (owner spec, 2026-10-26): what a company promised and
-- when, written down by the holder, later marked met / missed / delayed.
-- Per user, per ticker (a position id is optional so the ledger survives a
-- closed and reopened holding). Own rows only — the cached auth.uid() form.
create table if not exists public.holding_milestones (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  ticker        text not null,
  position_id   uuid references public.leaps_positions(id) on delete set null,
  title         text not null,
  due_date      date not null,
  status        text not null default 'pending' check (status in ('pending', 'met', 'missed', 'delayed')),
  resolved_on   date,
  new_due_date  date,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists holding_milestones_user_ticker on public.holding_milestones (user_id, ticker, due_date);
alter table public.holding_milestones enable row level security;
create policy holding_milestones_select_own on public.holding_milestones for select to authenticated using ((select auth.uid()) = user_id);
create policy holding_milestones_insert_own on public.holding_milestones for insert to authenticated with check ((select auth.uid()) = user_id);
create policy holding_milestones_update_own on public.holding_milestones for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy holding_milestones_delete_own on public.holding_milestones for delete to authenticated using ((select auth.uid()) = user_id);
