// Tastytrade auth + REST helpers for Cash Moves edge functions.
//
// Auth model: OAuth2 refresh-token grant. Cameron's first-party
// "Personal OAuth Grant" mints a long-lived refresh_token; we trade
// it for short-lived access_tokens (~24h) on demand and cache them
// in `public.tastytrade_sessions` so we don't hammer the OAuth
// endpoint on every invocation.
//
// Required Supabase secrets:
//   TASTYTRADE_CLIENT_ID
//   TASTYTRADE_CLIENT_SECRET
//   TASTYTRADE_REFRESH_TOKEN   (bootstrap value; rotated copies live in DB)
//
// Optional:
//   TASTYTRADE_BASE_URL        (defaults to api.cert.tastyworks.com sandbox)
//
// The legacy username/password path is gone — it was hitting Tastytrade's
// device-challenge wall on new IPs and is not viable for a server-side
// integration anyway.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TASTYTRADE_BASE =
  Deno.env.get('TASTYTRADE_BASE_URL') || 'https://api.cert.tastyworks.com'
const TASTYTRADE_CLIENT_ID = Deno.env.get('TASTYTRADE_CLIENT_ID')
const TASTYTRADE_CLIENT_SECRET = Deno.env.get('TASTYTRADE_CLIENT_SECRET')
const TASTYTRADE_REFRESH_TOKEN_BOOTSTRAP = Deno.env.get('TASTYTRADE_REFRESH_TOKEN')
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
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

async function loadCached(supabase: SupabaseClient): Promise<CachedSession | null> {
  const { data } = await supabase
    .from('tastytrade_sessions')
    .select('session_token, refresh_token, expires_at, auth_kind')
    .eq('id', 1)
    .maybeSingle()
  if (data?.auth_kind && data.auth_kind !== 'oauth') return null
  if (!data?.session_token || !data.expires_at) return null
  const expiresAt = new Date(data.expires_at)
  if (Number.isNaN(expiresAt.getTime())) return null
  // refresh_token in DB takes precedence over the bootstrap secret —
  // Tastytrade may rotate it on grant exchanges.
  const refreshToken = data.refresh_token || TASTYTRADE_REFRESH_TOKEN_BOOTSTRAP
  if (!refreshToken) return null
  return { accessToken: data.session_token, refreshToken, expiresAt }
}

// Resolve a refresh_token to use for the next /oauth/token POST. DB row
// wins; secret is the cold-start bootstrap.
async function resolveRefreshToken(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase
    .from('tastytrade_sessions')
    .select('refresh_token, auth_kind')
    .eq('id', 1)
    .maybeSingle()
  if (data?.auth_kind === 'oauth' && data.refresh_token) return data.refresh_token
  if (TASTYTRADE_REFRESH_TOKEN_BOOTSTRAP) return TASTYTRADE_REFRESH_TOKEN_BOOTSTRAP
  throw new TastytradeError(
    'No Tastytrade refresh_token available — set TASTYTRADE_REFRESH_TOKEN secret or seed the tastytrade_sessions row.',
    500,
  )
}

async function refreshAccessToken(supabase: SupabaseClient): Promise<CachedSession> {
  if (!TASTYTRADE_CLIENT_ID || !TASTYTRADE_CLIENT_SECRET) {
    throw new TastytradeError(
      'TASTYTRADE_CLIENT_ID / TASTYTRADE_CLIENT_SECRET not set as Supabase secrets',
      500,
    )
  }
  const refreshToken = await resolveRefreshToken(supabase)
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: TASTYTRADE_CLIENT_ID,
    client_secret: TASTYTRADE_CLIENT_SECRET,
  })
  const resp = await fetch(`${TASTYTRADE_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new TastytradeError(
      `tastytrade oauth refresh failed: ${resp.status}`,
      resp.status,
      detail.slice(0, 500),
    )
  }
  const body = await resp.json()
  const accessToken: string | undefined = body?.access_token
  const expiresIn: number = Number(body?.expires_in) || 23 * 60 * 60
  // Tastytrade may rotate the refresh_token; fall back to the one we
  // sent if the response doesn't include a new one.
  const newRefresh: string = body?.refresh_token || refreshToken
  if (!accessToken) {
    throw new TastytradeError('tastytrade oauth refresh: no access_token in response', 502, body)
  }
  // Subtract a 5-min buffer so we proactively refresh before real expiry.
  const expiresAt = new Date(Date.now() + (expiresIn - 300) * 1000)
  await supabase
    .from('tastytrade_sessions')
    .upsert(
      {
        id: 1,
        session_token: accessToken,
        refresh_token: newRefresh,
        auth_kind: 'oauth',
        expires_at: expiresAt.toISOString(),
        refreshed_at: new Date().toISOString(),
        // remember_token is a session-token-flow concept; null it out.
        remember_token: null,
      },
      { onConflict: 'id' },
    )
  return { accessToken, refreshToken: newRefresh, expiresAt }
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
  return refreshAccessToken(supabase)
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
      // OAuth bearer scheme — replaces the raw session-token header
      // used by the legacy /sessions login flow.
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
  })
  if (resp.status === 401) {
    // Access token rejected — refresh once and retry.
    session = await getSession(supabase, true)
    resp = await fetch(`${TASTYTRADE_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${session.accessToken}`,
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
