// Tastytrade auth + REST helpers, scoped to compute-gex's needs:
// session-token auth, nested option chain, batched market-data quotes.
//
// Mirrors the auth flow in analyze-signal/tastytrade.ts and
// get-account/tastytrade.ts (cached session in tastytrade_sessions,
// re-login on 401 or expiry). Shared code lives per-function because
// Supabase Edge Functions don't support cross-function imports.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TASTYTRADE_BASE =
  Deno.env.get('TASTYTRADE_BASE_URL') || 'https://api.cert.tastyworks.com'
const TASTYTRADE_USERNAME = Deno.env.get('TASTYTRADE_USERNAME')
const TASTYTRADE_PASSWORD = Deno.env.get('TASTYTRADE_PASSWORD')
const SESSION_REFRESH_BUFFER_MS = 5 * 60 * 1000

export class TastytradeError extends Error {
  status?: number
  detail?: unknown
  constructor(message: string, status?: number, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

interface CachedSession {
  token: string
  expiresAt: Date
}

async function loadCached(supabase: SupabaseClient): Promise<CachedSession | null> {
  const { data } = await supabase
    .from('tastytrade_sessions')
    .select('session_token, expires_at')
    .eq('id', 1)
    .maybeSingle()
  if (!data?.session_token || !data.expires_at) return null
  const expiresAt = new Date(data.expires_at)
  if (Number.isNaN(expiresAt.getTime())) return null
  return { token: data.session_token, expiresAt }
}

async function login(supabase: SupabaseClient): Promise<CachedSession> {
  if (!TASTYTRADE_USERNAME || !TASTYTRADE_PASSWORD) {
    throw new TastytradeError(
      'TASTYTRADE_USERNAME / TASTYTRADE_PASSWORD not set as Supabase secrets',
      500,
    )
  }
  const resp = await fetch(`${TASTYTRADE_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      login: TASTYTRADE_USERNAME,
      password: TASTYTRADE_PASSWORD,
      'remember-me': true,
    }),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new TastytradeError(
      `tastytrade login failed: ${resp.status}`,
      resp.status,
      detail.slice(0, 500),
    )
  }
  const body = await resp.json()
  const token = body?.data?.['session-token']
  if (!token) {
    throw new TastytradeError('tastytrade login: no session-token in response', 502, body)
  }
  const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000)
  await supabase
    .from('tastytrade_sessions')
    .upsert(
      {
        id: 1,
        session_token: token,
        remember_token: body?.data?.['remember-token'] ?? null,
        expires_at: expiresAt.toISOString(),
        refreshed_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )
  return { token, expiresAt }
}

async function getSession(
  supabase: SupabaseClient,
  forceRefresh = false,
): Promise<CachedSession> {
  if (!forceRefresh) {
    const cached = await loadCached(supabase)
    if (cached && cached.expiresAt.getTime() - Date.now() > SESSION_REFRESH_BUFFER_MS) {
      return cached
    }
  }
  return login(supabase)
}

async function tastytradeFetch(
  supabase: SupabaseClient,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let session = await getSession(supabase)
  let resp = await fetch(`${TASTYTRADE_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: session.token,
    },
  })
  if (resp.status === 401) {
    session = await getSession(supabase, true)
    resp = await fetch(`${TASTYTRADE_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: session.token,
      },
    })
  }
  return resp
}

// ─── Option chain ──────────────────────────────────────────────────
//
// /option-chains/{symbol}/nested returns a single root with one or more
// expirations, each with a strike list that carries call+put OCC symbols.
// We pick the expiration closest to (but not before) the requested
// `targetExpiry`. For "front month" the caller passes today; we'll
// land on the next standard Friday expiry the chain offers.

export interface ChainStrike {
  strike: number
  callSymbol: string  // streamer-symbol style, e.g. "AAPL  240119C00150000"
  putSymbol: string
}

export interface ChainExpiration {
  expirationDate: string
  daysToExpiration: number
  strikes: ChainStrike[]
}

export async function fetchNestedChain(
  supabase: SupabaseClient,
  ticker: string,
): Promise<ChainExpiration[]> {
  const resp = await tastytradeFetch(
    supabase,
    `/option-chains/${encodeURIComponent(ticker.toUpperCase())}/nested`,
  )
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new TastytradeError(
      `chain fetch failed: ${resp.status}`,
      resp.status,
      detail.slice(0, 500),
    )
  }
  const body = await resp.json().catch(() => null)
  const root = body?.data?.items?.[0]
  if (!root) return []
  const rawExpirations = (root['expirations'] ?? []) as Array<Record<string, unknown>>
  return rawExpirations
    .map((exp) => {
      const strikes = (exp['strikes'] ?? []) as Array<Record<string, unknown>>
      return {
        expirationDate: String(exp['expiration-date'] ?? ''),
        daysToExpiration: Number(exp['days-to-expiration'] ?? 0),
        strikes: strikes
          .map((s) => ({
            strike: Number(s['strike-price']),
            callSymbol: String(s['call'] ?? ''),
            putSymbol: String(s['put'] ?? ''),
          }))
          .filter((s) => Number.isFinite(s.strike) && s.callSymbol && s.putSymbol),
      }
    })
    .filter((e) => e.expirationDate && e.strikes.length > 0)
}

// ─── Quotes ───────────────────────────────────────────────────────
//
// /market-data/by-type accepts comma-separated symbol lists per type.
// For options we use `equity-option=...` and read open-interest +
// implied-volatility + last off the result. The endpoint caps at a
// few hundred symbols per call — chunk on the caller side.

export interface OptionQuote {
  symbol: string
  openInterest: number | null
  impliedVolatility: number | null  // decimal, 0.42 = 42%
  last: number | null
  bid: number | null
  ask: number | null
}

const QUOTE_BATCH_SIZE = 400

export async function fetchOptionQuotes(
  supabase: SupabaseClient,
  occSymbols: string[],
): Promise<Map<string, OptionQuote>> {
  const out = new Map<string, OptionQuote>()
  if (occSymbols.length === 0) return out

  for (let i = 0; i < occSymbols.length; i += QUOTE_BATCH_SIZE) {
    const batch = occSymbols.slice(i, i + QUOTE_BATCH_SIZE)
    const qs = `equity-option=${batch.map(encodeURIComponent).join(',')}`
    const resp = await tastytradeFetch(
      supabase,
      `/market-data/by-type?${qs}`,
    )
    if (!resp.ok) continue
    const body = await resp.json().catch(() => null) as
      | { data?: { items?: Array<Record<string, unknown>> } }
      | null
    const items = body?.data?.items ?? []
    for (const item of items) {
      const sym = String(item['symbol'] ?? '')
      if (!sym) continue
      const num = (v: unknown): number | null => {
        if (v == null || v === '') return null
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }
      out.set(sym, {
        symbol: sym,
        openInterest: num(item['open-interest']),
        impliedVolatility: num(item['implied-volatility']),
        last: num(item['last']),
        bid: num(item['bid']),
        ask: num(item['ask']),
      })
    }
  }
  return out
}

export interface EquityQuoteDiagnostic {
  endpointTried: string
  status: number
  bodyShape: string
}

// Tries multiple Tastytrade quote endpoints because the sandbox's
// behaviour around equity quotes is inconsistent — single-symbol
// /market-data/{symbol} is the most reliable, but some plans only
// surface batched /market-data/by-type. We accept whichever returns
// a usable price first, falling back to bid/ask midpoint as a last
// resort. `diagnostics` accumulates per-attempt info so a 502 can
// surface what actually broke.
export async function fetchEquityLast(
  supabase: SupabaseClient,
  ticker: string,
  diagnostics?: EquityQuoteDiagnostic[],
): Promise<number | null> {
  const sym = ticker.toUpperCase()
  const numFromObj = (obj: Record<string, unknown>): number | null => {
    const candidates = ['last', 'mark', 'mid', 'close', 'prev-close']
    for (const k of candidates) {
      const v = obj[k]
      if (v == null || v === '') continue
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
    const bid = Number(obj['bid'])
    const ask = Number(obj['ask'])
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return (bid + ask) / 2
    }
    return null
  }

  // Attempt 1: /market-data/{symbol} — flat data object, no items array.
  try {
    const path1 = `/market-data/${encodeURIComponent(sym)}`
    const resp = await tastytradeFetch(supabase, path1)
    let shape = 'no-body'
    if (resp.ok) {
      const body = await resp.json().catch(() => null) as
        | { data?: Record<string, unknown> }
        | null
      const data = body?.data
      shape = data ? `flat:${Object.keys(data).slice(0, 6).join(',')}` : 'empty-data'
      if (data) {
        const v = numFromObj(data)
        if (v != null) return v
      }
    }
    diagnostics?.push({ endpointTried: path1, status: resp.status, bodyShape: shape })
  } catch (e) {
    diagnostics?.push({
      endpointTried: 'GET /market-data/{symbol}',
      status: -1,
      bodyShape: e instanceof Error ? `throw:${e.message}` : 'throw',
    })
  }

  // Attempt 2: /market-data/by-type?equity= — items array shape.
  try {
    const path2 = `/market-data/by-type?equity=${encodeURIComponent(sym)}`
    const resp = await tastytradeFetch(supabase, path2)
    let shape = 'no-body'
    if (resp.ok) {
      const body = await resp.json().catch(() => null) as
        | { data?: { items?: Array<Record<string, unknown>> } }
        | null
      const item = body?.data?.items?.[0]
      shape = item ? `items[0]:${Object.keys(item).slice(0, 6).join(',')}` : 'empty-items'
      if (item) {
        const v = numFromObj(item)
        if (v != null) return v
      }
    }
    diagnostics?.push({ endpointTried: path2, status: resp.status, bodyShape: shape })
  } catch (e) {
    diagnostics?.push({
      endpointTried: 'GET /market-data/by-type',
      status: -1,
      bodyShape: e instanceof Error ? `throw:${e.message}` : 'throw',
    })
  }

  return null
}
