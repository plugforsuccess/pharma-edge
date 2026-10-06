// LEAPS contract streaming (owner, 2026-10-06: "use Tastytrade for LEAPS
// data"). Beyond the GEX chain plan, the worker streams the long-dated
// calls the app cares about:
//   * leaps_watch — the contracts suggest-leaps picked (sector + index)
//   * leaps_positions — every open option holding (equity_option rows)
// Each resolves to a dxFeed streamer symbol through the nested chain for
// its ticker (authoritative; a constructed `.TICKERyymmddC150` is the
// fallback when the chain omits it), then subscribes Quote / Greeks /
// Summary / Trade like any other option. Rows land in dxlink_quotes with
// underlying / expiration / strike / type, so suggest-leaps and the app
// find them by contract, not by symbol. Refreshed every 30 minutes
// (suggest-leaps re-picks and holdings change intraday).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchNestedChain, type ChainExpiration, type SessionAuth } from './tastytrade.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

export const LEAPS_REFRESH_MS = 30 * 60 * 1000

export interface LeapsContract {
  ticker: string
  expirationDate: string
  strike: number
  optionType: 'C' | 'P'
  source: string
}

export interface LeapsMeta {
  streamer: string
  occ: string
  ticker: string
  expirationDate: string
  strike: number
  optionType: 'C' | 'P'
}

export async function fetchLeapsContracts(): Promise<LeapsContract[]> {
  const out = new Map<string, LeapsContract>()
  const key = (c: LeapsContract) => `${c.ticker}|${c.expirationDate}|${c.strike}|${c.optionType}`
  const { data: watch, error: e1 } = await supabase.from('leaps_watch')
    .select('ticker, expiration_date, strike, option_type, source')
    .gte('updated_at', new Date(Date.now() - 14 * 86400e3).toISOString())
  if (e1) console.warn('[leaps] leaps_watch read failed:', e1.message)
  for (const r of watch ?? []) {
    const c = { ticker: String(r.ticker).toUpperCase(), expirationDate: String(r.expiration_date), strike: Number(r.strike), optionType: r.option_type as 'C' | 'P', source: String(r.source) }
    if (c.ticker && c.expirationDate && Number.isFinite(c.strike)) out.set(key(c), c)
  }
  const { data: pos, error: e2 } = await supabase.from('leaps_positions')
    .select('ticker, expiration, strike, option_type')
    .eq('instrument_type', 'equity_option').is('closed_at', null)
    .not('expiration', 'is', null).not('strike', 'is', null)
  if (e2) console.warn('[leaps] leaps_positions read failed:', e2.message)
  for (const r of pos ?? []) {
    const c = { ticker: String(r.ticker).toUpperCase(), expirationDate: String(r.expiration), strike: Number(r.strike), optionType: (r.option_type ?? 'C') as 'C' | 'P', source: 'position' }
    if (c.ticker && c.expirationDate >= new Date().toISOString().slice(0, 10) && Number.isFinite(c.strike)) out.set(key(c), c)
  }
  return [...out.values()]
}

// dxFeed option symbol: .ROOT + yymmdd + C/P + strike (no trailing zeros).
export function constructedStreamer(c: LeapsContract): string {
  const yymmdd = c.expirationDate.replace(/-/g, '').slice(2)
  const strike = String(Number(c.strike.toFixed(3)))
  return `.${c.ticker}${yymmdd}${c.optionType}${strike}`
}

export function occSymbol(c: LeapsContract): string {
  return `${c.ticker.padEnd(6, ' ')}${c.expirationDate.replace(/-/g, '').slice(2)}${c.optionType}${String(Math.round(c.strike * 1000)).padStart(8, '0')}`
}

export async function resolveLeaps(session: SessionAuth, contracts: LeapsContract[]): Promise<LeapsMeta[]> {
  const byTicker = new Map<string, LeapsContract[]>()
  for (const c of contracts) { if (!byTicker.has(c.ticker)) byTicker.set(c.ticker, []); byTicker.get(c.ticker)!.push(c) }
  const out: LeapsMeta[] = []
  for (const [ticker, list] of byTicker) {
    let chain: ChainExpiration[] = []
    try { chain = await fetchNestedChain(session, ticker) } catch (e) { console.warn(`[leaps] chain for ${ticker} failed:`, (e as Error).message) }
    for (const c of list) {
      const exp = chain.find((e) => e.expirationDate === c.expirationDate)
      const s = exp?.strikes.find((x) => Math.abs(x.strike - c.strike) < 1e-6)
      const streamer = s ? (c.optionType === 'C' ? s.callStreamer : s.putStreamer) : constructedStreamer(c)
      const occ = s ? (c.optionType === 'C' ? s.callOcc : s.putOcc) : occSymbol(c)
      if (!s) console.warn(`[leaps] ${ticker} ${c.expirationDate} ${c.strike}${c.optionType} not in chain — using ${streamer}`)
      out.push({ streamer, occ, ticker, expirationDate: c.expirationDate, strike: c.strike, optionType: c.optionType })
    }
  }
  return out
}
