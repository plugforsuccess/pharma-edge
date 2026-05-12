// Shared Tastytrade auth + REST helpers + OCC symbol builder.
//
// Re-exports from bot-place-entry/tastytrade.ts (kept there for v1
// stability). New strategies should import from here so we only have
// one copy of the OAuth refresh flow long-term.
//
// Auth model and required secrets: see bot-place-entry/tastytrade.ts.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TASTYTRADE_BASE =
  Deno.env.get('TASTYTRADE_BASE_URL') || 'https://api.cert.tastyworks.com'
const TASTYTRADE_CLIENT_ID = Deno.env.get('TASTYTRADE_CLIENT_ID')
const TASTYTRADE_CLIENT_SECRET = Deno.env.get('TASTYTRADE_CLIENT_SECRET')
const TASTYTRADE_REFRESH_TOKEN_BOOTSTRAP = Deno.env.get('TASTYTRADE_REFRESH_TOKEN')
const SESSION_REFRESH_BUFFER_MS = 5 * 60 * 1000

export const TASTYTRADE_BASE_URL = TASTYTRADE_BASE
export const IS_SANDBOX = /cert\.tastyworks/.test(TASTYTRADE_BASE)

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
  const refreshToken = data.refresh_token || TASTYTRADE_REFRESH_TOKEN_BOOTSTRAP
  if (!refreshToken) return null
  return { accessToken: data.session_token, refreshToken, expiresAt }
}

async function resolveRefreshToken(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase
    .from('tastytrade_sessions')
    .select('refresh_token, auth_kind')
    .eq('id', 1)
    .maybeSingle()
  if (data?.auth_kind === 'oauth' && data.refresh_token) return data.refresh_token
  if (TASTYTRADE_REFRESH_TOKEN_BOOTSTRAP) return TASTYTRADE_REFRESH_TOKEN_BOOTSTRAP
  throw new TastytradeError('No Tastytrade refresh_token available', 500)
}

async function refreshAccessToken(supabase: SupabaseClient): Promise<CachedSession> {
  if (!TASTYTRADE_CLIENT_ID || !TASTYTRADE_CLIENT_SECRET) {
    throw new TastytradeError('TASTYTRADE_CLIENT_ID/SECRET not set', 500)
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
    throw new TastytradeError(`oauth refresh failed: ${resp.status}`, resp.status, detail.slice(0, 500))
  }
  const body = await resp.json()
  const accessToken: string | undefined = body?.access_token
  const expiresIn: number = Number(body?.expires_in) || 23 * 60 * 60
  const newRefresh: string = body?.refresh_token || refreshToken
  if (!accessToken) throw new TastytradeError('oauth refresh: no access_token', 502, body)
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
        remember_token: null,
      },
      { onConflict: 'id' },
    )
  return { accessToken, refreshToken: newRefresh, expiresAt }
}

async function getSession(supabase: SupabaseClient, forceRefresh = false): Promise<CachedSession> {
  if (!forceRefresh) {
    const cached = await loadCached(supabase)
    if (cached && cached.expiresAt.getTime() - Date.now() > SESSION_REFRESH_BUFFER_MS) return cached
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
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
  })
  if (resp.status === 401) {
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

export function buildOccSymbol(
  ticker: string,
  expiry: string,
  optionType: 'P' | 'C',
  strike: number,
): string {
  const root = ticker.toUpperCase().padEnd(6, ' ')
  const yymmdd = expiry.replace(/-/g, '').slice(2)
  const strikeInt = Math.round(strike * 1000)
  const strikeStr = String(strikeInt).padStart(8, '0')
  return `${root}${yymmdd}${optionType}${strikeStr}`
}
