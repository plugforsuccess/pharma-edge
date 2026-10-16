-- Leaders only (owner, 2026-10-16: "We only want leaders"). The nightly
-- ranking (scripts/rank-confluence.mjs) marks each buy row with the Leaders
-- rule (src/utils/leaders.js) and ranks only leaders; the forward record logs
-- the leader entries under a new kind so earlier buy_setup rows keep their
-- meaning. Additive.
alter table public.confluence_ranks add column if not exists leader boolean;
alter table public.confluence_ranks add column if not exists leader_traits jsonb;

alter table public.setup_log drop constraint if exists setup_log_kind_check;
alter table public.setup_log add constraint setup_log_kind_check check (kind in ('momentum', 'buy_setup', 'leader'));
