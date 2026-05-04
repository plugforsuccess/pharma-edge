-- Pharma Edge — watchlist-driven scanner candidates.
--
-- scanner_candidates was a single shared queue. We now want personal
-- candidates (created by the watchlist scraper for a user's
-- explicitly-watched tickers) to coexist with the broad top-5 ones.
--
--   requested_by IS NULL  -> broad / shared candidate (existing behaviour)
--   requested_by = uuid   -> personal: only that user sees it
--
-- Update SELECT policy to enforce visibility. Keep UPDATE policy as-is
-- (claim-on-promote/dismiss for unclaimed-or-own-claimed). Service role
-- bypasses both, which is how the scraper writes.

ALTER TABLE scanner_candidates
  ADD COLUMN requested_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE INDEX scanner_candidates_requested_by_idx
  ON scanner_candidates (requested_by, detected_at DESC)
  WHERE requested_by IS NOT NULL;

-- Dedup index: same nct_id + same requesting user shouldn't get re-added
-- on every cron run. We keep nct_id partial because broad / SEC
-- candidates often have NULL nct_id.
CREATE UNIQUE INDEX scanner_candidates_dedup_nct_idx
  ON scanner_candidates (requested_by, nct_id)
  WHERE nct_id IS NOT NULL AND requested_by IS NOT NULL;

DROP POLICY scanner_candidates_select_authenticated ON scanner_candidates;
CREATE POLICY scanner_candidates_select_authenticated ON scanner_candidates
  FOR SELECT TO authenticated
  USING (
    requested_by IS NULL
    OR requested_by = (select auth.uid())
  );
