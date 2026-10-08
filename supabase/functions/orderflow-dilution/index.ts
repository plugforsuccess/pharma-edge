// orderflow-dilution — SEC filing / dilution risk and float for NIGHTFLOW.
// POST { symbol, refresh?: boolean } → { success, symbol, cik, level, score,
// summary, hits, float_shares, shares_outstanding, checked_at, cached }
//
// EDGAR: company_tickers.json maps the ticker to a CIK, then
// data.sec.gov/submissions/CIK##########.json lists recent filings (form,
// date, 8-K items). dilutionRisk() (generated copy of
// src/utils/orderflow/dilution.js) turns them into a 0–1 factor. It flags
// filings that let a company sell stock — not whether it will. Float from
// Yahoo key statistics. Cached 12 h in orderflow_dilution (service role);
// the dxlink-worker reads the cache into its engines.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { dilutionRisk } from '../_shared/orderflowDilution.js'
import { yahooKeyStats } from '../_shared/yahoo.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// SEC asks automated clients to identify themselves.
const SEC_UA = Deno.env.get('SEC_USER_AGENT') ?? 'Cash Moves research admin@cashmoves.io'
const TTL_MS = 12 * 3_600_000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

let tickerMap: Map<string, string> | null = null
async function cikFor(symbol: string): Promise<string | null> {
  if (!tickerMap) {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': SEC_UA } })
    if (!r.ok) throw new Error(`SEC tickers ${r.status}`)
    const body = await r.json() as Record<string, { cik_str: number; ticker: string }>
    tickerMap = new Map(Object.values(body).map((x) => [x.ticker.toUpperCase(), String(x.cik_str).padStart(10, '0')]))
  }
  return tickerMap.get(symbol.replace('.', '-')) ?? tickerMap.get(symbol) ?? null
}

async function filingsFor(cik: string) {
  const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': SEC_UA } })
  if (!r.ok) throw new Error(`SEC submissions ${r.status}`)
  const rec = (await r.json())?.filings?.recent ?? {}
  const forms: string[] = rec.form ?? []
  return forms.map((form, i) => ({ form, filed: rec.filingDate?.[i], items: rec.items?.[i] ?? '' })).filter((f) => f.filed)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const body = await req.json().catch(() => ({}))
    const symbol = String(body.symbol ?? '').trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) return json({ success: false, error: 'bad symbol' }, 400)
    const db = createClient(SUPABASE_URL, SERVICE_KEY)
    const { data: cached } = await db.from('orderflow_dilution').select('*').eq('symbol', symbol).maybeSingle()
    if (cached && !body.refresh && Date.now() - Date.parse(cached.checked_at) < TTL_MS) return json({ success: true, cached: true, ...cached })

    let cik: string | null = null, risk = dilutionRisk(null), secError: string | null = null
    try {
      cik = await cikFor(symbol)
      risk = cik ? dilutionRisk(await filingsFor(cik)) : { score: null, level: 'unknown', summary: 'no SEC filer found for this ticker', hits: [] }
    } catch (e) { secError = (e as Error).message }
    let ks = { floatShares: null as number | null, sharesOutstanding: null as number | null }
    try { ks = await yahooKeyStats(symbol) } catch { /* float stays unknown */ }

    const row = {
      symbol, checked_at: new Date().toISOString(), cik, level: risk.level, score: risk.score,
      summary: secError ? `SEC lookup failed (${secError})` : risk.summary, hits: risk.hits,
      float_shares: ks.floatShares, shares_outstanding: ks.sharesOutstanding,
    }
    await db.from('orderflow_dilution').upsert(row)
    return json({ success: true, cached: false, ...row })
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500)
  }
})
