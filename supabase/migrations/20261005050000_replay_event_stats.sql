-- Event stats for the entry chart (owner, 2026-10-05): for one replay rule
-- (the Triple event), how often it fired on this ticker and across the
-- universe, the stock's hit rate and median 3 / 6 / 12-month returns, and
-- the random-entry control's medians — read from replay_trades (latest run
-- that has rows for the rule). Security invoker: RLS on replay_trades
-- (authenticated SELECT) applies.
create or replace function public.replay_event_stats(p_rule text, p_ticker text)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with run as (
    select r.id, r.run_at
    from public.replay_runs r
    where exists (select 1 from public.replay_trades t where t.run_id = r.id and t.rule = p_rule)
    order by r.run_at desc
    limit 1
  ),
  rows_ as (
    select t.* from public.replay_trades t join run on run.id = t.run_id where t.rule = p_rule
  ),
  agg as (
    select
      case when t.ticker = p_ticker then 'ticker' else 'universe' end as scope,
      count(*) as n,
      avg(case when t.fwd_6m is null then null when t.fwd_6m > 0 then 1.0 else 0.0 end) as stock_hit_6m,
      avg(case when t.option_return is null then null when t.option_return > 0 then 1.0 else 0.0 end) as option_win,
      avg(t.option_return) as option_avg,
      percentile_cont(0.5) within group (order by t.fwd_3m) as med_3m,
      percentile_cont(0.5) within group (order by t.fwd_6m) as med_6m,
      percentile_cont(0.5) within group (order by t.fwd_12m) as med_12m,
      percentile_cont(0.5) within group (order by t.rand_3m) as rand_3m,
      percentile_cont(0.5) within group (order by t.rand_6m) as rand_6m,
      percentile_cont(0.5) within group (order by t.rand_12m) as rand_12m,
      count(t.fwd_6m) as graded,
      max(t.signal_date) as last_signal
    from rows_ t
    group by 1
  ),
  uni as (
    -- the universe includes this ticker
    select 'universe' as scope, count(*) as n,
      avg(case when t.fwd_6m is null then null when t.fwd_6m > 0 then 1.0 else 0.0 end) as stock_hit_6m,
      avg(case when t.option_return is null then null when t.option_return > 0 then 1.0 else 0.0 end) as option_win,
      avg(t.option_return) as option_avg,
      percentile_cont(0.5) within group (order by t.fwd_3m) as med_3m,
      percentile_cont(0.5) within group (order by t.fwd_6m) as med_6m,
      percentile_cont(0.5) within group (order by t.fwd_12m) as med_12m,
      percentile_cont(0.5) within group (order by t.rand_3m) as rand_3m,
      percentile_cont(0.5) within group (order by t.rand_6m) as rand_6m,
      percentile_cont(0.5) within group (order by t.rand_12m) as rand_12m,
      count(t.fwd_6m) as graded,
      max(t.signal_date) as last_signal,
      count(distinct t.ticker) as tickers
    from rows_ t
  )
  select jsonb_build_object(
    'run_id', (select id from run),
    'run_at', (select run_at from run),
    'rule', p_rule,
    'ticker', (select to_jsonb(a) - 'scope' from agg a where a.scope = 'ticker'),
    'universe', (select to_jsonb(u) - 'scope' from uni u)
  );
$$;
grant execute on function public.replay_event_stats(text, text) to authenticated;
