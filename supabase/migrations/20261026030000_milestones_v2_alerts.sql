-- Milestone ledger v2 (owner spec, 2026-10-26): the first promised date stays
-- in due_date; current_due is the latest restatement (NULL = unchanged),
-- slips counts how many times it moved, source names where the promise was
-- made ("Q4 2025 call"), evidence what would confirm it ("8-K naming the
-- cert"). Status gains 'unmentioned' (a promise that dropped out of the
-- script — the earliest slip signal). Two alert types for the bell:
-- milestone_call_tomorrow (what the call must confirm) and
-- milestone_call_check (what is still unconfirmed the day after).
alter table public.holding_milestones
  add column if not exists current_due date,
  add column if not exists slips integer not null default 0,
  add column if not exists source text,
  add column if not exists evidence text;
alter table public.holding_milestones drop constraint if exists holding_milestones_status_check;
alter table public.holding_milestones add constraint holding_milestones_status_check
  check (status in ('pending', 'met', 'missed', 'unmentioned', 'delayed'));
alter table public.alerts drop constraint if exists alerts_alert_type_check;
alter table public.alerts add constraint alerts_alert_type_check check (alert_type = any (array[
  'catalyst_approaching_14d','catalyst_approaching_7d','catalyst_tomorrow','outcome_reminder','stop_loss_triggered',
  'position_stop_loss','position_profit_50','position_profit_100','position_profit_200','position_dte_21',
  'position_expiring_tomorrow','position_filled','position_closed','position_regime_shift','position_thesis_drifting',
  'position_thesis_invalidated','position_thesis_recovered','entry_buy_zone','entry_hardening_bull','confluence_top_buy',
  'confluence_top_sell','leader_lost','market_trend','econ_tomorrow','earnings_soon','milestone_call_tomorrow','milestone_call_check']));
