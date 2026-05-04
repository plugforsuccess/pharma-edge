-- Pharma Edge — Week 5 scanner candidates queue.
--
-- The scanner (GitHub Actions, service role) inserts candidates here. Users
-- review them, then either promote to a signal or dismiss. Single-user for
-- now: SELECT + UPDATE granted to all authenticated users (shared queue).
-- INSERT / DELETE intentionally have no policies — scraper uses service
-- role which bypasses RLS, and we never want to lose audit trail by
-- letting the UI delete candidates.

CREATE TABLE scanner_candidates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ticker TEXT,
  company_name TEXT,
  catalyst_type TEXT,
  catalyst_date TEXT,                          -- raw string from source; promotion to signals.catalyst_date validates
  score INTEGER,
  flags TEXT[],
  claude_analysis JSONB,
  source TEXT NOT NULL CHECK (source IN (
    'clinicaltrials', 'fda_calendar', 'sec_edgar',
    'finra_short', 'patent', 'manual'
  )),
  nct_id TEXT,
  raw_data JSONB,
  reviewed BOOLEAN DEFAULT false,
  reviewed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  dismissed BOOLEAN DEFAULT false,
  promoted_to_signal UUID REFERENCES signals(id) ON DELETE SET NULL,
  detected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX scanner_candidates_unreviewed_idx
  ON scanner_candidates (detected_at DESC)
  WHERE reviewed = false AND dismissed = false;

CREATE INDEX scanner_candidates_score_idx
  ON scanner_candidates (score DESC);

ALTER TABLE scanner_candidates ENABLE ROW LEVEL SECURITY;

-- Per-action policies, cached auth.role() form (matches our existing pattern).
CREATE POLICY scanner_candidates_select_authenticated ON scanner_candidates
  FOR SELECT TO authenticated USING (true);

CREATE POLICY scanner_candidates_update_authenticated ON scanner_candidates
  FOR UPDATE TO authenticated
  USING (reviewed_by IS NULL OR reviewed_by = (select auth.uid()))
  WITH CHECK (reviewed_by IS NULL OR reviewed_by = (select auth.uid()));

-- No INSERT / DELETE policies: scraper writes via service_role (bypasses RLS),
-- and candidates should not be hard-deleted from the UI.
