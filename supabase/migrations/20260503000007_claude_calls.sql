-- Pharma Edge — per-user rate limit for analyze-signal.
--
-- The edge function INSERTs into this table on every successful Claude
-- call (via service_role) and counts recent rows to decide whether to
-- 429 the caller. Authenticated users can SELECT their own history;
-- INSERT is service-role-only (no policy = no client-side write path).

CREATE TABLE claude_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  called_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX claude_calls_user_called_idx
  ON claude_calls (user_id, called_at DESC);

ALTER TABLE claude_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY claude_calls_select_own ON claude_calls
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
-- No INSERT/UPDATE/DELETE policy: scraper-style audit table, write-once
-- via service_role, never mutated from the client.
