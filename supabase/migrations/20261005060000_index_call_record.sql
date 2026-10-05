-- The index call's record for Charts (owner, 2026-10-05: "index calls win —
-- are these calls displayed anywhere?"). From the latest universe run with
-- the pre-registered test: per rule at the calibrated premium, the
-- strategy's mean option return, win rate and lost-half share and the
-- SPY-same-day control's mean and lost-half; plus the `index` rule's own
-- universe stats once it has run. Security invoker (replay_runs and
-- replay_trades: authenticated SELECT).
create or replace function public.index_call_record()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with r as (
    select run_at, summary from public.replay_runs
    where summary->'prereg'->'grid' is not null
    order by run_at desc limit 1
  ),
  cal as (
    select run_at, summary, summary->'prereg'->'premium'->>'calibrated' as pm from r
  )
  select jsonb_build_object(
    'run_at', (select run_at from cal),
    'premium', (select pm from cal),
    'rules', (
      select jsonb_object_agg(e.k, jsonb_build_object(
        'n', e.v->'marked'->'all'->'n',
        'strategy', e.v->'marked'->'all'->'strategy'->'mean',
        'win', e.v->'marked'->'all'->'strategy'->'win',
        'lost_half', e.v->'marked'->'all'->'strategy'->'lostHalf',
        'spy', e.v->'marked'->'all'->'spy'->'mean',
        'spy_lost_half', e.v->'marked'->'all'->'spy'->'lostHalf',
        'dca', e.v->'marked'->'all'->'dca'->'mean',
        'dca_n', e.v->'marked'->'all'->'dca'->'n',
        'random', e.v->'marked'->'all'->'random'->'mean',
        'random_pct', e.v->'marked'->'all'->'random'->'percentile'))
      from cal, jsonb_each(cal.summary->'prereg'->'grid'->cal.pm) as e(k, v)
    ),
    'index_rule', public.replay_event_stats('index', 'SPY')->'universe'
  );
$$;
grant execute on function public.index_call_record() to authenticated;
