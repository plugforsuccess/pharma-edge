// Pharma Edge — analyze-signal edge function.
//
// Pure analysis endpoint. Reads filing text + signal context, calls Claude,
// returns structured analysis JSON. The CLIENT decides what to do with the
// result (prefill a draft signal). This function never writes to the
// signals table — that avoids the IDOR vector from the spec where any
// authenticated user could pass a foreign signal_id and have it
// overwritten via the service role.
//
// TODO(rate-limit): no per-user cap yet. Auth requirement closes the
// anon-spam vector but a logged-in attacker could still burn Claude
// budget. Add a `claude_calls` table with (user_id, called_at) when
// multi-user.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MAX_FILING_CHARS = 50_000
const CLAUDE_TIMEOUT_MS = 50_000
const MAX_TOKENS = 4096

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
}): string {
  return `Analyze the following public filing for ${input.company_name} (${input.ticker}).

Drug: ${input.drug_name || 'Not specified'}
Indication: ${input.indication || 'Not specified'}
Catalyst Type: ${input.catalyst_type}
Catalyst Date: ${input.catalyst_date}

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
  "suggested_structure": "bear_put_spread" | "bull_call_spread" | "naked_put" | "naked_call" | "watch",
  "suggested_dte_days": <integer, recommended days to expiration past catalyst>,
  "flags": ["any specific red flags found in the text"]
}`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ success: false, error: 'method not allowed' }, 405)
  }

  if (!ANTHROPIC_API_KEY) {
    return json(
      { success: false, error: 'ANTHROPIC_API_KEY is not configured. Run: supabase secrets set ANTHROPIC_API_KEY=...' },
      500,
    )
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json({ success: false, error: 'edge function misconfigured: missing SUPABASE env' }, 500)
  }

  // Auth: require a real user JWT. We pass the caller's Authorization through
  // to a Supabase client so auth.getUser() validates the token server-side
  // and returns a trustworthy user_id (never trust client-provided ids).
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

  const userPrompt = buildUserPrompt({
    ticker,
    company_name,
    drug_name,
    indication,
    catalyst_type,
    catalyst_date,
    filing_text,
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

  // Robust JSON extraction: strip any markdown fences, then take the
  // outermost {...} block in case Claude wrapped it in prose.
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

  // Defensive: ensure signal_scores is at least an object so the client
  // can `.signal_scores.enrollment_signal ?? 0` without crashing.
  if (!analysis.signal_scores || typeof analysis.signal_scores !== 'object') {
    analysis.signal_scores = {}
  }

  return json({ success: true, analysis })
})
