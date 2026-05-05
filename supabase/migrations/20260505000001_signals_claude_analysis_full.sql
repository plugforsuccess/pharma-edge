-- Persist the full Claude analysis object on signals so the rich
-- content (red flags, bull/bear cases, data quality, live IV/HV
-- snapshot, strike suggestion) survives past LogSignal submit.
-- Not part of the immutability trigger or hash inputs — this is
-- supplementary research context, not the trade thesis itself.
ALTER TABLE signals
  ADD COLUMN claude_analysis_full JSONB;
