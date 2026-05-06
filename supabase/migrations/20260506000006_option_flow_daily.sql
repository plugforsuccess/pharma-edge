-- option_flow_daily: per-strike per-day options flow aggregates.
--
-- Populated by the dxlink-worker, which subscribes to dxFeed Trade
-- events on every option in its hot-ticker chain plan. Each Trade
-- event mutates an in-memory bucket keyed by
-- (ticker, strike, expiration_date, option_type, trade_date); a 60s
-- flush loop upserts every dirty bucket into this table.
--
-- The suggest-plays edge function reads this table to enrich the
-- Claude prompt with "where prints actually went today" alongside
-- "where dealer hedging sits" (GEX) — the combo Claude needs to
-- recommend better spread setups.
--
-- One row per strike per day. Daily values are running totals; they
-- only reset when a new trade_date kicks in (UTC midnight is fine —
-- we use the date in NY time on the worker side, but the column is
-- DATE so timezone-agnostic at rest).

CREATE TABLE IF NOT EXISTS public.option_flow_daily (
    ticker             TEXT NOT NULL,
    strike             NUMERIC NOT NULL,
    expiration_date    DATE NOT NULL,
    option_type        TEXT NOT NULL CHECK (option_type IN ('C', 'P')),
    trade_date         DATE NOT NULL,
    total_volume       NUMERIC NOT NULL DEFAULT 0,
    total_premium      NUMERIC NOT NULL DEFAULT 0,   -- sum(price × size × 100)
    print_count        INTEGER NOT NULL DEFAULT 0,
    biggest_print_size NUMERIC,
    biggest_print_at   TIMESTAMPTZ,
    last_print_at      TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ticker, strike, expiration_date, option_type, trade_date)
);

-- The most common query shape: "give me today's flow for ticker X
-- across all strikes, sorted by volume." Index on (ticker, trade_date)
-- with INCLUDE columns avoids touching the heap for read-only paths.
CREATE INDEX IF NOT EXISTS option_flow_daily_ticker_date_idx
    ON public.option_flow_daily (ticker, trade_date DESC, total_volume DESC);

ALTER TABLE public.option_flow_daily ENABLE ROW LEVEL SECURITY;

-- Authenticated SELECT (it's public market flow, not user data).
-- Worker writes via service role; no client INSERT/UPDATE policy.
CREATE POLICY "option_flow_daily_select_authenticated"
    ON public.option_flow_daily
    FOR SELECT
    TO authenticated
    USING (true);
