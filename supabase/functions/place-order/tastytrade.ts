// Tastytrade auth + REST helpers for Pharma Edge edge functions.
//
// Tastytrade uses session-token auth (POST /sessions with username +
// password returns a 24h session-token). To avoid logging in on every
// invocation, we cache the token in `public.tastytrade_sessions` and
// re-login on 401 or when within 5 minutes of expiry.

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
  // Sessions live ~24h. Treat 23h as the safe expiry to leave headroom.
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

export async function tastytradeFetch(
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
      'Content-Type': 'application/json',
    },
  })
  if (resp.status === 401) {
    // Cache invalid; re-login once and retry.
    session = await getSession(supabase, true)
    resp = await fetch(`${TASTYTRADE_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: session.token,
        'Content-Type': 'application/json',
      },
    })
  }
  return resp
}

// OCC option symbol: 6-char root (space-padded) + YYMMDD + C/P + 8-digit
// strike × 1000. Total 21 chars. Tastytrade's equity-option leg `symbol`
// field expects this format.
export function buildOccSymbol(
  ticker: string,
  expiry: string, // 'YYYY-MM-DD'
  optionType: 'P' | 'C',
  strike: number,
): string {
  const root = ticker.toUpperCase().padEnd(6, ' ')
  const yymmdd = expiry.replace(/-/g, '').slice(2)
  const strikeInt = Math.round(strike * 1000)
  const strikeStr = String(strikeInt).padStart(8, '0')
  return `${root}${yymmdd}${optionType}${strikeStr}`
}

export const TASTYTRADE_BASE_URL_FOR_DISPLAY = TASTYTRADE_BASE
