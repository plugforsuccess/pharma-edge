// Wiley Edge — suggest-plays edge function.
//
// Given a ticker, fetch the live GEX matrix from compute-gex and ask
// Claude to propose 3 spread trade ideas that fit the Wiley Edge
// trading rules + GEX playbook from /glossary. Returns structured JSON
// the /markets "Suggested Plays" card renders into clickable setups.
//
// Architecture mirrors analyze-signal:
//   - Auth: requires a real user JWT (verify_jwt=true)
//   - Rate-limited per user via the claude_calls ledger (same 30/hr cap)
//   - Claude Sonnet 4.6, max_tokens 2000, returns JSON only
//   - 5-min response cache via play_suggestions table (per ticker)
//
// Hard rules baked into the prompt — NOT optional:
//   - Spreads only, no naked options (Wiley Edge rule)
//   - Min 21 DTE (Wiley Edge entry rule, except 0DTE pin trades)
//   - Max 40% premium / spread width (sizing rule)
//   - Position size = floor(account * 2% / max_loss_per_spread)
//   - Refuse if no high-conviction setup exists (return empty)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 2000
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

const SYSTEM_PROMPT = `You are a Wiley Edge spread-trade advisor. Given a Gamma Exposure (GEX) matrix snapshot for a ticker, propose 0–3 high-conviction spread trade ideas that fit BOTH the GEX playbook and the Wiley Edge trading rules.

GEX PLAYBOOK (from /glossary):
- Regime A = above flip + Net GEX positive → range-bound, mean-revert. Setups: pin trades (long call spread toward call wall), short premium, breakout calls AT the call wall.
- Regime B = below flip + Net GEX negative → trending, volatile. Setups: long premium (straddles), breakdown puts AT the put wall, vol expansion.
- Call wall = strike with the largest positive GEX cell (★ in the matrix). Acts as resistance / magnet.
- Put wall = strike with the largest negative GEX cell. Acts as support / magnet.

WILEY EDGE RULES — NEVER VIOLATE:
- SPREADS ONLY. No naked options.
- Min 21 DTE on entry, except explicit 0–7 DTE pin trades.
- Max 40% of spread width in net debit (R/R cap).
- Position size = floor(account * 2% / max_loss_per_spread). Always include this in the response.
- 30–45 days past any catalyst for catalyst-driven plays.

OUTPUT — STRICT JSON, NO PROSE:
{
  "regime": "A" | "B" | "mixed",
  "regime_explanation": "one sentence",
  "plays": [
    {
      "strategy": "Bull Call Spread" | "Bear Put Spread" | "Iron Condor" | "Bull Put Spread (credit)" | "Bear Call Spread (credit)",
      "type": "BULL_CALL" | "BEAR_PUT" | "IRON_CONDOR" | "BULL_PUT_CREDIT" | "BEAR_CALL_CREDIT",
      "long_strike": <number>,
      "short_strike": <number>,
      "expiration": "YYYY-MM-DD",
      "dte": <integer>,
      "estimated_debit_pct_of_width": <integer 0-40>,
      "max_loss_per_spread": <number, dollars>,
      "max_profit_per_spread": <number, dollars>,
      "risk_reward": <number, e.g. 1.5>,
      "contracts": <integer, sized to account_size with the 2% rule>,
      "rationale": "1-2 sentences citing specific GEX numbers (call wall at $X, flip at $Y, etc.)",
      "what_invalidates": "1 sentence — what move or event kills this thesis"
    }
  ]
}

If no high-conviction setup exists (e.g., all cells near zero, or matrix data is stale/incomplete), return { "regime": "...", "regime_explanation": "...", "plays": [] } — DO NOT invent low-conviction trades to pad the response.

Both strikes you propose MUST exist in the matrix's strikes[] array. Use the matrix's expirations[] array for expiration dates — don't hallucinate dates.`

interface MatrixData {
  ticker: string
  spot: number
  source: string
  expirations: Array<{ date: string; dte: number }>
  strikes: number[]
  cells: (number | null)[][]
  largest: { strike: number; expiration: string; gex_net: number } | null
}

