-- RPC functions for confluence ranking upserts (bypasses schema cache)
-- Using raw SQL to avoid Supabase schema cache issues entirely

create or replace function confluence_get_top10()
returns table(side text, ticker text, rank int) as $$
  select side, ticker, rank from confluence_ranks where rank is not null and rank <= 10 order by side, rank
$$ language sql security definer;

-- Bulk upsert via raw SQL — bypasses schema introspection cache completely
create or replace function bulk_upsert_confluence_ranks(data jsonb)
returns void as $$
declare
  x jsonb;
begin
  for x in select jsonb_array_elements(data)
  loop
    insert into confluence_ranks (
      side, ticker, as_of, close, score, lit, combo, conditions_met, trend_up,
      own_n, pool_n, est_at_turn, est_3m, est_6m, est_12m, est_win_6m,
      last_signal, etb_convergence, rank, updated_at
    )
    values (
      x->>'side', x->>'ticker', (x->>'as_of')::date,
      (x->>'close')::numeric, (x->>'score')::numeric,
      array(select jsonb_array_elements_text(x->'lit')),
      x->>'combo', (x->>'conditions_met')::int, (x->>'trend_up')::boolean,
      (x->>'own_n')::int, (x->>'pool_n')::int,
      (x->>'est_at_turn')::numeric, (x->>'est_3m')::numeric,
      (x->>'est_6m')::numeric, (x->>'est_12m')::numeric,
      (x->>'est_win_6m')::numeric,
      (x->>'last_signal')::date,
      (x->>'etb_convergence')::boolean, (x->>'rank')::int,
      now()
    )
    on conflict (side, ticker) do update set
      as_of = excluded.as_of, close = excluded.close, score = excluded.score,
      lit = excluded.lit, combo = excluded.combo, conditions_met = excluded.conditions_met,
      trend_up = excluded.trend_up, own_n = excluded.own_n, pool_n = excluded.pool_n,
      est_at_turn = excluded.est_at_turn, est_3m = excluded.est_3m,
      est_6m = excluded.est_6m, est_12m = excluded.est_12m,
      est_win_6m = excluded.est_win_6m, last_signal = excluded.last_signal,
      etb_convergence = excluded.etb_convergence, rank = excluded.rank,
      updated_at = now()
    ;
  end loop;
end;
$$ language plpgsql security definer;

-- Bulk upsert for confluence_pool (setup pooled stats)
create or replace function bulk_upsert_confluence_pool(data jsonb)
returns void as $$
declare
  x jsonb;
begin
  for x in select jsonb_array_elements(data)
  loop
    insert into confluence_pool (
      side, combo, lit, score, n, graded, at_turn, avg_3m, avg_6m, avg_12m,
      win_3m, win_6m, win_12m, tickers, as_of, horizons, updated_at
    )
    values (
      x->>'side', x->>'combo',
      array(select jsonb_array_elements_text(x->'lit')),
      (x->>'score')::numeric, (x->>'n')::int, (x->>'graded')::int,
      (x->>'at_turn')::numeric, (x->>'avg_3m')::numeric,
      (x->>'avg_6m')::numeric, (x->>'avg_12m')::numeric,
      (x->>'win_3m')::numeric, (x->>'win_6m')::numeric, (x->>'win_12m')::numeric,
      (x->>'tickers')::int, (x->>'as_of')::timestamp with time zone,
      x->'horizons', now()
    )
    on conflict (side, combo) do update set
      lit = excluded.lit, score = excluded.score, n = excluded.n,
      graded = excluded.graded, at_turn = excluded.at_turn,
      avg_3m = excluded.avg_3m, avg_6m = excluded.avg_6m, avg_12m = excluded.avg_12m,
      win_3m = excluded.win_3m, win_6m = excluded.win_6m, win_12m = excluded.win_12m,
      tickers = excluded.tickers, as_of = excluded.as_of, horizons = excluded.horizons,
      updated_at = now()
    ;
  end loop;
end;
$$ language plpgsql security definer;
