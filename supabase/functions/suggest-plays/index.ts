// Cash Moves — suggest-plays edge function.
//
// Per-user, per-ticker Suggested Plays endpoint. Wraps the shared
// playSuggester pipeline with: auth check, per-user rate limit via
// claude_calls ledger, 5-min response cache via play_suggestions,
// and response shaping. The actual compute-gex → flow → Claude →
// validate → POP/EV logic lives in _shared/playSuggester.ts so the
// cross-ticker scanner (scan-universe-plays) runs the same prompt.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  generatePlaysForTicker,
  aggregateConfidence,
} from '../_shared/playSuggester.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const RATE_LIMIT_PER_HOUR = Number(Deno.env.get('CLAUDE_RATE_LIMIT_PER_HOUR') ?? '30')
const CACHE_TTL_MS = 5 * 60 * 1000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!ANTHROPIC_API_KEY) return json({ success: false, error: 'ANTHROPIC_API_KEY not configured' }, 500)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY)
    return json({ success: false, error: 'edge function misconfigured' }, 500)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ success: false, error: 'unauthorized' }, 401)

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Rate limit check — counts only user-driven calls (function_name
  // = 'suggest-plays'), so the scanner's system calls don't burn the
  // user's hourly budget.
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: recentCalls } = await adminClient
    .from('claude_calls')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('function_name', 'suggest-plays')
    .gte('called_at', sinceIso)
  if ((recentCalls ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return json(
      { success: false, error: `rate limited: ${RATE_LIMIT_PER_HOUR} analyses per hour reached` },
      429,
    )
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON body' }, 400) }

  const ticker = String(body.ticker ?? '').trim().toUpperCase()
  if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return json({ success: false, error: 'invalid ticker' }, 400)
  }
  const accountSize = Number(body.account_size)
  if (!Number.isFinite(accountSize) || accountSize <= 0) {
    return json({ success: false, error: 'account_size must be a positive number' }, 400)
  }

  // 5-min cache by (ticker, account-size-bucket). Same matrix + same
  // sizing assumption = same suggestions.
  const cacheKey = `${ticker}|${Math.floor(accountSize / 1000)}`
  const { data: cached } = await adminClient
    .from('play_suggestions')
    .select('payload, computed_at')
    .eq('cache_key', cacheKey)
    .maybeSingle()
  if (cached?.payload && cached.computed_at) {
    const age = Date.now() - new Date(cached.computed_at).getTime()
    if (age >= 0 && age < CACHE_TTL_MS) {
      return json({ success: true, data: { ...cached.payload, from_cache: true, cache_age_ms: age } })
    }
  }

  // Full pipeline. Forward the user's JWT to compute-gex (the gateway
  // is finickier about service-role internal calls; user JWTs flow
  // through cleanly because that's what compute-gex's verify_jwt
  // expects).
  let result
  try {
    result = await generatePlaysForTicker(adminClient, ticker, accountSize, {
      functionName: 'suggest-plays',
      userId: user.id,
      topN: 3,
      computeGexAuthHeader: authHeader,
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      anthropicApiKey: ANTHROPIC_API_KEY,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'analysis failed'
    return json({ success: false, error: msg }, 502)
  }

  const { matrix, parsed, claudeCallId, confidence } = result

  // Cache the result. claude_call_id is part of the cached payload so
  // a cache-hit response can still FK the signal back to the call.
  const payload = {
    ticker,
    spot: matrix.spot,
    source: matrix.source,
    account_size: accountSize,
    claude_call_id: claudeCallId,
    ...parsed,
    computed_at: new Date().toISOString(),
  }
  adminClient.from('play_suggestions').upsert(
    {
      cache_key: cacheKey,
      payload,
      computed_at: new Date().toISOString(),
      pricing_source: 'verified',
      pricing_verified_at: new Date().toISOString(),
    },
    { onConflict: 'cache_key' },
  ).then(() => {})

  return json({
    success: true,
    data: {
      ...payload,
      from_cache: false,
      cache_age_ms: 0,
      confidence: confidence ?? aggregateConfidence(parsed?.plays),
    },
  })
})
