-- Add signal_source metadata column so we can distinguish biotech-catalyst
-- signals (drug/indication/PDUFA-driven) from GEX-flow trades (options
-- positions taken from the live GEX matrix on /markets, no underlying
-- pharma catalyst). Default preserves existing rows as biotech_catalyst.
--
-- Intentionally NOT added to compute_signal_hash() — signal_source is
-- descriptive metadata. The canonical hash (ticker, direction, thesis,
-- catalyst_date, logged_at, confidence_score) stays untouched, so prior
-- anchored hashes remain verifiable.

ALTER TABLE signals
  ADD COLUMN signal_source TEXT NOT NULL DEFAULT 'biotech_catalyst'
    CHECK (signal_source IN ('biotech_catalyst', 'gex_flow', 'manual'));

CREATE INDEX signals_source_idx ON signals (signal_source);

COMMENT ON COLUMN signals.signal_source IS
  'Where the signal originated: biotech_catalyst (default — drug/indication/PDUFA-driven), gex_flow (GEX matrix-driven options trade), manual (operator override).';
