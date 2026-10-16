-- Forward record: the dip swing (owner, 2026-10-16). A leader closing at
-- least 3% under its 20-day high logs the 1M at-the-money call, graded on
-- +40% on the call or 15 trading days. Paper-tracked only — never shown as a
-- suggestion. The append-only and hash triggers are unchanged.
alter table public.setup_log drop constraint if exists setup_log_kind_check;
alter table public.setup_log add constraint setup_log_kind_check check (kind in ('momentum', 'buy_setup', 'leader', 'swing_dip'));
