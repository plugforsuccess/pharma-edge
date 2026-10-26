-- The tape scan (owner, 2026-10-26): ticker_risks rows written by the
-- universe job carry scan = true so /charts/tape can list them; rows for
-- held / starred tickers keep scan = false (same facts, same table).
alter table public.ticker_risks add column if not exists scan boolean not null default false;
create index if not exists ticker_risks_scan on public.ticker_risks (scan) where scan;
