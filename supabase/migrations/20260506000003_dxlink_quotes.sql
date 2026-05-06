-- dxlink_quotes: live price cache populated by the dxlink-worker process.
--
-- Schema is intentionally wide and sparse — different event types
-- update different columns:
--   Quote (equity)        → bid, ask, last, mid
--   Quote (option)        → bid, ask, last, mid
--   Greeks (option)       → iv, gamma, delta, theta, vega, rho
--   Summary (option)      → open_interest, prev_close, day_volume
--
-- The worker upserts on (symbol) on every frame; compute-gex reads
-- the latest snapshot per symbol. updated_at is touched on every
-- write so stale rows can be filtered out (e.g. > 5 min old means
-- the worker is down or the symbol fell out of subscription).
--
-- `kind` distinguishes equity vs option quotes for index efficiency;
-- the option-chain expansion stores OCC symbols like
-- "AAPL  240517C00150000" (length 21) and the equity row stores the
-- bare ticker.

CREATE TABLE IF NOT EXISTS public.dxlink_quotes (
    symbol          TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('equity', 'option')),
    underlying      TEXT,                  -- equity ticker the option roots to (NULL for kind='equity')
    expiration_date DATE,                  -- option expiry (NULL for kind='equity')
    strike          NUMERIC,               -- option strike (NULL for kind='equity')
    option_type     TEXT CHECK (option_type IN ('C', 'P')),
    bid             NUMERIC,
    ask             NUMERIC,
    last            NUMERIC,
    mid             NUMERIC,
    iv              NUMERIC,               -- decimal, 0.42 = 42%
    gamma           NUMERIC,
    delta           NUMERIC,
    theta           NUMERIC,
    vega            NUMERIC,
    open_interest   NUMERIC,
    day_volume      NUMERIC,
    prev_close      NUMERIC,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dxlink_quotes_underlying_idx
    ON public.dxlink_quotes (underlying)
    WHERE kind = 'option';

CREATE INDEX IF NOT EXISTS dxlink_quotes_updated_at_idx
    ON public.dxlink_quotes (updated_at DESC);

ALTER TABLE public.dxlink_quotes ENABLE ROW LEVEL SECURITY;

-- Authenticated users can SELECT (the data is public market data, not
-- per-user). Worker writes via service-role; no client write policy.
CREATE POLICY "dxlink_quotes_select_authenticated"
    ON public.dxlink_quotes
    FOR SELECT
    TO authenticated
    USING (true);
