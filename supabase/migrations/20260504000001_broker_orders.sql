-- Pharma Edge — broker (Tastytrade) order placement infrastructure.
--
-- Three additions:
--   1. signals columns to track the most recent open order for a signal.
--   2. order_history audit table — write-once via service role, read-only
--      for the owning user. INSERT/UPDATE/DELETE intentionally have no RLS
--      policies, so only the place-order edge function can mutate it.
--   3. tastytrade_sessions singleton — caches the session token so we
--      don't re-login on every invocation. Service-role only; not
--      reachable from the frontend.

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS tastytrade_order_id TEXT,
  ADD COLUMN IF NOT EXISTS tastytrade_account_number TEXT,
  ADD COLUMN IF NOT EXISTS order_status TEXT CHECK (order_status IN (
    'pending', 'submitted', 'filled', 'cancelled', 'rejected', 'partial_fill'
  )),
  ADD COLUMN IF NOT EXISTS order_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS order_filled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_entry_price NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS actual_contracts INTEGER;

CREATE TABLE order_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  signal_id UUID REFERENCES signals(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,

  tastytrade_order_id TEXT,
  account_number TEXT,
  order_type TEXT CHECK (order_type IN ('open', 'close')),
  action TEXT,
  structure TEXT,
  ticker TEXT NOT NULL,

  buy_strike NUMERIC(10,2),
  sell_strike NUMERIC(10,2),
  expiry_date DATE,
  contracts INTEGER,

  limit_price NUMERIC(10,4),
  filled_price NUMERIC(10,4),
  total_cost NUMERIC(12,2),

  status TEXT NOT NULL CHECK (status IN (
    'pending', 'submitted', 'filled', 'cancelled', 'rejected', 'partial_fill'
  )),
  submitted_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  filled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,

  api_response JSONB
);

CREATE INDEX order_history_signal_idx
  ON order_history (signal_id, submitted_at DESC);

CREATE INDEX order_history_user_idx
  ON order_history (user_id, submitted_at DESC);

ALTER TABLE order_history ENABLE ROW LEVEL SECURITY;

-- Read-only audit: SELECT own. No INSERT/UPDATE/DELETE policy means only
-- the service_role (place-order edge function) can write.
CREATE POLICY order_history_select_own ON order_history
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);

-- Tastytrade session cache. One row, ever. Constrained to id=1 so we
-- can UPSERT cleanly on every refresh.
CREATE TABLE tastytrade_sessions (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  session_token TEXT NOT NULL,
  remember_token TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  refreshed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE tastytrade_sessions ENABLE ROW LEVEL SECURITY;
-- No policies — service-role only.
