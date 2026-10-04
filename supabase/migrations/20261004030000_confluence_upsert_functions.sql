-- RPC functions for confluence ranking upserts (bypasses schema cache)
-- Using simple SQL functions instead of PL/pgSQL for broader compatibility

create or replace function confluence_get_top10()
returns table(side text, ticker text, rank int) as $$
  select side, ticker, rank from confluence_ranks where rank is not null and rank <= 10 order by side, rank
$$ language sql security definer;

-- Trigger-based upserts: insert with ON CONFLICT instead of explicit functions
-- This avoids PL/pgSQL compatibility issues and works with the Supabase JS client directly
