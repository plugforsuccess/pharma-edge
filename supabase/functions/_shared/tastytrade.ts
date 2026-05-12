// Shared Tastytrade auth + REST helpers + OCC symbol builder.
//
// Dual-env routing: every call must specify `env: 'live' | 'cert'`.
// Each env has its own OAuth app on Tastytrade (separate client_id +
// client_secret + refresh_token) and its own base URL. Session
// access-tokens are cached per env in tastytrade_sessions(env).
//
// Required Supabase secrets:
//   * Production (live):
//     TASTYTRADE_CLIENT_ID
//     TASTYTRADE_CLIENT_SECRET
//     TASTYTRADE_REFRESH_TOKEN
//     TASTYTRADE_BASE_URL          (defaults to https://api.tastyworks.com)
//   * Cert sandbox:
//     TASTYTRADE_CERT_CLIENT_ID
//     TASTYTRADE_CERT_CLIENT_SECRET
//     TASTYTRADE_CERT_REFRESH_TOKEN
//     TASTYTRADE_CERT_BASE_URL     (defaults to https://api.cert.tastyworks.com)

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export type TtEnv = 'live' | 'cert'

interface EnvConfig {
  baseUrl: string
  clientId: string | undefined
  clientSecret: string | undefined
  bootstrapRefreshToken: string | undefined
}

function envConfig(env: TtEnv): EnvConfig {
  if (env === 'cert') {
    return {
      baseUrl: Deno.env.get('TASTYTRADE_CERT_BASE_URL') || 'https://api.cert.tastyworks.com',
      clientId: Deno.env.get('TASTYTRADE_CERT_CLIENT_ID'),
      clientSecret: Deno.env.get('TASTYTRADE_CERT_CLIENT_SECRET'),
      bootstrapRefreshToken: Deno.env.get('TASTYTRADE_CERT_REFRESH_TOKEN'),
    }
  }
  return {
    baseUrl: Deno.env.get('TASTYTRADE_BASE_URL') || 'https://api.tastyworks.com',
    clientId: Deno.env.get('TASTYTRADE_CLIENT_ID'),
    clientSecret: Deno.env.get('TASTYTRADE_CLIENT_SECRET'),
    bootstrapRefreshToken: Deno.env.get('TASTYTRADE_REFRESH_TOKEN'),
  }
}

// Map bot_config.mode → env. Centralised here so every caller maps
// the same way; flipping mode automatically flips routing.
export function envFromMode(mode: string | null | undefined): TtEnv {
  return mode === 'paper' ? 'cert' : 'live'
}

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

async function loadCached(supabase: SupabaseClient, env: TtEnv): Promise<CachedSession | null> {
  const { data } = await supabase
    .from('tastytrade_sessions')
    .select('session_token, refresh_token, expires_at, auth_kind')
    .eq('env', env)
    .maybeSingle()
  if (data?.auth_kind && data.auth_kind !== 'oauth') return null
  if (!data?.session_token || !data.expires_at) return null
  const expiresAt = new Date(data.expires_at)
  if (Number.isNaN(expiresAt.getTime())) return null
  const refreshToken = data.refresh_token || envConfig(env).bootstrapRefreshToken
  if (!refreshToken) return null
  return { accessToken: data.session_token, refreshToken, expiresAt }
}

async function resolveRefreshToken(supabase: SupabaseClient, env: TtEnv): Promise<string> {
  const { data } = await supabase
    .from('tastytrade_sessions')
    .select('refresh_token, auth_kind')
    .eq('env', env)
    .maybeSingle()
  if (data?.auth_kind === 'oauth' && data.refresh_token) return data.refresh_token
  const bootstrap = envConfig(env).bootstrapRefreshToken
  if (bootstrap) return bootstrap
  throw new TastytradeError(`No Tastytrade refresh_token available for env=${env}`, 500)
}

async function refreshAccessToken(supabase: SupabaseClient, env: TtEnv): Promise<CachedSession> {
  const cfg = envConfig(env)
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new TastytradeError(
      `TASTYTRADE${env === 'cert' ? '_CERT' : ''}_CLIENT_ID / SECRET not set`, 500)
  }
  const refreshToken = await resolveRefreshToken(supabase, env)
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  })
  const resp = await fetch(`${cfg.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new TastytradeError(`oauth refresh failed (${env}): ${resp.status}`, resp.status, detail.slice(0, 500))
  }
  const body = await resp.json()
  const accessToken: string | undefined = body?.access_token
  const expiresIn: number = Number(body?.expires_in) || 23 * 60 * 60
  const newRefresh: string = body?.refresh_token || refreshToken
  if (!accessToken) throw new TastytradeError(`oauth refresh (${env}): no access_token`, 502, body)
  const expiresAt = new Date(Date.now() + (expiresIn - 300) * 1000)
  await supabase
    .from('tastytrade_sessions')
    .upsert(
      {
        env,
        session_token: accessToken,
        refresh_token: newRefresh,
        auth_kind: 'oauth',
        expires_at: expiresAt.toISOString(),
        refreshed_at: new Date().toISOString(),
        remember_token: null,
      },
      { onConflict: 'env' },
    )
  return { accessToken, refreshToken: newRefresh, expiresAt }
}

async function getSession(supabase: SupabaseClient, env: TtEnv, forceRefresh = false): Promise<CachedSession> {
  if (!forceRefresh) {
    const cached = await loadCached(supabase, env)
    if (cached && cached.expiresAt.getTime() - Date.now() > SESSION_REFRESH_BUFFER_MS) return cached
  }
  return refreshAccessToken(supabase, env)
}

export async function tastytradeFetch(
  supabase: SupabaseClient,
  path: string,
  init: RequestInit = {},
  env: TtEnv = 'live',
): Promise<Response> {
  const cfg = envConfig(env)
  let session = await getSession(supabase, env)
  let resp = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
  })
  if (resp.status === 401) {
    session = await getSession(supabase, env, true)
    resp = await fetch(`${cfg.baseUrl}${path}`, {
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

export function isSandboxEnv(env: TtEnv): boolean { return env === 'cert' }

export const TASTYTRADE_LIVE_BASE_URL = envConfig('live').baseUrl
export const TASTYTRADE_CERT_BASE_URL = envConfig('cert').baseUrl

// Back-compat exports. Old callers used `IS_SANDBOX` to gate sandbox-NLV
// behavior. Keep as `false` since 'live' is the default env — callers
// that care should switch to `isSandboxEnv(env)`.
export const IS_SANDBOX = false

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
