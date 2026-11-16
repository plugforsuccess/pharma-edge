// option-chain — real call quotes for the nightly real-quote check (owner,
// 2026-11-16: "Start the real quote check now"). Service-role only; called by
// scripts/quote-check.mjs (GitHub runners get 429 from Yahoo's option chains,
// Supabase's edge does not).
//
// POST { tickers: string[], days?: number (default 30) }
//   → { success, chains: [{ ticker, spot, expiry, dte, calls: [{ strike, bid, ask, last, iv, oi, volume }] }], failed: [...] }
//
// For each ticker: the expiry nearest `days` calendar days out, calls with
// strikes from 0.7× to 2.5× spot. Nothing is stored here.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { yahooOptions } from '../_shared/yahoo.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function isServiceRole(req: Request): boolean {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload?.role === 'service_role'
  } catch { return false }
}

const num = (v: unknown): number | null => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n }

async function one(ticker: string, days: number) {
  const symbol = ticker.replace(/\./g, '-')
  const first = await yahooOptions(symbol)
  const spot = num(first.quote?.regularMarketPrice)
  const now = Date.now() / 1000
  const exps = (first.expirationDates ?? []).filter((x) => x > now)
  if (!(spot && spot > 0) || !exps.length) return { ticker, spot, expiry: null, dte: null, calls: [] }
  const target = now + days * 86400
  const exp = exps.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
  const res = first.options?.[0]?.expirationDate === exp ? first : await yahooOptions(symbol, exp)
  const calls = (res.options?.[0]?.calls ?? [])
    .filter((c) => (c.strike ?? 0) >= spot * 0.7 && (c.strike ?? 0) <= spot * 2.5)
    .map((c) => ({ strike: c.strike, bid: num(c.bid), ask: num(c.ask), last: num(c.lastPrice), iv: num(c.impliedVolatility), oi: num(c.openInterest), volume: num(c.volume) }))
  return { ticker, spot, expiry: new Date(exp * 1000).toISOString().slice(0, 10), dte: Math.round((exp - now) / 86400), calls }
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ success: false, error: 'POST only' }, 405)
  if (!isServiceRole(req)) return json({ success: false, error: 'service role only' }, 403)
  const body = await req.json().catch(() => ({}))
  const tickers: string[] = (Array.isArray(body.tickers) ? body.tickers : []).map((t: unknown) => String(t).trim().toUpperCase()).filter((t: string) => /^[A-Z][A-Z0-9.-]{0,11}$/.test(t)).slice(0, 40)
  const days = Math.min(120, Math.max(7, Number(body.days) || 30))
  const chains: unknown[] = [], failed: string[] = []
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < tickers.length) {
      const t = tickers[next++]
      try { chains.push(await one(t, days)) } catch (e) { failed.push(`${t}: ${(e as Error).message}`) }
    }
  }))
  return json({ success: true, chains, failed })
})
