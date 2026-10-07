-- Momentum list + forward record (owner, 2026-10-07: "1 and 3").
--
-- momentum_picks: the nightly momentum top decile (scripts/rank-confluence.mjs,
--   src/utils/momentumList.js), one row per as_of × ticker, history kept.
--   Shared market data: authenticated SELECT, service-role write.
--
-- setup_log: every setup the app showed, logged the night it first
--   appeared (momentum picks and BUY SETUP rows), with the call it priced
--   and the plan it is graded by. Append-only: no UPDATE or DELETE, enforced
--   by trigger (the service role included); row_hash = SHA-256 of the
--   canonical fields, computed here so the client can't choose it —
--   logCanonical() in momentumList.js builds the same string for checking.
-- setup_log_days: one root hash per logged day (SHA-256 of that day's row
--   hashes, ordered by kind, ticker), append-only, ready to anchor publicly.
-- setup_outcomes: each logged setup walked forward nightly by the same plan
--   (forwardOutcome) — mutable by design; the log row it grades is not.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.momentum_picks (
  as_of        date    NOT NULL,
  ticker       text    NOT NULL,
  rank         integer NOT NULL,
  score        numeric NOT NULL,     -- 12-1 return
  close        numeric NOT NULL,
  vs200        numeric,
  r1m          numeric,
  off_high     numeric,
  hv60         numeric,
  trade        jsonb,                -- tradeSpec(): strike, expiry, cost, delta, vol, breakeven
  move_group   text,                 -- the lead ticker of the names it moves with
  peers        text[] NOT NULL DEFAULT '{}',
  eligible     integer,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (as_of, ticker)
);
CREATE INDEX IF NOT EXISTS momentum_picks_as_of_idx ON public.momentum_picks (as_of DESC, rank);
ALTER TABLE public.momentum_picks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS momentum_picks_select_authenticated ON public.momentum_picks;
CREATE POLICY momentum_picks_select_authenticated ON public.momentum_picks FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.setup_log (
  id          bigserial PRIMARY KEY,
  logged_on   date    NOT NULL,
  kind        text    NOT NULL CHECK (kind IN ('momentum', 'buy_setup')),
  ticker      text    NOT NULL,
  rank        integer,
  close       double precision NOT NULL,
  strike      double precision NOT NULL,
  expiry      date    NOT NULL,
  cost        double precision NOT NULL,     -- est. premium per share (Black-Scholes, 60-day vol, 2% slippage)
  target      double precision NOT NULL,     -- sell the whole call at +target on the call
  hold_days   integer NOT NULL,              -- else after this many trading days
  payload     jsonb,
  row_hash    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (logged_on, kind, ticker)
);
CREATE INDEX IF NOT EXISTS setup_log_ticker_idx ON public.setup_log (kind, ticker, logged_on DESC);

CREATE OR REPLACE FUNCTION public.setup_log_canonical(r public.setup_log) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT '[' || to_json(r.logged_on::text)::text || ',' || to_json(r.kind)::text || ',' || to_json(r.ticker)::text || ','
    || coalesce(to_json(r.rank)::text, 'null') || ',' || to_json(r.close)::text || ',' || to_json(r.strike)::text || ','
    || to_json(r.expiry::text)::text || ',' || to_json(r.cost)::text || ',' || to_json(r.target)::text || ',' || to_json(r.hold_days)::text || ']'
$$;

CREATE OR REPLACE FUNCTION public.setup_log_hash_fn() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  NEW.row_hash := encode(extensions.digest(public.setup_log_canonical(NEW), 'sha256'), 'hex');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS setup_log_hash ON public.setup_log;
CREATE TRIGGER setup_log_hash BEFORE INSERT ON public.setup_log FOR EACH ROW EXECUTE FUNCTION public.setup_log_hash_fn();

CREATE OR REPLACE FUNCTION public.append_only_fn() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS setup_log_append_only ON public.setup_log;
CREATE TRIGGER setup_log_append_only BEFORE UPDATE OR DELETE ON public.setup_log FOR EACH ROW EXECUTE FUNCTION public.append_only_fn();

