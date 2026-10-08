// NIGHTFLOW live engine inside the dxlink-worker.
//
// For every active symbol in public.orderflow_watchlist it subscribes
// dxFeed TimeAndSale (every print, with the NBBO at execution, sale
// conditions, extended-hours flag, validity, NEW / CORRECTION / CANCEL)
// plus Quote and Summary, runs the shared engine (./orderflow/*.js, a
// generated copy of src/utils/orderflow/) and every FLUSH_MS:
//   • upserts the snapshot into orderflow_state (realtime → the page)
//   • inserts new alerts into orderflow_alerts
//   • appends raw prints / quotes to orderflow_prints / orderflow_quotes
//     (replay + validation; pruned after RETAIN_DAYS)
// Monitoring only: nothing here can place an order.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import type { SubSpec } from './dxlink.ts'
import { OrderFlowEngine as EngineJs } from './orderflow/engine.js'

// The engine is plain JS shared with the browser; type it loosely here.
// deno-lint-ignore no-explicit-any
const OrderFlowEngine = EngineJs as any

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const FLUSH_MS = Number(Deno.env.get('ORDERFLOW_FLUSH_MS') ?? '5000')
const RETAIN_DAYS = Number(Deno.env.get('ORDERFLOW_RETAIN_DAYS') ?? '30')
const MAX_SYMBOLS = Number(Deno.env.get('ORDERFLOW_MAX_SYMBOLS') ?? '25')
export const ORDERFLOW_REFRESH_MS = 5 * 60_000
const SOURCE = 'dxfeed_tastytrade'
const CHART_KEEP = 360   // 1 hour of 10-second buckets in the realtime row

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// deno-lint-ignore no-explicit-any
type Engine = any
const engines = new Map<string, Engine>()
const printBuf: Record<string, unknown>[] = []
const quoteBuf: Record<string, unknown>[] = []
const lastQuoteSaved = new Map<string, number>()

export function isOrderflowSymbol(sym: string) { return engines.has(sym) }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)

// Watchlist → specs for symbols not yet subscribed.
export async function refreshOrderflowWatchlist(): Promise<SubSpec[]> {
  const { data, error } = await supabase.from('orderflow_watchlist').select('symbol').eq('active', true).order('added_at').limit(MAX_SYMBOLS)
  if (error) { console.warn('[orderflow] watchlist read failed', error.message); return [] }
  const specs: SubSpec[] = []
  for (const { symbol } of data ?? []) {
    if (engines.has(symbol)) continue
    engines.set(symbol, new OrderFlowEngine({ symbol, source: SOURCE }))
    specs.push({ type: 'TimeAndSale', symbol }, { type: 'Quote', symbol }, { type: 'Summary', symbol })
  }
  await loadContext()
  if (specs.length) console.log(`[orderflow] tracking ${engines.size} symbols (+${specs.length / 3})`)
  return specs
}

// Dilution filings + float from the orderflow-dilution cache.
async function loadContext() {
  if (!engines.size) return
  const { data } = await supabase.from('orderflow_dilution').select('symbol, score, level, summary, float_shares').in('symbol', [...engines.keys()])
  for (const row of data ?? []) engines.get(row.symbol)?.setContext({ dilution: { score: row.score == null ? null : Number(row.score), level: row.level, summary: row.summary }, float: row.float_shares })
}

export function orderflowOnQuote(sym: string, ev: Record<string, unknown>) {
  const eng = engines.get(sym)
  if (!eng) return
  const bid = num(ev.bidPrice), ask = num(ev.askPrice)
  if (bid == null || ask == null) return
  const t = Math.max(num(ev.bidTime) ?? 0, num(ev.askTime) ?? 0) || Date.now()
  const q = { t, bid, ask, bidSize: num(ev.bidSize), askSize: num(ev.askSize) }
  eng.onQuote(q)
  if (t - (lastQuoteSaved.get(sym) ?? 0) >= 250) {
    lastQuoteSaved.set(sym, t)
    quoteBuf.push({ symbol: sym, t_ms: t, bid, ask, bid_size: q.bidSize, ask_size: q.askSize, source: SOURCE })
  }
}

export function orderflowOnSummary(sym: string, ev: Record<string, unknown>) {
  const prev = num(ev.prevDayClosePrice)
  if (prev) engines.get(sym)?.setContext({ refPrice: prev })
}

export function orderflowOnTrade(sym: string, ev: Record<string, unknown>) {
  const eng = engines.get(sym)
  if (!eng) return
  const price = num(ev.price), size = num(ev.size), t = num(ev.time)
  if (price == null || size == null || t == null) return
  const type = String(ev.type ?? 'NEW')
  const trade = {
    t, price, size, type,
    id: ev.index != null ? String(ev.index) : `${t}:${ev.sequence ?? ''}`,
    bid: num(ev.bidPrice), ask: num(ev.askPrice),
    conds: ev.exchangeSaleConditions ? String(ev.exchangeSaleConditions) : '',
    eth: ev.extendedTradingHours === true || ev.extendedTradingHours === 'true',
    valid: !(ev.validTick === false || ev.validTick === 'false'),
    exch: ev.exchangeCode != null ? String(ev.exchangeCode) : null,
  }
  eng.onTrade(trade)
  printBuf.push({ symbol: sym, t_ms: t, price, size, type, src_id: trade.id, bid: trade.bid, ask: trade.ask, exch: trade.exch, conds: trade.conds, eth: trade.eth, valid: trade.valid, aggressor: ev.aggressorSide != null ? String(ev.aggressorSide) : null, source: SOURCE })
}

async function insertChunks(table: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + 500))
    if (error) console.warn(`[orderflow] ${table} insert failed`, error.message)
  }
}

async function flush() {
  const prints = printBuf.splice(0), quotes = quoteBuf.splice(0)
  await insertChunks('orderflow_prints', prints)
  await insertChunks('orderflow_quotes', quotes)
  const now = Date.now()
  const states = [], alerts = []
  for (const [symbol, eng] of engines) {
    const snap = eng.snapshot(now)
    const slim = { ...snap, chart: (snap.chart ?? []).slice(-CHART_KEEP), alerts: (snap.alerts ?? []).slice(-20), newAlerts: undefined }
    states.push({ symbol, t: new Date(now).toISOString(), session: snap.session, status: snap.status, source: SOURCE, snapshot: slim })
    for (const a of snap.newAlerts ?? []) alerts.push({ id: a.id, symbol, t: new Date(a.t).toISOString(), type: a.type, severity: a.severity, title: a.title, evidence: a.evidence, quote_quality: a.quoteQuality, session: a.session, source: a.source, limitations: a.limitations })
  }
  if (states.length) {
    const { error } = await supabase.from('orderflow_state').upsert(states)
    if (error) console.warn('[orderflow] state upsert failed', error.message)
  }
  if (alerts.length) await insertChunks('orderflow_alerts', alerts)
}

async function prune() {
  const cut = Date.now() - RETAIN_DAYS * 86_400_000
  await supabase.from('orderflow_prints').delete().lt('t_ms', cut)
  await supabase.from('orderflow_quotes').delete().lt('t_ms', cut)
}

export function startOrderflowLoops() {
  setInterval(() => { flush().catch((e) => console.warn('[orderflow] flush', e)) }, FLUSH_MS)
  setInterval(() => { loadContext().catch(() => {}) }, 30 * 60_000)
  setInterval(() => { prune().catch(() => {}) }, 6 * 3_600_000)
}
