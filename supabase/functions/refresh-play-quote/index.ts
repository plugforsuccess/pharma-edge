// Cash Moves — refresh-play-quote edge function.
//
// Live recompute of a play's risk metrics. Delegates the actual
// Polygon fetch + math to the shared optionPricing module so this
// endpoint, suggest-plays, and scan-universe-plays all use byte-
// identical numbers. This file owns only the HTTP shell: auth,
// request validation, the 30s response cache.
//
// Why this exists: the scanner caches plays at scan time. Spot drifts,
// IV moves, mids compress — but the "at scan" numbers stay frozen.
// A user opening a play detail an hour later was seeing R/R 1.9 when
// the live spread had compressed to R/R 0.21 — same trade, different
// numbers. This endpoint gives the UI the live comparison.
//
// Auth: user JWT required.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { priceSpread, priceIronCondor, classifySpread } from '../_shared/optionPricing.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CACHE_TTL_MS = 30 * 1000

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

interface PlayRequest {
  ticker: string
  structure: string
  long_strike?: number
  short_strike?: number
  // Iron Condor needs all four strikes; the structure carries one wing
  // each side of the body. Body = short_put → short_call. Wings =
  // long_put (below) and long_call (above).
  long_put_strike?: number
  short_put_strike?: number
  short_call_strike?: number
  long_call_strike?: number
  expiration: string  // YYYY-MM-DD
}

function isIronCondor(structure: string): boolean {
  const norm = structure.toUpperCase().replace(/-/g, '_').replace(/_SPREAD$/, '')
  return norm === 'IRON_CONDOR'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ success: false, error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => null) as PlayRequest | null
  if (!body || !body.ticker || !body.structure || !body.expiration) {
    return json({ success: false, error: 'invalid request body' }, 400)
  }
  const ic = isIronCondor(body.structure)
  if (ic) {
    const ks = [body.long_put_strike, body.short_put_strike, body.short_call_strike, body.long_call_strike]
    if (!ks.every((k) => typeof k === 'number' && Number.isFinite(k))) {
      return json({ success: false, error: 'iron condor requires long_put_strike, short_put_strike, short_call_strike, long_call_strike' }, 400)
    }
  } else {
    if (!Number.isFinite(body.long_strike) || !Number.isFinite(body.short_strike)) {
      return json({ success: false, error: 'invalid strikes' }, 400)
    }
    if (!classifySpread(body.structure)) {
      return json({ success: false, error: `unsupported structure: ${body.structure}` }, 400)
    }
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const cacheKey = ic
    ? [
        body.ticker.toUpperCase(),
        'IRON_CONDOR',
        body.long_put_strike,
        body.short_put_strike,
        body.short_call_strike,
        body.long_call_strike,
        body.expiration,
      ].join('|')
    : [
        body.ticker.toUpperCase(),
        body.structure,
        body.long_strike,
        body.short_strike,
        body.expiration,
      ].join('|')

  const { data: cached } = await admin
    .from('play_quote_cache')
    .select('payload, computed_at')
    .eq('cache_key', cacheKey)
    .maybeSingle()
  if (cached?.payload && cached.computed_at) {
    const age = Date.now() - new Date(cached.computed_at).getTime()
    if (age < CACHE_TTL_MS) {
      return json({
        success: true,
        data: { ...cached.payload, from_cache: true, cache_age_ms: age },
      })
    }
  }

  const priced = ic
    ? await priceIronCondor({
        ticker: body.ticker,
        long_put_strike: body.long_put_strike!,
        short_put_strike: body.short_put_strike!,
        short_call_strike: body.short_call_strike!,
        long_call_strike: body.long_call_strike!,
        expiration: body.expiration,
      })
    : await priceSpread({
        ticker: body.ticker,
        structure: body.structure,
        long_strike: body.long_strike!,
        short_strike: body.short_strike!,
        expiration: body.expiration,
      })

  if (priced.pricing_source === 'rejected') {
    return json({
      success: false,
      error: priced.rejection_reason ?? 'pricing rejected',
    }, 502)
  }

  const payload = { ...priced, refreshed_at: new Date().toISOString() }

  admin
    .from('play_quote_cache')
    .upsert(
      { cache_key: cacheKey, payload, computed_at: new Date().toISOString() },
      { onConflict: 'cache_key' },
    )
    .then(() => {})

  return json({ success: true, data: { ...payload, from_cache: false, cache_age_ms: 0 } })
})