ALTER TABLE public.setup_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS setup_log_select_authenticated ON public.setup_log;
CREATE POLICY setup_log_select_authenticated ON public.setup_log FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.setup_log_days (
  logged_on   date PRIMARY KEY,
  n           integer NOT NULL,
  root_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS setup_log_days_append_only ON public.setup_log_days;
CREATE TRIGGER setup_log_days_append_only BEFORE UPDATE OR DELETE ON public.setup_log_days FOR EACH ROW EXECUTE FUNCTION public.append_only_fn();
ALTER TABLE public.setup_log_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS setup_log_days_select_authenticated ON public.setup_log_days;
CREATE POLICY setup_log_days_select_authenticated ON public.setup_log_days FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.setup_outcomes (
  log_id         bigint PRIMARY KEY REFERENCES public.setup_log (id),
  status         text NOT NULL CHECK (status IN ('open', 'hit', 'capped', 'expired')),
  last_date      date,
  stock_ret      double precision,
  call_ret       double precision,
  peak_call_ret  double precision,
  days           integer,
  closed_on      date,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.setup_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS setup_outcomes_select_authenticated ON public.setup_outcomes;
CREATE POLICY setup_outcomes_select_authenticated ON public.setup_outcomes FOR SELECT TO authenticated USING (true);

-- The tested record of the momentum swing plan, from the latest universe
-- replay that carries it: all trades, by signal year, and the random-entry
-- control for the same exit.
CREATE OR REPLACE FUNCTION public.momentum_record() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'run_at', r.run_at, 'tickers', r.tickers,
    'all', r.summary #> '{prereg,swing,rules,momentum,variants,opt75:378:none,all}',
    'by_year', r.summary #> '{prereg,swing,rules,momentum,variants,opt75:378:none,byYear}',
    'random', r.summary #> '{prereg,swing,rules,momentum,randomByVariant,opt75:378:none}')
  FROM replay_runs r
  WHERE r.summary #> '{prereg,swing,rules,momentum,variants,opt75:378:none}' IS NOT NULL
  ORDER BY r.run_at DESC LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION public.momentum_record() TO authenticated;

-- The forward record: totals per kind and the latest logged setups with
-- their outcome. Open setups count at today's mark (as the replay does).
CREATE OR REPLACE FUNCTION public.forward_record(p_limit integer DEFAULT 40) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH j AS (
    SELECT l.*, o.status, o.call_ret, o.stock_ret, o.peak_call_ret, o.days, o.closed_on, o.last_date
    FROM setup_log l LEFT JOIN setup_outcomes o ON o.log_id = l.id
  )
  SELECT jsonb_build_object(
    'since', (SELECT min(logged_on) FROM j),
    'last_day', (SELECT jsonb_build_object('logged_on', logged_on, 'n', n, 'root_hash', root_hash) FROM setup_log_days ORDER BY logged_on DESC LIMIT 1),
    'totals', coalesce((SELECT jsonb_object_agg(kind, t) FROM (
      SELECT kind, jsonb_build_object(
        'logged', count(*),
        'open', count(*) FILTER (WHERE coalesce(status, 'open') = 'open'),
        'hit', count(*) FILTER (WHERE status = 'hit'),
        'closed', count(*) FILTER (WHERE status IN ('hit', 'capped', 'expired')),
        'avg_call', avg(call_ret),
        'avg_call_closed', avg(call_ret) FILTER (WHERE status IN ('hit', 'capped', 'expired')),
        'avg_stock', avg(stock_ret)) t
      FROM j GROUP BY kind) k), '{}'::jsonb),
    'rows', coalesce((SELECT jsonb_agg(x ORDER BY x.logged_on DESC, x.kind, x.ticker) FROM (
      SELECT logged_on, kind, ticker, rank, close, strike, expiry, cost, target, row_hash, coalesce(status, 'open') status,
             call_ret, stock_ret, peak_call_ret, days, closed_on, last_date
      FROM j ORDER BY logged_on DESC, kind, ticker LIMIT p_limit) x), '[]'::jsonb))
$$;
GRANT EXECUTE ON FUNCTION public.forward_record(integer) TO authenticated;
