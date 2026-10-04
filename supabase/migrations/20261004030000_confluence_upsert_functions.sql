-- RPC functions for confluence ranking upserts (bypasses schema cache)

create or replace function upsert_confluence_ranks(rows jsonb)
returns void as $$
declare
  row jsonb;
begin
  for row in select * from jsonb_array_elements(rows)
  loop
    insert into confluence_ranks (
      side, ticker, as_of, close, score, lit, combo, conditions_met,
      trend_up, own_n, pool_n, est_at_turn, est_3m, est_6m, est_12m,
      est_win_6m, last_signal, etb_convergence, rank, updated_at
    ) values (
      row->>'side',
      row->>'ticker',
      (row->>'as_of')::date,
      (row->>'close')::numeric,
      (row->>'score')::int,
      (row->'lit')::text[],
      row->>'combo',
      (row->>'conditions_met')::int,
      (row->>'trend_up')::boolean,
      (row->>'own_n')::int,
      (row->>'pool_n')::int,
      (row->>'est_at_turn')::numeric,
      (row->>'est_3m')::numeric,
      (row->>'est_6m')::numeric,
      (row->>'est_12m')::numeric,
      (row->>'est_win_6m')::numeric,
      (row->>'last_signal')::date,
      (row->>'etb_convergence')::boolean,
      (row->>'rank')::int,
      now()
    ) on conflict (side, ticker) do update set
      as_of = excluded.as_of,
      close = excluded.close,
      score = excluded.score,
      lit = excluded.lit,
      combo = excluded.combo,
      conditions_met = excluded.conditions_met,
      trend_up = excluded.trend_up,
      own_n = excluded.own_n,
      pool_n = excluded.pool_n,
      est_at_turn = excluded.est_at_turn,
      est_3m = excluded.est_3m,
      est_6m = excluded.est_6m,
      est_12m = excluded.est_12m,
      est_win_6m = excluded.est_win_6m,
      last_signal = excluded.last_signal,
      etb_convergence = excluded.etb_convergence,
      rank = excluded.rank,
      updated_at = now();
end;
$$ language plpgsql security definer;

create or replace function confluence_get_top10()
returns table(side text, ticker text, rank int) as $$
  select side, ticker, rank
  from confluence_ranks
  where rank is not null and rank <= 10
  order by side, rank;
$$ language sql security definer;

create or replace function upsert_confluence_pool(rows jsonb)
returns void as $$
declare
  row jsonb;
  hz_data jsonb;
begin
  for row in select * from jsonb_array_elements(rows)
  loop
    hz_data := case when row->'horizons' is not null then row->'horizons' else '[]'::jsonb end;
    insert into confluence_pool (
      side, combo, lit, score, n, graded, at_turn, avg_3m, avg_6m, avg_12m,
      win_3m, win_6m, win_12m, tickers, as_of, updated_at, horizons
    ) values (
      row->>'side',
      row->>'combo',
      (row->'lit')::text[],
      (row->>'score')::numeric,
      (row->>'n')::int,
      (row->>'graded')::int,
      (row->>'at_turn')::numeric,
      (row->>'avg_3m')::numeric,
      (row->>'avg_6m')::numeric,
      (row->>'avg_12m')::numeric,
      (row->>'win_3m')::numeric,
      (row->>'win_6m')::numeric,
      (row->>'win_12m')::numeric,
      (row->>'tickers')::int,
      (row->>'as_of')::date,
      now(),
      hz_data
    ) on conflict (side, combo) do update set
      lit = excluded.lit,
      score = excluded.score,
      n = excluded.n,
      graded = excluded.graded,
      at_turn = excluded.at_turn,
      avg_3m = excluded.avg_3m,
      avg_6m = excluded.avg_6m,
      avg_12m = excluded.avg_12m,
      win_3m = excluded.win_3m,
      win_6m = excluded.win_6m,
      win_12m = excluded.win_12m,
      tickers = excluded.tickers,
      as_of = excluded.as_of,
      updated_at = now(),
      horizons = excluded.horizons;
end;
$$ language plpgsql security definer;
