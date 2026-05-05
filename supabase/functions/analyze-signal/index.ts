// Pharma Edge — analyze-signal edge function.
//
// Pure analysis endpoint. Reads filing text + signal context, calls Claude,
// returns structured analysis JSON. The CLIENT decides what to do with the
// result (prefill a draft signal). This function never writes to the
// signals table — that avoids the IDOR vector from the spec where any
// authenticated user could pass a foreign signal_id and have it
// overwritten via the service role.
//
// Per-user rate limit: claude_calls table. Each successful Claude call
// inserts a row keyed by user_id; new requests are rejected with 429
// once the rolling-1h count crosses RATE_LIMIT_PER_HOUR.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchMarketMetrics, type MarketMetrics } from './tastytrade.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MAX_FILING_CHARS = 50_000
const CLAUDE_TIMEOUT_MS = 50_000
const MAX_TOKENS = 4096
const RATE_LIMIT_PER_HOUR = Number(Deno.env.get('CLAUDE_RATE_LIMIT_PER_HOUR') ?? '30')

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

const SYSTEM_PROMPT = `You are a pharmaceutical industry analyst specializing in FDA regulatory strategy and clinical trial analysis. Your job is to analyze public biotech/pharma filings and determine whether a drug catalyst (FDA decision, trial readout, etc.) is likely to be positive or negative based purely on the scientific and regulatory evidence.

You are rigorous, skeptical, and data-driven. You do not invest — you analyze. You have deep knowledge of:
- FDA approval history and precedent by indication
- Clinical trial design and endpoint selection
- Statistical significance standards in drug development
- Common red flags in trial data (endpoint switching, cherry-picked populations, marginal p-values)
- Cash runway analysis for small-cap biotech

CRITICAL RULES:
1. Never provide investment advice
2. Always cite specific data points from the provided text
3. Be explicit about what you do NOT know or cannot determine
4. Flag when data is insufficient for high-confidence analysis
5. Return ONLY valid JSON — no preamble, no markdown, no explanation outside the JSON`

