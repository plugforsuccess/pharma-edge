-- Pharma Edge — broad scanner candidate dedup.
--
-- The original dedup index `scanner_candidates_dedup_nct_idx` only
-- covers personal candidates (`requested_by IS NOT NULL`). Without an
-- equivalent for broad candidates the daily cron would re-insert the
-- same NCT id every run.
--
-- We also need a dedup for SEC-derived broad candidates (8-K and PDUFA
-- mining) keyed on (source, raw_data->>'filing_url'), and the matching
-- one for personal SEC candidates created by the watchlist sweep.

CREATE UNIQUE INDEX scanner_candidates_dedup_nct_broad_idx
  ON scanner_candidates (nct_id)
  WHERE nct_id IS NOT NULL AND requested_by IS NULL;

CREATE UNIQUE INDEX scanner_candidates_dedup_filing_broad_idx
  ON scanner_candidates (source, (raw_data->>'filing_url'))
  WHERE source = 'sec_edgar'
    AND raw_data->>'filing_url' IS NOT NULL
    AND requested_by IS NULL;

CREATE UNIQUE INDEX scanner_candidates_dedup_filing_personal_idx
  ON scanner_candidates (requested_by, source, (raw_data->>'filing_url'))
  WHERE source = 'sec_edgar'
    AND raw_data->>'filing_url' IS NOT NULL
    AND requested_by IS NOT NULL;
