-- Risk facts on holdings (owner, 2026-10-26, after the Fade Screen test:
-- "yes to 'failed catalyst' and 'shorts pressing' as plain risk facts on a
-- holding, no verdict wording, no tier"; runway kept as a displayed fact).
-- One row per ticker a user holds or has starred, written nightly by
-- scripts/holding-risks.mjs (service role): catalyst { event, level, jump,
-- brokeOn, last }, shorts { from, to, siChange, shares, priceChange, siPct },
-- runway { quarters, cash, burn, periodEnd }. Shared market data —
-- authenticated SELECT, service-role write. Copy comes from
-- src/utils/holdingRisks.js.

create table if not exists public.ticker_risks (
  ticker      text primary key,
  as_of       date not null,
  catalyst    jsonb,
  shorts      jsonb,
  runway      jsonb,
  updated_at  timestamptz not null default now()
);
alter table public.ticker_risks enable row level security;
drop policy if exists ticker_risks_select_authenticated on public.ticker_risks;
create policy ticker_risks_select_authenticated on public.ticker_risks for select to authenticated using (true);
