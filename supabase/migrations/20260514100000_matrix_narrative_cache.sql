-- matrix_narrative_cache — Claude-generated "what this means" narratives
-- for GEX matrix snapshots. Cache key is a qualitative fingerprint
-- (regime + king-wall strike rounded + flip rounded + pin/em buckets)
-- so different exact numbers that describe the same positioning state
-- share a narrative.
--
-- TTL is enforced application-side at 15 min in explain-matrix; older
-- rows can be pruned by a nightly cleanup job. Anon SELECT is intentionally
-- denied — narratives are only fetched server-side from the edge function.

CREATE TABLE IF NOT EXISTS public.matrix_narrative_cache (
  cache_key   TEXT PRIMARY KEY,
  ticker      TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('regime_summary', 'play_context')),
  fingerprint TEXT NOT NULL,
  narrative   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_matrix_narrative_cache_ticker_mode
  ON public.matrix_narrative_cache (ticker, mode);
CREATE INDEX IF NOT EXISTS idx_matrix_narrative_cache_created_at
  ON public.matrix_narrative_cache (created_at);

ALTER TABLE public.matrix_narrative_cache ENABLE ROW LEVEL SECURITY;

-- Service role only. Frontend calls explain-matrix edge function which
-- uses service-role internally to read/write the cache. No anon or
-- authenticated SELECT — keeps surface area small.
DROP POLICY IF EXISTS "service role all" ON public.matrix_narrative_cache;
CREATE POLICY "service role all"
  ON public.matrix_narrative_cache FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.matrix_narrative_cache IS
  'Claude-generated narratives for GEX matrix summary + play context. Cache key includes a qualitative fingerprint so matrices with the same regime/wall/flip state share a narrative.';
