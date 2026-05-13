// Cash Moves — explain-matrix edge function.
//
// Generates a 1-3 sentence "what this means" narrative from a GEX
// matrix summary. Two modes:
//
//   * mode='regime_summary' (2-3 sentences) — used on /markets Summary
//     view to describe the overall positioning landscape
//   * mode='play_context' (1-2 sentences) — used on the play detail
//     page to explain WHY a specific play makes sense given dealer
//     positioning
//
// Caching: keyed by (ticker, mode, qualitative-state fingerprint).
// Two matrices that fingerprint to the same bucket share a narrative.
// TTL 15 min — beyond that, even same-bucket positioning might have
// drifted enough that the narrative reads stale. The 5-min compute-gex
// snapshot cache + our fingerprint bucketing keep cache hit rate high.
//
// Auth: user JWT required. The narrative is served into a logged-in
// user's view; anon callers go through profile-public-data instead.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!

// Stable across the codebase per CLAUDE.md. Bump deliberately.
const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 250
const CACHE_TTL_MS = 15 * 60 * 1000
const ANTHROPIC_TIMEOUT_MS = 10_000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

interface MatrixSummary {
  ticker: string
  spot: number
  net_gex: number
  king_wall_strike: number | null
  king_wall_gex: number | null
  flip_strike: number | null
  pinning_probability: number
  expected_move?: number
  expected_move_today: number
  realized_pct_of_today: number | null
  net_dex: number
  source: string
  computed_at: string
}

interface PlayContext {
  strategy: string
  long_strike: number
  short_strike: number
  dte: number
  thesis_kind?: string
}

type ExplainMode = 'regime_summary' | 'play_context'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ success: false, error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({})) as {
    summary?: MatrixSummary
    mode?: ExplainMode
    play?: PlayContext
  }
  if (!body.summary || !body.summary.ticker) {
    return json({ success: false, error: 'summary required' }, 400)
  }
  const mode: ExplainMode = body.mode === 'play_context' ? 'play_context' : 'regime_summary'
  if (mode === 'play_context' && !body.play) {
    return json({ success: false, error: 'play required for play_context mode' }, 400)
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const fingerprint = computeFingerprint(body.summary, body.play, mode)
  const cacheKey = `${body.summary.ticker}|${mode}|${fingerprint}`

  // Cache lookup.
  const { data: cached } = await admin
    .from('matrix_narrative_cache')
    .select('narrative, created_at')
    .eq('cache_key', cacheKey)
    .maybeSingle()

  if (cached?.narrative && cached.created_at) {
    const age = Date.now() - new Date(cached.created_at).getTime()
    if (age < CACHE_TTL_MS) {
      return json({
        success: true,
        narrative: cached.narrative,
        from_cache: true,
        cache_age_ms: age,
      })
    }
  }

  // Miss → call Claude.
  const prompt = buildPrompt(body.summary, body.play, mode)
  const narrative = await callClaude(prompt)
  if (!narrative) {
    return json({ success: false, error: 'narrative generation failed' }, 502)
  }

  // Persist. Fire-and-forget — we don't block the response on the
  // cache write; worst case is a duplicate Claude call on the very
  // next request before this write commits.
  admin
    .from('matrix_narrative_cache')
    .upsert(
      {
        cache_key: cacheKey,
        ticker: body.summary.ticker,
        mode,
        fingerprint,
        narrative,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'cache_key' },
    )
    .then(() => {})

  return json({
    success: true,
    narrative,
    from_cache: false,
    cache_age_ms: 0,
  })
})

function computeFingerprint(s: MatrixSummary, p: PlayContext | undefined, mode: ExplainMode): string {
  const regime = (s.net_gex ?? 0) >= 0 ? 'A' : 'B'

  const wallStrike = s.king_wall_strike != null
    ? Math.round(s.king_wall_strike).toString()
    : 'none'
  const wallSide = s.king_wall_gex != null
    ? (s.king_wall_gex > 0 ? 'call' : 'put')
    : 'none'
  const flip = s.flip_strike != null ? Math.round(s.flip_strike).toString() : 'none'

  // Pinning probability bucket.
  const pp = s.pinning_probability ?? 0
  const pinBucket = pp >= 0.6 ? 'high' : pp >= 0.3 ? 'mid' : 'low'

  // Expected move realization bucket.
  const rt = s.realized_pct_of_today
  const emBucket = rt == null ? 'na'
    : rt >= 1.0 ? 'over'
    : rt >= 0.5 ? 'on'
    : 'under'

  let base = `${regime}|${wallStrike}|${wallSide}|${flip}|${pinBucket}|${emBucket}`

  if (mode === 'play_context' && p) {
    let wallRel = 'none'
    if (s.king_wall_strike != null && s.king_wall_strike > 0) {
      const dist = (p.long_strike - s.king_wall_strike) / s.king_wall_strike
      wallRel = dist > 0.005 ? 'above_wall'
        : dist < -0.005 ? 'below_wall'
        : 'at_wall'
    }
    base += `|${p.strategy}|${wallRel}|${p.dte}DTE`
  }
  return base
}

