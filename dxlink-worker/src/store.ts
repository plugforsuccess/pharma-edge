// Persistence layer — debounced upserts into public.dxlink_quotes.
//
// dxFeed sends quote frames at very high rate (multiple per second
// per symbol on liquid names like SPY). Writing each frame straight
// to Postgres would saturate the Supabase pooler and cost a fortune
// in row writes. We batch by symbol: incoming events update an
// in-memory shadow row, and a flusher drains every FLUSH_INTERVAL_MS
// (default 750ms) by upserting the dirty rows in chunks.
//
// We track per-symbol metadata (kind, expiration_date, strike,
// option_type, underlying) so the worker can write the same row from
// any event type without losing the structural fields.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const FLUSH_INTERVAL_MS = Number(Deno.env.get('FLUSH_INTERVAL_MS') ?? '750')
const FLUSH_BATCH_SIZE = Number(Deno.env.get('FLUSH_BATCH_SIZE') ?? '500')

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

interface QuoteRow {
  symbol: string
  kind: 'equity' | 'option'
  underlying: string | null
  expiration_date: string | null
  strike: number | null
  option_type: 'C' | 'P' | null
  bid?: number | null
  ask?: number | null
  last?: number | null
  mid?: number | null
  iv?: number | null
  gamma?: number | null
  delta?: number | null
  theta?: number | null
  vega?: number | null
  open_interest?: number | null
  day_volume?: number | null
  prev_close?: number | null
}

const shadow = new Map<string, QuoteRow>()
const dirty = new Set<string>()

export interface SymbolMeta {
  symbol: string
  kind: 'equity' | 'option'
  underlying: string | null
  expiration_date: string | null
  strike: number | null
  option_type: 'C' | 'P' | null
}

// Register the structural metadata for a symbol before any events
// arrive. The worker calls this once per symbol on subscribe so we
// never need to parse OCC strings at write time.
export function registerSymbol(meta: SymbolMeta) {
  if (!shadow.has(meta.symbol)) {
    shadow.set(meta.symbol, { ...meta })
  }
}

// On boot, seed the in-memory shadow with the last-known
// open_interest / iv / Greeks values from dxlink_quotes for the
// symbols we're about to subscribe to. Without this, the matrix's
// per-strike GEX cell goes blank for any symbol whose current
// session hasn't yet received a Summary frame with non-null OI —
// which can be ~80% of strikes during low-churn periods. Carrying
// forward the last-known values across worker restarts is the
// cheapest way to keep the matrix dense.
//
// Only fields the dxFeed subscription rarely refreshes are seeded
// here: open_interest, prev_close, day_volume (all from Summary),
// and the Greeks. Bid/ask/mid get refreshed every Quote frame so
// there's no point seeding stale prices.
export async function seedShadowFromDb(symbols: string[]) {
  if (symbols.length === 0) return
  // Chunk to keep the IN clause manageable on the pgrest side.
  const CHUNK = 500
  let seeded = 0
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const batch = symbols.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('dxlink_quotes')
      .select('symbol, open_interest, prev_close, day_volume, iv, gamma, delta, theta, vega')
      .in('symbol', batch)
    if (error) {
      console.warn('[store] seed batch failed', error.message)
      continue
    }
    for (const row of data ?? []) {
      const existing = shadow.get(row.symbol)
      if (!existing) continue
      const merged: QuoteRow = { ...existing }
      for (const k of [
        'open_interest', 'prev_close', 'day_volume',
        'iv', 'gamma', 'delta', 'theta', 'vega',
      ] as const) {
        const v = (row as unknown as Record<string, unknown>)[k]
        if (v != null && Number.isFinite(Number(v))) {
          ;(merged as unknown as Record<string, unknown>)[k] = Number(v)
        }
      }
      shadow.set(row.symbol, merged)
      seeded++
    }
  }
  console.log(`[store] seeded shadow with prior values for ${seeded}/${symbols.length} symbols`)
}

export function applyEvent(symbol: string, patch: Partial<QuoteRow>) {
  const existing = shadow.get(symbol)
  if (!existing) {
    // Event for an unknown symbol — log once and drop. This can happen
    // if dxFeed routes us a symbol we didn't ask for; rare but harmless.
    if (!unknownSymbolWarned.has(symbol)) {
      console.warn(`[store] dropping event for unregistered symbol ${symbol}`)
      unknownSymbolWarned.add(symbol)
    }
    return
  }
  // dxFeed sends sparse frames — Summary in particular often carries
  // openInterest=null when the field hasn't changed since the last
  // tick. Naive `{ ...existing, ...patch }` would overwrite a
  // previously-good OI with null and leave the matrix's per-strike
  // GEX cell blank. Only apply patch fields whose value is non-null;
  // bid/ask/last/mid/iv/Greeks all follow the same convention.
  const merged: QuoteRow = { ...existing }
  for (const k of Object.keys(patch) as (keyof QuoteRow)[]) {
    const v = patch[k]
    if (v != null) (merged as unknown as Record<string, unknown>)[k] = v
  }
  // mid is computed from bid+ask if dxFeed didn't send it explicitly
  if (
    (patch.bid != null || patch.ask != null) &&
    Number.isFinite(merged.bid) && Number.isFinite(merged.ask) &&
    (merged.bid as number) > 0 && (merged.ask as number) > 0
  ) {
    merged.mid = ((merged.bid as number) + (merged.ask as number)) / 2
  }
  shadow.set(symbol, merged)
  dirty.add(symbol)
}

const unknownSymbolWarned = new Set<string>()

let flushing = false
let lastFlushAt = 0
let lastFlushRows = 0

async function flush() {
  if (flushing || dirty.size === 0) return
  flushing = true
  try {
    const symbols = Array.from(dirty)
    dirty.clear()
    let written = 0
    for (let i = 0; i < symbols.length; i += FLUSH_BATCH_SIZE) {
      const batch = symbols.slice(i, i + FLUSH_BATCH_SIZE)
      const rows = batch
        .map((s) => shadow.get(s))
        .filter((r): r is QuoteRow => !!r)
        .map((r) => ({ ...r, updated_at: new Date().toISOString() }))
      if (rows.length === 0) continue
      const { error } = await supabase
        .from('dxlink_quotes')
        .upsert(rows, { onConflict: 'symbol' })
      if (error) {
        console.error('[store] upsert failed', error)
        // Re-mark dirty so the next flush retries.
        for (const s of batch) dirty.add(s)
        break
      }
      written += rows.length
    }
    lastFlushAt = Date.now()
    lastFlushRows = written
  } finally {
    flushing = false
  }
}

export function startFlushLoop() {
  setInterval(flush, FLUSH_INTERVAL_MS)
  // Health line every 30s so Fly.io logs show liveness.
  setInterval(() => {
    console.log(
      `[store] symbols=${shadow.size} dirty=${dirty.size} ` +
        `last_flush=${lastFlushRows}rows ${
          lastFlushAt ? Math.round((Date.now() - lastFlushAt) / 1000) + 's ago' : 'never'
        }`,
    )
  }, 30_000)
}
