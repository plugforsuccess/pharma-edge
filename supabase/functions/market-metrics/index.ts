// market-metrics — Tastytrade /market-metrics for the chart universe
// (owner, 2026-10-06: "use Tastytrade for LEAPS data"). Service-role only;
// called nightly by .github/workflows/market-metrics.yml.
//
// POST { symbols?: string[], dry_run?: boolean }
//   → { success, fetched, written, iv_written, missing: [...], dry_run }
//
// For every symbol (default: CHART_TICKERS + SPY, QQQ + the sector ETFs)
// in batches of 100: IV index, IV rank / percentile, IV 5-day change,
// historical vol 30 / 60 / 90, IV−HV, beta, liquidity, next earnings,
// next dividend, market cap, P/E → market_metrics (upsert by symbol).
// The IV index also goes to iv_history (source 'tastytrade') for the
// sample date, so the entry chart's IV Rank converges on the broker's IV
// instead of the Yahoo ATM scrape (same date rows are replaced — this job
// runs after iv-quotes.yml on purpose).
//
// Tastytrade reports IV rank / percentile as decimals (0.34); stored as
// 0–100. Requires the live OAuth secrets (sandbox metrics are mock).

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tastytradeFetch } from '../_shared/tastytrade.ts'
import { CHART_TICKERS } from '../_shared/chartTickers.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const EXTRA = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC']
const BATCH = 100

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function isServiceRole(req: Request): boolean {
  const auth = req.headers.get('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload?.role === 'service_role'
  } catch { return false }
}

const num = (v: unknown): number | null => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n }
const pct100 = (v: unknown): number | null => { const n = num(v); return n == null ? null : n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10 }
const date = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

function parseItem(item: Record<string, unknown>) {
  const earnings = (item['earnings'] ?? {}) as Record<string, unknown>
  return {
    symbol: String(item['symbol'] ?? '').toUpperCase(),
    iv: num(item['implied-volatility-index']),
    iv_rank: pct100(item['implied-volatility-index-rank'] ?? item['tw-implied-volatility-index-rank']),
    iv_percentile: pct100(item['implied-volatility-percentile']),
    iv_5d_change: num(item['implied-volatility-index-5-day-change']),
    hv_30: num(item['historical-volatility-30-day']),
    hv_60: num(item['historical-volatility-60-day']),
    hv_90: num(item['historical-volatility-90-day']),
    iv_hv_30_diff: num(item['iv-hv-30-day-difference']),
    beta: num(item['beta']),
    liquidity_rating: num(item['liquidity-rating']) == null ? null : Math.round(num(item['liquidity-rating'])!),
    liquidity_value: num(item['liquidity-value']),
    earnings_date: date(earnings['expected-report-date']),
    earnings_time: typeof earnings['time-of-day'] === 'string' ? String(earnings['time-of-day']) : null,
    earnings_actual_eps: num(earnings['actual-eps']),
    dividend_next_date: date(item['dividend-next-date']),
    dividend_yield: num(item['dividend-yield']),
    market_cap: num(item['market-cap']),
    pe_ratio: num(item['price-earnings-ratio']),
    iv_updated_at: typeof item['implied-volatility-updated-at'] === 'string' ? String(item['implied-volatility-updated-at']) : null,
    updated_at: new Date().toISOString(),
  }
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!isServiceRole(req)) return json({ success: false, error: 'service role required' }, 403)
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body is fine */ }
  const dryRun = body.dry_run === true
  const requested = Array.isArray(body.symbols) ? body.symbols.map((s) => String(s).toUpperCase()) : null
  const symbols = [...new Set((requested ?? [...CHART_TICKERS, ...EXTRA]).filter((s) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(s)))]
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  const rows: ReturnType<typeof parseItem>[] = []
  const errors: string[] = []
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH)
    try {
      const resp = await tastytradeFetch(db, `/market-metrics?symbols=${batch.map(encodeURIComponent).join(',')}`, {}, 'live')
      if (!resp.ok) { errors.push(`batch ${i / BATCH}: ${resp.status} ${(await resp.text()).slice(0, 120)}`); continue }
      const data = await resp.json()
      for (const item of (data?.data?.items ?? []) as Record<string, unknown>[]) {
        const r = parseItem(item)
        if (r.symbol) rows.push(r)
      }
    } catch (e) { errors.push(`batch ${i / BATCH}: ${(e as Error).message}`) }
  }
  const got = new Set(rows.map((r) => r.symbol))
  const missing = symbols.filter((s) => !got.has(s))
  const today = new Date().toISOString().slice(0, 10)
  const ivRows = rows.filter((r) => r.iv != null && r.iv >= 0.02 && r.iv <= 3).map((r) => ({ ticker: r.symbol, sample_date: today, iv_30d: r.iv, source: 'tastytrade' }))

  let written = 0, ivWritten = 0
  if (!dryRun) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from('market_metrics').upsert(rows.slice(i, i + 500), { onConflict: 'symbol' })
      if (error) errors.push(`market_metrics upsert: ${error.message}`); else written += Math.min(500, rows.length - i)
    }
    for (let i = 0; i < ivRows.length; i += 500) {
      const { error } = await db.from('iv_history').upsert(ivRows.slice(i, i + 500), { onConflict: 'ticker,sample_date' })
      if (error) errors.push(`iv_history upsert: ${error.message}`); else ivWritten += Math.min(500, ivRows.length - i)
    }
  }
  return json({ success: errors.length === 0, dry_run: dryRun, requested: symbols.length, fetched: rows.length, written, iv_written: ivWritten, missing: missing.slice(0, 50), missing_count: missing.length, errors, sample: rows[0] ?? null })
})
