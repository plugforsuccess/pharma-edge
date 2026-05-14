-- Disk IO mitigation for dxlink_quotes (Supabase budget alert 2026-05-14).
--
-- Background: the dxlink-worker upserts each option/equity row on every
-- dxFeed event (~750ms flush loop), driving 164.7M UPDATE operations
-- against a 33K-row table. Despite the table's narrow row shape, every
-- single one of those updates was a full tuple rewrite + index update
-- because the `updated_at` column is bumped each tick AND was indexed —
-- which blocks Postgres's Heap-Only Tuple (HOT) update fast path
-- (`hot_updates = 0` in pg_stat_user_tables).
--
-- pg_stat_user_indexes confirmed the dxlink_quotes_updated_at_idx was
-- nearly unused at read time (688 scans vs 164M writes since project
-- start). Dropping it lets every subsequent UPDATE qualify as HOT,
-- skipping the index write entirely.
--
-- FILLFACTOR=80 reserves 20% slack on each page so the new tuple
-- version has somewhere to land in the same page (HOT's hard
-- requirement). Existing pages stay at 100% until they're rewritten by
-- vacuum / heap_blks growth; new pages use the looser setting
-- immediately.
--
-- If a future query needs updated_at-ordered scans, recreate a much
-- narrower index — e.g. on (underlying, updated_at DESC) WHERE
-- kind='option' — so the index isn't touched by every event.

DROP INDEX IF EXISTS public.dxlink_quotes_updated_at_idx;

ALTER TABLE public.dxlink_quotes SET (fillfactor = 80);
