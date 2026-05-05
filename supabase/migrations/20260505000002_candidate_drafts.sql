-- Per-user draft analysis for scanner_candidates so an in-progress
-- LogSignal flow survives device switches (phone → desktop) and
-- localStorage clears. localStorage on the client stays as the fast
-- cache; this is the canonical store.
--
-- PK is (user_id, candidate_id) so the same broad candidate can have
-- one draft per user. RLS scopes to own rows. ON DELETE CASCADE on
-- both FKs keeps drafts tidy when a candidate is dismissed for
-- everyone or a profile is removed.

CREATE TABLE candidate_drafts (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  candidate_id UUID NOT NULL REFERENCES scanner_candidates(id) ON DELETE CASCADE,
  analysis JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, candidate_id)
);

ALTER TABLE candidate_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY candidate_drafts_select_own ON candidate_drafts
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY candidate_drafts_insert_own ON candidate_drafts
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY candidate_drafts_update_own ON candidate_drafts
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY candidate_drafts_delete_own ON candidate_drafts
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE INDEX candidate_drafts_user_idx
  ON candidate_drafts (user_id, updated_at DESC);

-- Cover the candidate_id FK so deletes by candidate_id (after a
-- successful Lock & Log, or via cascade when a candidate is dismissed)
-- can use an index instead of full-scanning the table.
CREATE INDEX candidate_drafts_candidate_idx
  ON candidate_drafts (candidate_id);
