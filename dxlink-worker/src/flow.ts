// Options-flow aggregator for the dxlink-worker.
//
// dxFeed `Trade` events fire on every options print — at peak SPY can
// emit hundreds per second across the chain. Writing each to Postgres
// would saturate Supabase. Instead we:
//
//   1. Maintain an in-memory bucket per (ticker, strike, expiration,
//      side, trade_date), updating it on every Trade event.
//   2. Flush every 60s — upsert all dirty buckets to option_flow_daily
//      with running totals.
//   3. Roll buckets at the trade-date boundary (NY-day midnight).
//
// suggest-plays reads from option_flow_daily to enrich Claude's prompt:
// it sees today's volume + premium per strike alongside the GEX matrix.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const FLUSH_INTERVAL_MS = Number(Deno.env.get('FLOW_FLUSH_INTERVAL_MS') ?? '60000')
const FLUSH_BATCH_SIZE = Number(Deno.env.get('FLOW_FLUSH_BATCH_SIZE') ?? '500')

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

interface OptionMeta {
  symbol: string
  ticker: string
  expiration_date: string  // YYYY-MM-DD
  strike: number
  option_type: 'C' | 'P'
}

interface FlowBucket {
  ticker: string
  strike: number
  expiration_date: string
  option_type: 'C' | 'P'
  trade_date: string         // YYYY-MM-DD (NY)
  total_volume: number
  total_premium: number
  print_count: number
  biggest_print_size: number
  biggest_print_at: string | null   // ISO timestamp
  last_print_at: string | null
}

// Symbol → option metadata; populated by the worker on subscribe.
const optionMetaBySymbol = new Map<string, OptionMeta>()

// Composite key → flow bucket (the running daily totals).
const buckets = new Map<string, FlowBucket>()
const dirty = new Set<string>()

let flushing = false
let lastFlushAt = 0
let lastFlushRows = 0

export function registerOption(meta: OptionMeta) {
  optionMetaBySymbol.set(meta.symbol, meta)
}

// "America/New_York" date as YYYY-MM-DD. We use NY time so the trade
// date rolls at the close of the US session, not at UTC midnight.
function nyDateStr(ts: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(ts) // en-CA gives YYYY-MM-DD
}

function bucketKey(
  ticker: string,
  strike: number,
  expiration: string,
  optionType: 'C' | 'P',
  tradeDate: string,
): string {
  return `${ticker}|${strike}|${expiration}|${optionType}|${tradeDate}`
}

// Called from the dxlink event handler on every Trade event.
export function applyTrade(symbol: string, price: number, size: number, eventTime?: number) {
  const meta = optionMetaBySymbol.get(symbol)
  if (!meta) return                                     // not an option we care about
  if (!Number.isFinite(price) || !Number.isFinite(size)) return
  if (price <= 0 || size <= 0) return

  const ts = eventTime != null && Number.isFinite(eventTime)
    ? new Date(eventTime)
    : new Date()
  const tradeDate = nyDateStr(ts)
  const isoTs = ts.toISOString()

  const key = bucketKey(meta.ticker, meta.strike, meta.expiration_date, meta.option_type, tradeDate)
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = {
      ticker: meta.ticker,
      strike: meta.strike,
      expiration_date: meta.expiration_date,
      option_type: meta.option_type,
      trade_date: tradeDate,
      total_volume: 0,
      total_premium: 0,
      print_count: 0,
      biggest_print_size: 0,
      biggest_print_at: null,
      last_print_at: null,
    }
    buckets.set(key, bucket)
  }

  bucket.total_volume += size
  bucket.total_premium += price * size * 100      // contract multiplier
  bucket.print_count += 1
  bucket.last_print_at = isoTs
  if (size > bucket.biggest_print_size) {
    bucket.biggest_print_size = size
    bucket.biggest_print_at = isoTs
  }
  dirty.add(key)
}

async function flush() {
  if (flushing || dirty.size === 0) return
  flushing = true
  try {
    const keys = Array.from(dirty)
    dirty.clear()
    let written = 0
    for (let i = 0; i < keys.length; i += FLUSH_BATCH_SIZE) {
      const batch = keys.slice(i, i + FLUSH_BATCH_SIZE)
      const rows = batch
        .map((k) => buckets.get(k))
        .filter((b): b is FlowBucket => !!b)
        .map((b) => ({ ...b, updated_at: new Date().toISOString() }))
      if (rows.length === 0) continue
      const { error } = await supabase
        .from('option_flow_daily')
        .upsert(rows, {
          onConflict: 'ticker,strike,expiration_date,option_type,trade_date',
        })
      if (error) {
        console.error('[flow] upsert failed', error)
        // re-mark dirty so the next flush retries
        for (const k of batch) dirty.add(k)
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

export function startFlowFlushLoop() {
  setInterval(flush, FLUSH_INTERVAL_MS)
  // Health log every 5 min so Fly logs show flow throughput.
  setInterval(() => {
    console.log(
      `[flow] buckets=${buckets.size} dirty=${dirty.size} ` +
        `last_flush=${lastFlushRows}rows ${
          lastFlushAt ? Math.round((Date.now() - lastFlushAt) / 1000) + 's ago' : 'never'
        }`,
    )
  }, 5 * 60_000)
}

// Bucket pruning: at NY-midnight roll, drop yesterday's buckets so
// memory doesn't grow unboundedly. We do this once an hour — cheap
// scan since the bucket map only ever has ~today + occasionally
// ~yesterday during the rollover window.
export function startFlowPruneLoop() {
  setInterval(() => {
    const today = nyDateStr(new Date())
    let removed = 0
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.trade_date < today && !dirty.has(key)) {
        buckets.delete(key)
        removed++
      }
    }
    if (removed > 0) console.log(`[flow] pruned ${removed} stale buckets`)
  }, 60 * 60_000)
}
