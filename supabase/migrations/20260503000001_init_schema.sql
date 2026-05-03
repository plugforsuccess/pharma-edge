-- Pharma Edge — Week 1 initial schema
-- Hardened version of the spec in CLAUDE.md.
--
-- Differences vs. the original Week 1 spec:
--   * Server-side SHA-256 hashing of signals/outcomes via pgcrypto trigger
--     (canonical hash lives in DB; frontend hash is verification-only).
--   * Immutability trigger uses IS DISTINCT FROM, drops the
--     misleading "OLD.logged_at IS NOT NULL" guard, also locks signal_hash
--     and user_id.
--   * NO DELETE policy on signals/outcomes (write-once audit trail);
--     dismissal is via status='dismissed'.
--   * BEFORE UPDATE triggers maintain updated_at on profiles, watchlist, signals.
--   * public_record view is SECURITY DEFINER (security_invoker = false) and
--     SELECT-granted to anon + authenticated, so /r/[slug] is reachable
--     without auth without opening base tables to anon.
--   * Indexes on common access paths.
--   * RLS policies split into per-action (SELECT/INSERT/UPDATE/DELETE)
--     with explicit WITH CHECK on writes.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ===========================================================================
-- Shared trigger helpers
-- ===========================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- ===========================================================================
-- profiles
-- ===========================================================================
CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  account_size NUMERIC(12,2) DEFAULT 0,
  max_position_pct NUMERIC(5,2) DEFAULT 2.00,
  max_sector_pct NUMERIC(5,2) DEFAULT 20.00,
  is_public BOOLEAN DEFAULT true,
  public_slug TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ===========================================================================
-- watchlist
-- ===========================================================================
CREATE TABLE watchlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  ticker TEXT NOT NULL,
  company_name TEXT NOT NULL,
  drug_name TEXT,
  indication TEXT,
  catalyst_type TEXT CHECK (catalyst_type IN (
    'pdufa', 'adcomm', 'phase2_readout', 'phase3_readout',
    'enrollment_end', 'patent_expiry', 'earnings', 'other'
  )),
  catalyst_date DATE,
  notes TEXT,
  source_urls TEXT[],
  added_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX watchlist_user_idx ON watchlist (user_id);

CREATE TRIGGER watchlist_set_updated_at
  BEFORE UPDATE ON watchlist
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- signals
-- ===========================================================================
CREATE TABLE signals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,

  ticker TEXT NOT NULL,
  company_name TEXT NOT NULL,
  drug_name TEXT,
  indication TEXT,
  market_cap NUMERIC(15,2),
  stock_price_at_signal NUMERIC(10,2),

  catalyst_type TEXT NOT NULL CHECK (catalyst_type IN (
    'pdufa', 'adcomm', 'phase2_readout', 'phase3_readout',
    'enrollment_end', 'patent_expiry', 'earnings', 'other'
  )),
  catalyst_date DATE NOT NULL,

  direction TEXT NOT NULL CHECK (direction IN ('long_put', 'long_call', 'watch')),

  thesis TEXT NOT NULL,
  claude_analysis TEXT,
  market_implied_probability NUMERIC(5,2),
  your_probability NUMERIC(5,2),
  edge_score NUMERIC(5,2) GENERATED ALWAYS AS (
    ABS(COALESCE(market_implied_probability, 50) - COALESCE(your_probability, 50))
  ) STORED,

  confidence_score INTEGER CHECK (confidence_score BETWEEN 1 AND 10),
  enrollment_signal INTEGER DEFAULT 0 CHECK (enrollment_signal BETWEEN 0 AND 10),
  fda_precedent_signal INTEGER DEFAULT 0 CHECK (fda_precedent_signal BETWEEN 0 AND 10),
  protocol_amendment_signal INTEGER DEFAULT 0 CHECK (protocol_amendment_signal BETWEEN 0 AND 10),
  insider_selling_signal INTEGER DEFAULT 0 CHECK (insider_selling_signal BETWEEN 0 AND 10),
  cash_runway_signal INTEGER DEFAULT 0 CHECK (cash_runway_signal BETWEEN 0 AND 10),

  trade_type TEXT DEFAULT 'paper' CHECK (trade_type IN ('paper', 'real')),
  structure TEXT CHECK (structure IN ('naked_put', 'bear_put_spread', 'naked_call', 'bull_call_spread', 'watch')),
  entry_price NUMERIC(10,2),
  strike_price NUMERIC(10,2),
  expiry_date DATE,
  contracts INTEGER DEFAULT 1,
  position_size NUMERIC(10,2),

  source_urls TEXT[],

  checklist_read_sources BOOLEAN DEFAULT false,
  checklist_thesis_defined BOOLEAN DEFAULT false,
  checklist_invalidation_known BOOLEAN DEFAULT false,
  checklist_position_sized BOOLEAN DEFAULT false,
  checklist_spread_used BOOLEAN DEFAULT false,
  checklist_dte_checked BOOLEAN DEFAULT false,
  checklist_two_signals BOOLEAN DEFAULT false,
  checklist_not_at_highs BOOLEAN DEFAULT false,
  checklist_exit_planned BOOLEAN DEFAULT false,
  checklist_loss_accepted BOOLEAN DEFAULT false,

  signal_hash TEXT,
  hash_anchored_at TIMESTAMPTZ,
  github_commit_sha TEXT,

  logged_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'expired', 'dismissed'))
);

