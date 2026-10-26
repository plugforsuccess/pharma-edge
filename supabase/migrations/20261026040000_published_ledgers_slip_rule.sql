-- Published ledgers + the slip rule (owner, 2026-10-26: "nobody else's AIRJ
-- gets a ledger until they build one" / "kill on a slip lives in my head").
-- published: an admin's ledger rows become readable by every subscriber
-- (general information — dates management gave, the same for everyone);
-- a trigger clears the flag for anyone who isn't an admin. slip_rule: the
-- user's own rule, in their words, stated back to them on Home when a
-- promise slips. Never advice: the app repeats what the user wrote.
alter table public.holding_milestones add column if not exists published boolean not null default false;
alter table public.leaps_tax_profiles add column if not exists slip_rule text;
create policy holding_milestones_select_published on public.holding_milestones for select to authenticated using (published = true);
create or replace function public.holding_milestones_publish_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.published and not exists (select 1 from public.profiles p where p.id = new.user_id and p.is_admin) then
    new.published := false;
  end if;
  return new;
end $$;
create trigger holding_milestones_publish_guard before insert or update on public.holding_milestones for each row execute function public.holding_milestones_publish_guard();