function buildUserPrompt(matrix: MatrixData, accountSize: number): string {
  // Compact matrix representation — Claude doesn't need every cell, just
  // structure + the highlights. Cuts token count ~80%.
  const totalGex = matrix.cells.flat().reduce((s, v) => s + (v ?? 0), 0)
  const flat = matrix.cells.flatMap((row, i) =>
    row.map((v, j) => ({
      strike: matrix.strikes[i],
      expiration: matrix.expirations[j].date,
      gex: v,
    })),
  )
  const top5pos = flat
    .filter((c) => c.gex != null && c.gex > 0)
    .sort((a, b) => (b.gex as number) - (a.gex as number))
    .slice(0, 5)
  const top5neg = flat
    .filter((c) => c.gex != null && c.gex < 0)
    .sort((a, b) => (a.gex as number) - (b.gex as number))
    .slice(0, 5)

  return `TICKER: ${matrix.ticker}
SPOT: $${matrix.spot.toFixed(2)}
DATA SOURCE: ${matrix.source}
ACCOUNT SIZE: $${accountSize.toLocaleString()}
MAX RISK PER TRADE (2% rule): $${Math.floor(accountSize * 0.02).toLocaleString()}

EXPIRATIONS AVAILABLE:
${matrix.expirations.map((e) => `  ${e.date} (${e.dte} DTE)`).join('\n')}

STRIKES IN WINDOW (descending):
${matrix.strikes.map((s) => `  ${s}`).join('\n')}

NET GEX (sum of all cells): $${(totalGex / 1e6).toFixed(1)}M

LARGEST CALL WALLS (top 5 positive cells):
${top5pos.map((c) => `  ${c.strike} @ ${c.expiration}: $${((c.gex as number) / 1e6).toFixed(1)}M`).join('\n')}

LARGEST PUT WALLS (top 5 negative cells):
${top5neg.length > 0
  ? top5neg.map((c) => `  ${c.strike} @ ${c.expiration}: -$${(Math.abs(c.gex as number) / 1e6).toFixed(1)}M`).join('\n')
  : '  (none in visible window — flip strike likely below)'}

LARGEST ABSOLUTE WALL (★): ${matrix.largest ? `${matrix.largest.strike} @ ${matrix.largest.expiration} = $${(matrix.largest.gex_net / 1e6).toFixed(1)}M` : 'none'}

Propose 0-3 spread trades following the rules in the system prompt. Strict JSON only.`
}

function extractJson(rawText: string): unknown {
  const stripped = rawText.replace(/```json|```/g, '').trim()
  const first = stripped.indexOf('{')
  const last = stripped.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('claude did not return parseable JSON')
  }
  return JSON.parse(stripped.slice(first, last + 1))
}

// Validate the plays match the matrix's strikes + expirations exactly so
// we don't deep-link the user into the calculator with a strike that
// doesn't trade.
function validatePlays(parsed: any, matrix: MatrixData): any {
  if (!parsed?.plays || !Array.isArray(parsed.plays)) return parsed
  const strikeSet = new Set(matrix.strikes)
  const expDates = new Set(matrix.expirations.map((e) => e.date))
  parsed.plays = parsed.plays.filter((p: any) => {
    if (!strikeSet.has(p.long_strike) || !strikeSet.has(p.short_strike)) {
      console.warn(`[validate] dropped play: strike not in matrix`, p)
      return false
    }
    if (!expDates.has(p.expiration)) {
      console.warn(`[validate] dropped play: expiration not in matrix`, p)
      return false
    }
    return true
  })
  return parsed
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

  // Rate limit check (shared with analyze-signal via claude_calls ledger).
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: recentCalls } = await adminClient
    .from('claude_calls')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('called_at', sinceIso)
  if ((recentCalls ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return json(
      { success: false, error: `rate limited: ${RATE_LIMIT_PER_HOUR} Claude calls per hour reached` },
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

  // Cache check — same matrix + same account size = same suggestions for 5 min
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

  // Pull the live matrix via the existing compute-gex endpoint. Reuses
  // its dxlink/yahoo fallback chain — single source of truth for the
  // numbers Claude reasons about.
  const gexResp = await fetch(`${SUPABASE_URL}/functions/v1/compute-gex`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticker, matrix: true }),
  })
  if (!gexResp.ok) {
    const detail = await gexResp.text().catch(() => '')
    return json({ success: false, error: `compute-gex returned ${gexResp.status}: ${detail.slice(0, 200)}` }, 502)
  }
  const gexBody = await gexResp.json()
  if (!gexBody?.success || !gexBody?.data) {
    return json({ success: false, error: gexBody?.error ?? 'compute-gex returned no data' }, 502)
  }
  const matrix = gexBody.data as MatrixData

  // Claude call.
  const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(matrix, accountSize) }],
    }),
  })
  if (!claudeResp.ok) {
    const detail = await claudeResp.text().catch(() => '')
    return json({ success: false, error: `claude returned ${claudeResp.status}: ${detail.slice(0, 200)}` }, 502)
  }
  const claudeBody = await claudeResp.json()
  const text = claudeBody?.content?.[0]?.text
  if (!text) return json({ success: false, error: 'claude response had no text content' }, 502)
  if (claudeBody.stop_reason === 'max_tokens') {
    return json({ success: false, error: 'claude response truncated; try a different ticker' }, 502)
  }

  let parsed
  try { parsed = extractJson(text) } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : 'parse error', raw: text.slice(0, 300) }, 502)
  }
  parsed = validatePlays(parsed, matrix)

  // Account for the call against the rate-limit ledger
  await adminClient.from('claude_calls').insert({
    user_id: user.id,
    function_name: 'suggest-plays',
    called_at: new Date().toISOString(),
  }).then(() => {})

  // Cache the result
  const payload = {
    ticker,
    spot: matrix.spot,
    source: matrix.source,
    account_size: accountSize,
    ...parsed,
    computed_at: new Date().toISOString(),
  }
  adminClient.from('play_suggestions').upsert(
    { cache_key: cacheKey, payload, computed_at: new Date().toISOString() },
    { onConflict: 'cache_key' },
  ).then(() => {})

  return json({ success: true, data: { ...payload, from_cache: false, cache_age_ms: 0 } })
})