CREATE INDEX signals_user_status_idx ON signals (user_id, status);
CREATE INDEX signals_catalyst_date_idx ON signals (catalyst_date);
CREATE INDEX signals_logged_at_idx ON signals (logged_at DESC);

CREATE OR REPLACE FUNCTION compute_signal_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.signal_hash := encode(
    digest(
      json_build_object(
        'ticker', NEW.ticker,
        'direction', NEW.direction,
        'thesis', NEW.thesis,
        'catalyst_date', NEW.catalyst_date,
        'logged_at', NEW.logged_at,
        'confidence_score', NEW.confidence_score
      )::text,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER signals_compute_hash
  BEFORE INSERT ON signals
  FOR EACH ROW EXECUTE FUNCTION compute_signal_hash();

CREATE OR REPLACE FUNCTION enforce_signal_immutability_fn()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thesis IS DISTINCT FROM OLD.thesis
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.catalyst_date IS DISTINCT FROM OLD.catalyst_date
     OR NEW.logged_at IS DISTINCT FROM OLD.logged_at
     OR NEW.signal_hash IS DISTINCT FROM OLD.signal_hash
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Core signal fields are immutable after logging';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_signal_immutability
  BEFORE UPDATE ON signals
  FOR EACH ROW EXECUTE FUNCTION enforce_signal_immutability_fn();

CREATE TRIGGER signals_set_updated_at
  BEFORE UPDATE ON signals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- outcomes
-- ===========================================================================
CREATE TABLE outcomes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  signal_id UUID REFERENCES signals(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,

  catalyst_result TEXT NOT NULL CHECK (catalyst_result IN (
    'approved', 'rejected', 'complete_response_letter',
    'positive_data', 'negative_data', 'mixed_data',
    'delayed', 'withdrawn', 'other'
  )),
  stock_price_at_outcome NUMERIC(10,2),
  option_price_at_outcome NUMERIC(10,2),
  exit_price NUMERIC(10,2),

  pnl_dollars NUMERIC(12,2),
  pnl_percent NUMERIC(8,2),
  thesis_correct BOOLEAN NOT NULL,

  exit_reason TEXT CHECK (exit_reason IN (
    'catalyst_resolved', 'stop_loss_50pct', 'thesis_invalidated',
    'profit_100pct', 'profit_200pct', 'pre_catalyst_exit',
    'dte_expired', 'manual'
  )),
  rules_followed BOOLEAN DEFAULT true,
  rules_broken TEXT,

  post_trade_notes TEXT,

  outcome_hash TEXT,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX outcomes_signal_idx ON outcomes (signal_id);
CREATE INDEX outcomes_user_idx ON outcomes (user_id);

CREATE OR REPLACE FUNCTION compute_outcome_hash()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.outcome_hash := encode(
    digest(
      json_build_object(
        'signal_id', NEW.signal_id,
        'catalyst_result', NEW.catalyst_result,
        'pnl_percent', NEW.pnl_percent,
        'thesis_correct', NEW.thesis_correct,
        'exit_reason', NEW.exit_reason,
        'recorded_at', NEW.recorded_at
      )::text,
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER outcomes_compute_hash
  BEFORE INSERT ON outcomes
  FOR EACH ROW EXECUTE FUNCTION compute_outcome_hash();

-- ===========================================================================
-- scanner_runs
-- ===========================================================================
CREATE TABLE scanner_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT CHECK (source IN (
    'clinicaltrials', 'fda_calendar', 'sec_edgar',
    'finra_short', 'patent', 'manual'
  )),
  companies_scanned INTEGER DEFAULT 0,
  signals_generated INTEGER DEFAULT 0,
  raw_data JSONB,
  error_log TEXT,
  status TEXT DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed'))
);

CREATE INDEX scanner_runs_run_at_idx ON scanner_runs (run_at DESC);

-- ===========================================================================
-- alerts
-- ===========================================================================
CREATE TABLE alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  signal_id UUID REFERENCES signals(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'new_signal', 'catalyst_approaching_14d', 'catalyst_approaching_7d',
    'catalyst_tomorrow', 'stop_loss_triggered', 'profit_target_hit',
    'daily_digest', 'outcome_reminder'
  )),
  message TEXT NOT NULL,
  sent_via TEXT CHECK (sent_via IN ('email', 'push', 'in_app')),
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX alerts_user_sent_idx ON alerts (user_id, sent_at DESC);
CREATE INDEX alerts_user_unread_idx ON alerts (user_id) WHERE read_at IS NULL;

-- ===========================================================================
-- public_record (curated read-only view, anon-accessible)
-- ===========================================================================
CREATE VIEW public_record
WITH (security_invoker = false) AS
SELECT
  s.id,
  p.display_name,
  p.public_slug,
  s.ticker,
  s.company_name,
  s.drug_name,
  s.indication,
  s.catalyst_type,
  s.catalyst_date,
  s.direction,
  s.confidence_score,
  s.edge_score,
  s.logged_at,
  s.trade_type,
  s.signal_hash,
  s.github_commit_sha,
  o.catalyst_result,
  o.thesis_correct,
  o.pnl_percent,
  o.exit_reason,
  o.rules_followed,
  o.recorded_at AS outcome_date
FROM signals s
JOIN profiles p ON s.user_id = p.id
LEFT JOIN outcomes o ON o.signal_id = s.id
WHERE p.is_public = true
  AND s.status <> 'dismissed';

GRANT SELECT ON public_record TO anon, authenticated;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_runs ENABLE ROW LEVEL SECURITY;

-- profiles: own row only
CREATE POLICY profiles_select_own ON profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY profiles_update_own ON profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- watchlist: full CRUD on own rows
CREATE POLICY watchlist_select_own ON watchlist
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY watchlist_insert_own ON watchlist
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY watchlist_update_own ON watchlist
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY watchlist_delete_own ON watchlist
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- signals: SELECT/INSERT/UPDATE on own rows; NO DELETE policy on purpose.
-- Dismissal is done via UPDATE status='dismissed'.
CREATE POLICY signals_select_own ON signals
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY signals_insert_own ON signals
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY signals_update_own ON signals
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- outcomes: SELECT/INSERT only. Outcomes are write-once audit records.
CREATE POLICY outcomes_select_own ON outcomes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY outcomes_insert_own ON outcomes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- alerts: full CRUD on own rows (read_at toggling, dismissal)
CREATE POLICY alerts_select_own ON alerts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY alerts_insert_own ON alerts
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY alerts_update_own ON alerts
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY alerts_delete_own ON alerts
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- scanner_runs: read-only for authenticated users.
-- Inserts are done by the scraper via service_role (bypasses RLS).
CREATE POLICY scanner_runs_select_authenticated ON scanner_runs
  FOR SELECT TO authenticated USING (true);
