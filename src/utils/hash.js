// SHA-256 verifiers that mirror the Postgres triggers compute_signal_hash() and
// compute_outcome_hash(). The DB triggers are the canonical source. These
// functions exist ONLY to verify that a row returned from the DB still matches
// its stored hash (for public record / audit display).
//
// IMPORTANT: pass the row exactly as Supabase returned it. Do not parse
// timestamps into Date objects — the hash uses the raw ISO string Postgres
// serialised. JS JSON.stringify must produce byte-identical output to
// Postgres json_build_object()::text for the hashes to match, so:
//   * key order matches the trigger definition
//   * string values are kept as strings (catalyst_date YYYY-MM-DD,
//     logged_at / recorded_at as the raw ISO with microseconds + offset)
//   * confidence_score / signal_id are passed through as-is (integer / uuid)
//   * NUMERIC columns (e.g. pnl_percent) are NOT in the hash — PG NUMERIC vs
//     JS Number serialisation diverges on trailing zeros. New fields like
//     entry_pop_bp are stored as INTEGER for that reason.
//
// Hash versions:
//   v1 (legacy, signals logged before 2026-05-07) — 6 fields.
//   v2 (current) — adds entry_pop_bp at the end of the payload.
// Branching here mirrors the trigger so old rows continue to verify.

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function computeSignalHash(signal) {
  // hash_version drives the payload shape. Default to 1 if the column
  // isn't present on the row (defensive — every fresh SELECT includes
  // it now, but old code paths might pass partial rows).
  const version = signal.hash_version ?? 1
  const base = {
    ticker: signal.ticker,
    direction: signal.direction,
    thesis: signal.thesis,
    catalyst_date: signal.catalyst_date,
    logged_at: signal.logged_at,
    confidence_score: signal.confidence_score,
  }
  const payloadObj = version === 2
    ? { ...base, entry_pop_bp: signal.entry_pop_bp ?? null }
    : base
  const payload = JSON.stringify(payloadObj)
  return sha256Hex(payload)
}

export async function verifySignalHash(signal) {
  if (!signal?.signal_hash) return false
  const expected = await computeSignalHash(signal)
  return expected === signal.signal_hash
}

export async function computeOutcomeHash(outcome) {
  const payload = JSON.stringify({
    signal_id: outcome.signal_id,
    catalyst_result: outcome.catalyst_result,
    thesis_correct: outcome.thesis_correct,
    exit_reason: outcome.exit_reason,
    recorded_at: outcome.recorded_at,
  })
  return sha256Hex(payload)
}

export async function verifyOutcomeHash(outcome) {
  if (!outcome?.outcome_hash) return false
  const expected = await computeOutcomeHash(outcome)
  return expected === outcome.outcome_hash
}