function buildPrompt(s: MatrixSummary, p: PlayContext | undefined, mode: ExplainMode): string {
  const regime = (s.net_gex ?? 0) >= 0
    ? 'A (positive gamma — pin-friendly, mean-reverting)'
    : 'B (negative gamma — dealers amplify moves)'
  const wallSide = s.king_wall_gex != null && s.king_wall_gex > 0
    ? 'call wall (resistance)'
    : 'put wall (support)'

  const summaryBlock = `TICKER: ${s.ticker}  SPOT: $${s.spot.toFixed(2)}
REGIME: ${regime}
NET GEX: ${((s.net_gex ?? 0) / 1e6).toFixed(0)}M
KING WALL: ${s.king_wall_strike != null ? '$' + s.king_wall_strike.toFixed(2) : 'none'} (${wallSide}, ${((s.king_wall_gex ?? 0) / 1e6).toFixed(0)}M)
FLIP STRIKE (zero gamma): ${s.flip_strike != null ? '$' + s.flip_strike.toFixed(2) : 'none in window'}
PINNING PROBABILITY: ${((s.pinning_probability ?? 0) * 100).toFixed(0)}%
EXPECTED MOVE TODAY: $${(s.expected_move_today ?? 0).toFixed(2)} (1-stddev)
REALIZED % OF EXPECTED: ${s.realized_pct_of_today != null ? (s.realized_pct_of_today * 100).toFixed(0) + '%' : 'N/A'}
NET DEALER DELTA: ${(s.net_dex ?? 0) >= 0 ? 'long' : 'short'} the underlying (${((s.net_dex ?? 0) / 1e6).toFixed(0)}M)`

  if (mode === 'regime_summary') {
    return `${summaryBlock}

You are explaining dealer positioning to a retail options trader who knows the basics of options but doesn't think about gamma exposure daily. In 2-3 short sentences, describe what this matrix tells the trader about how the underlying is likely to behave today.

Rules:
- Plain English. Avoid jargon like "vanna," "charm," "convexity."
- Be specific: name the actual strikes, regime, and what dealers will do.
- Don't recommend a trade. Just describe the positioning landscape.
- Maximum 3 sentences. Minimum 1 sentence if the matrix is clear-cut.

Examples of good output:
- "QQQ is in Regime B with $838M of negative gamma — dealers will amplify any move down toward the $700 put wall, which is the largest in the matrix. Above $702.50, dealers flip to selling rallies, capping upside. Expect choppier action with a downside bias."
- "SPY is pinned in Regime A near $510, with the call wall at $512 acting as resistance and the put wall at $508 as support. Dealers want this to settle — 67% pinning probability today. Range trade until something breaks the band."`
  }

  const playBlock = `PLAY: ${p!.strategy} | long $${p!.long_strike} / short $${p!.short_strike} | ${p!.dte}DTE`

  return `${summaryBlock}

${playBlock}

You are explaining to a retail options trader WHY this specific play makes sense given the dealer positioning above. In ONE sentence (max 2), connect the play's strikes to the king wall, the regime, or the flip strike.

Rules:
- Plain English. No jargon.
- Be specific: reference the actual wall and how the play's strikes relate to it.
- Don't restate the strikes — the trader already sees them.
- Don't predict outcomes. Just explain the logic.
- ONE sentence preferred. Two only if the play has two distinct edges.

Examples of good output:
- "Bear Call $232.5/$230 sits right at NVDA's $235 call wall in Regime B — dealers are short gamma there and will defend the wall by selling into rallies."
- "Bull Put $508/$505 takes the high-probability side of SPY's $508 put wall in pin-friendly Regime A — dealers want this strike to hold."`
}

async function callClaude(prompt: string): Promise<string | null> {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    })
    if (!resp.ok) {
      console.error('[explain-matrix] claude error:', resp.status, await resp.text().catch(() => ''))
      return null
    }
    const body = await resp.json() as { content?: Array<{ type: string; text?: string }> }
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('\n')
      .trim()
    return text || null
  } catch (err) {
    console.error('[explain-matrix] claude threw:', err)
    return null
  }
}