function buildUserPrompt(input: {
  ticker: string
  company_name: string
  drug_name?: string
  indication?: string
  catalyst_type: string
  catalyst_date: string
  filing_text: string
  market_metrics: MarketMetrics | null
}): string {
  const m = input.market_metrics
  // Format IV / HV / IV-rank as percentages so Claude reads them as
  // it would in a research note. Skip the section entirely if the
  // metrics fetch failed so Claude falls back to its category priors.
  let marketBlock = ''
  if (m) {
    const pct = (v: number | null) =>
      v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`
    const score = (v: number | null) =>
      v == null ? 'n/a' : (v * 100).toFixed(0)
    marketBlock = `

CURRENT MARKET CONDITIONS (live from Tastytrade):
- 30-day implied volatility: ${pct(m.iv)}
- 30-day historical volatility: ${pct(m.hv30)}
- IV − HV spread: ${pct(m.ivHvDifference)} (positive = options are pricing in elevated risk vs realized)
- IV rank: ${score(m.ivRank)} / 100 (where this name's IV sits in its 52-week range)
- IV percentile: ${score(m.ivPercentile)} / 100
- Beta: ${m.beta ?? 'n/a'}

Calibrate strike_suggestion to these conditions:
- IV > 150% or IV rank > 80 → use WIDER spreads (e.g. 12% buy / 35% sell) so the net debit stays under the 40% premium-of-width cap
- IV < 50% or IV rank < 30 → tighter spreads acceptable (e.g. 5% buy / 20% sell); options are relatively cheap so capturing modest moves still pays
- High IV − HV spread ( > 30% ) → market is over-pricing this catalyst; favour put-side spreads if your fundamental read is bearish
- Negative IV − HV spread → market is under-pricing; check if your filing read justifies a contrarian setup`
  }

  return `Analyze the following public filing for ${input.company_name} (${input.ticker}).

Drug: ${input.drug_name || 'Not specified'}
Indication: ${input.indication || 'Not specified'}
Catalyst Type: ${input.catalyst_type}
Catalyst Date: ${input.catalyst_date}${marketBlock}

FILING TEXT:
${input.filing_text}

Return a JSON object with EXACTLY this structure:
{
  "thesis": "2-4 sentence summary of your core thesis on whether this catalyst is likely positive or negative, citing specific data points",
  "claude_analysis": "Detailed 4-6 sentence analysis covering: trial design quality, endpoint appropriateness, FDA precedent, data quality concerns, and any red flags found",
  "direction_recommendation": "long_put" | "long_call" | "watch",
  "confidence_score": <integer 1-10>,
  "market_implied_probability": <estimated market probability of positive outcome as integer 0-100, or null if unknown>,
  "your_probability": <your estimated probability of positive outcome as integer 0-100>,
  "signal_scores": {
    "enrollment_signal": <0-10, 0 if no enrollment data present>,
    "fda_precedent_signal": <0-10, 0 if no precedent data present>,
    "protocol_amendment_signal": <0-10, 0 if no amendments found>,
    "insider_selling_signal": <0-10, 0 if no insider data present>,
    "cash_runway_signal": <0-10, 0 if no cash data present>
  },
  "key_risks": ["risk1", "risk2", "risk3"],
  "bull_case": "What would need to be true for a positive outcome",
  "bear_case": "What the data suggests about why this could fail",
  "data_quality": "high" | "medium" | "low",
  "data_quality_reason": "Why you rated data quality as you did",
  "suggested_structure": "bear_put_spread" | "bull_call_spread" | "watch",
  "suggested_dte_days": <integer, recommended days to expiration past catalyst>,
  "flags": ["any specific red flags found in the text"],
  "strike_suggestion": {
    "buy_strike_pct_otm": <integer % out of the money for the BUY strike — for puts the buy strike is below stock price, for calls it is above>,
    "sell_strike_pct_otm": <integer % out of the money for the SELL strike — should be further OTM than the buy strike>,
    "expected_move_pct": <integer expected stock % move on catalyst, absolute value>,
    "max_premium_pct_of_spread": <integer 0-40 — never recommend paying more than 40% of spread width in premium>,
    "rationale": "Why these strikes make sense given the expected move on this catalyst"
  }
}`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!ANTHROPIC_API_KEY) {
    return json(
      { success: false, error: 'ANTHROPIC_API_KEY is not configured. Run: supabase secrets set ANTHROPIC_API_KEY=...' },
      500,
    )
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured: missing SUPABASE env' }, 500)
  }

  // Auth: require a real user JWT.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Per-user rate limit (rolling 1h).
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: recentCalls, error: rateError } = await adminClient
    .from('claude_calls')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('called_at', sinceIso)
  if (rateError) {
    return json({ success: false, error: `rate-limit lookup failed: ${rateError.message}` }, 500)
  }
  if ((recentCalls ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return json(
      {
        success: false,
        error: `rate limited: ${RATE_LIMIT_PER_HOUR} analyses per hour cap reached. Try again later.`,
      },
      429,
    )
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const ticker = String(body.ticker ?? '').trim()
  const company_name = String(body.company_name ?? '').trim()
  const drug_name = body.drug_name ? String(body.drug_name) : undefined
  const indication = body.indication ? String(body.indication) : undefined
  const catalyst_type = String(body.catalyst_type ?? '').trim()
  const catalyst_date = String(body.catalyst_date ?? '').trim()
  const filing_text = String(body.filing_text ?? '')

  if (!ticker || !company_name || !catalyst_type || !catalyst_date) {
    return json({ success: false, error: 'missing required fields (ticker, company_name, catalyst_type, catalyst_date)' }, 400)
  }
  if (filing_text.length < 200) {
    return json({ success: false, error: 'filing_text must be at least 200 characters' }, 400)
  }
  if (filing_text.length > MAX_FILING_CHARS) {
    return json({ success: false, error: `filing_text exceeds ${MAX_FILING_CHARS} character cap` }, 400)
  }

  // Fetch live market metrics from Tastytrade so Claude can calibrate
  // strike_suggestion to actual IV instead of training-data priors.
  // Failures fall through with null — the prompt simply omits the
  // market block and Claude reverts to category-based heuristics.
  const marketMetrics = await fetchMarketMetrics(adminClient, ticker)

  const userPrompt = buildUserPrompt({
    ticker,
    company_name,
    drug_name,
    indication,
    catalyst_type,
    catalyst_date,
    filing_text,
    market_metrics: marketMetrics,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS)

  let claudeResp: Response
  try {
    claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const aborted = e instanceof Error && e.name === 'AbortError'
    return json({ success: false, error: aborted ? 'analysis timed out' : 'claude call failed' }, 502)
  }
  clearTimeout(timer)

  if (!claudeResp.ok) {
    const text = await claudeResp.text().catch(() => '')
    return json(
      { success: false, error: `claude returned ${claudeResp.status}`, detail: text.slice(0, 500) },
      502,
    )
  }

  const claudeData = await claudeResp.json()
  if (claudeData?.stop_reason && claudeData.stop_reason !== 'end_turn') {
    return json(
      { success: false, error: `analysis truncated (stop_reason=${claudeData.stop_reason}). Try a shorter filing.` },
      502,
    )
  }

  const textBlock = (claudeData?.content || []).find((b: { type?: string }) => b?.type === 'text') as
    | { text?: string }
    | undefined
  const rawText = textBlock?.text || ''
  if (!rawText) {
    return json({ success: false, error: 'no text content in claude response' }, 502)
  }

  const stripped = rawText.replace(/```json|```/g, '').trim()
  const first = stripped.indexOf('{')
  const last = stripped.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    return json({ success: false, error: 'claude did not return parseable JSON', raw: rawText.slice(0, 500) }, 502)
  }
  const jsonText = stripped.slice(first, last + 1)

  let analysis: Record<string, unknown>
  try {
    analysis = JSON.parse(jsonText)
  } catch (e) {
    return json(
      { success: false, error: 'JSON parse failed: ' + (e as Error).message, raw: jsonText.slice(0, 500) },
      502,
    )
  }

  if (!analysis.signal_scores || typeof analysis.signal_scores !== 'object') {
    analysis.signal_scores = {}
  }
  // strike_suggestion is optional in the response — UI degrades gracefully
  // to its hardcoded defaults when absent.

  // Log the successful call AFTER Claude returns so failed calls don't
  // count against the user's quota.
  await adminClient.from('claude_calls').insert({ user_id: user.id })

  // Echo the live market metrics back to the client so the UI can show
  // 'Live IV: 165%' beneath the suggested strikes for transparency.
  return json({ success: true, analysis, market_metrics: marketMetrics })
})
