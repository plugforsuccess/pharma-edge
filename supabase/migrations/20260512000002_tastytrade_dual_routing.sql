-- Dual-environment routing for Tastytrade.
--
-- The bot can now route orders to either the production environment
-- (api.tastyworks.com) or the cert sandbox (api.cert.tastyworks.com),
-- depending on bot_config.mode. Each environment has its own OAuth
-- app on Tastytrade with its own client_id / client_secret /
-- refresh_token, so the session cache needs to store two access
-- tokens (one per env) and refresh them independently.
--
-- Also tags each order_history row with its env so monitor-positions
-- knows which environment to poll for fill status.

-- ── 1. tastytrade_sessions: per-env access-token cache ──────────────
--
-- Was: PRIMARY KEY (id), CHECK (id = 1) — singleton row, prod only.
-- Now: PRIMARY KEY (env), with env ∈ {'live','cert'}.
-- Existing data is the prod row — migrate it in place.

ALTER TABLE public.tastytrade_sessions
  ADD COLUMN IF NOT EXISTS env text;

-- Backfill any existing row as 'live' (the only env we'd been writing to)
UPDATE public.tastytrade_sessions SET env = 'live' WHERE env IS NULL;

-- Drop the old singleton constraint + PK, add the env-based PK.
ALTER TABLE public.tastytrade_sessions
  DROP CONSTRAINT IF EXISTS tastytrade_sessions_id_check;

ALTER TABLE public.tastytrade_sessions
  DROP CONSTRAINT IF EXISTS tastytrade_sessions_pkey;

ALTER TABLE public.tastytrade_sessions
  ALTER COLUMN env SET NOT NULL,
  ADD CONSTRAINT tastytrade_sessions_env_check CHECK (env IN ('live','cert')),
  ADD CONSTRAINT tastytrade_sessions_pkey PRIMARY KEY (env);

-- id column is now redundant but keep it for backwards-compat reads.
ALTER TABLE public.tastytrade_sessions
  ALTER COLUMN id DROP DEFAULT,
  ALTER COLUMN id DROP NOT NULL;

-- ── 2. order_history: env tag per order ─────────────────────────────
--
-- monitor-positions polls Tastytrade /accounts/:n/orders to reconcile
-- fill status. With dual routing, we need to know which env to hit.
-- Existing rows get 'live' (the only env they could have come from).

ALTER TABLE public.order_history
  ADD COLUMN IF NOT EXISTS env text NOT NULL DEFAULT 'live'
  CHECK (env IN ('live','cert'));

CREATE INDEX IF NOT EXISTS order_history_env_idx
  ON public.order_history (env, status);

-- ── 3. auto_triggers: env tag for symmetric routing of exits ────────
--
-- Exit-evaluator reads the position's open env and routes the close
-- to the same env. open_positions already tracks broker_order_id which
-- can resolve via order_history.env, but stamping env on the position
-- row directly saves a join.

ALTER TABLE public.open_positions
  ADD COLUMN IF NOT EXISTS env text NOT NULL DEFAULT 'live'
  CHECK (env IN ('live','cert'));

CREATE INDEX IF NOT EXISTS open_positions_env_status_idx
  ON public.open_positions (env, status);
