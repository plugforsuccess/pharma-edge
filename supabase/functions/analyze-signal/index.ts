// Pharma Edge — analyze-signal edge function (streaming).
//
// Streams Anthropic's response as Server-Sent Events to the client.
// Solves the wall-clock issue by sending bytes continuously to the
// gateway (no idle-timeout cut-off) and gives the client a chance
// to render progressive output.
//
// Event types emitted to the client:
//   start    — { ticker } analysis kicked off
//   keepalive — periodic heartbeat (every 4s) to hold the connection
//   text     — { delta } incremental Claude text token
//   search   — { query } a web_search tool invocation just fired
//   complete — { analysis, market_metrics, citations, web_searches_used } final structured JSON
//   error    — { error } fatal failure; client should surface

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchMarketMetrics, type MarketMetrics } from './tastytrade.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MAX_FILING_CHARS = 50_000
const MAX_TOKENS = 8192
const RATE_LIMIT_PER_HOUR = Number(Deno.env.get('CLAUDE_RATE_LIMIT_PER_HOUR') ?? '30')
const WEB_SEARCH_MAX_USES = Number(Deno.env.get('WEB_SEARCH_MAX_USES') ?? '4')
const KEEPALIVE_MS = 4_000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const SYSTEM_PROMPT = `You are a pharmaceutical industry analyst specializing in FDA regulatory strategy and clinical trial analysis. You are rigorous, skeptical, and data-driven. You do not invest — you analyze.

WEB SEARCH: You have a web_search tool. Use it (up to ${WEB_SEARCH_MAX_USES} searches max) to pull supplementary context the filing text alone doesn't cover. Be selective — only search when the gap is critical (recent press release on this exact drug, FDA precedent for this exact mechanism). Don't search for general industry context you already know.

ALLOWED SOURCES: SEC filings (sec.gov), FDA documents (fda.gov), ClinicalTrials.gov, peer-reviewed journals (NEJM, Lancet, JAMA, Nature, Science, biorxiv), company IR pages, reputable trade press (Endpoints News, FierceBiotech, BioSpace, STAT News).

DO NOT cite or rely on: Twitter/X, Reddit, Stocktwits, message boards, YouTube, blog comments. If a search returns mostly low-quality sources, treat the topic as unverified and lower confidence_score.

CRITICAL RULES:
1. Never provide investment advice
2. Always cite specific data points from text or web sources
3. Be explicit about what you don't know
4. Flag when data is insufficient
5. Return ONLY valid JSON — no preamble, no markdown`

function buildUserPrompt(input: {
  ticker: string
  company_name: string
  drug_name?: string
  indication?: string
  catalyst_type: string
  catalyst_date: string
  catalyst_date_precision: 'day' | 'month' | 'year' | 'unknown'
  filing_text: string
  market_metrics: MarketMetrics | null
}): string {
  const m = input.market_metrics
  const datePrecisionNote =
    input.catalyst_date_precision === 'month'
      ? ' (NOTE: source date precision is month-only; refer to the catalyst as the month/year, e.g. "August 2026", not the exact day — the day defaults to the 1st as an earliest-possible placeholder.)'
      : input.catalyst_date_precision === 'year'
        ? ' (NOTE: source date precision is year-only; refer to the catalyst as the year only.)'
        : ''
  let marketBlock = ''
  if (m) {
    const pct = (v: number | null) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`)
    const score = (v: number | null) => (v == null ? 'n/a' : (v * 100).toFixed(0))
    marketBlock = `

CURRENT MARKET CONDITIONS (live from Tastytrade):
- 30-day IV: ${pct(m.iv)}
- 30-day HV: ${pct(m.hv30)}
- IV-HV spread: ${pct(m.ivHvDifference)}
- IV rank: ${score(m.ivRank)}/100
- IV percentile: ${score(m.ivPercentile)}/100
- Beta: ${m.beta ?? 'n/a'}

Calibrate strike_suggestion: IV>150% or rank>80 → wider (12/35); IV<50% or rank<30 → tighter (5/20); high IV-HV spread (>30%) → market over-pricing; negative IV-HV → market under-pricing.`
  }
  return `Analyze the following public filing for ${input.company_name} (${input.ticker}).

Drug: ${input.drug_name || 'Not specified'}
Indication: ${input.indication || 'Not specified'}
Catalyst Type: ${input.catalyst_type}
Catalyst Date: ${input.catalyst_date}${datePrecisionNote}${marketBlock}

FILING TEXT:
${input.filing_text}

Return a JSON object with EXACTLY this structure:
{
  "thesis": "2-4 sentence summary citing specific data points",
  "claude_analysis": "Detailed 4-6 sentence analysis: trial design quality, endpoint appropriateness, FDA precedent, data quality concerns, red flags",
  "direction_recommendation": "long_put"|"long_call"|"watch",
  "confidence_score": <integer 1-10>,
  "market_implied_probability": <integer 0-100 or null>,
  "your_probability": <integer 0-100>,
  "signal_scores": { "enrollment_signal": <0-10>, "fda_precedent_signal": <0-10>, "protocol_amendment_signal": <0-10>, "insider_selling_signal": <0-10>, "cash_runway_signal": <0-10> },
  "key_risks": ["risk1","risk2","risk3"],
  "bull_case": "What would need to be true for a positive outcome",
  "bear_case": "Why this could fail",
  "data_quality": "high"|"medium"|"low",
  "data_quality_reason": "Why",
  "suggested_structure": "bear_put_spread"|"bull_call_spread"|"watch",
  "suggested_dte_days": <integer>,
  "flags": ["red flags found"],
  "strike_suggestion": { "buy_strike_pct_otm": <integer>, "sell_strike_pct_otm": <integer>, "expected_move_pct": <integer>, "max_premium_pct_of_spread": <integer 0-40>, "rationale": "Why" }
}`
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ success: false, error: 'method not allowed' }, 405)

  if (!ANTHROPIC_API_KEY) return jsonResponse({ success: false, error: 'ANTHROPIC_API_KEY not configured' }, 500)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY)
    return jsonResponse({ success: false, error: 'edge function misconfigured' }, 500)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return jsonResponse({ success: false, error: 'unauthorized' }, 401)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return jsonResponse({ success: false, error: 'unauthorized' }, 401)

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: recentCalls, error: rateError } = await adminClient
    .from('claude_calls')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('called_at', sinceIso)
  if (rateError) return jsonResponse({ success: false, error: `rate-limit lookup failed: ${rateError.message}` }, 500)
  if ((recentCalls ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return jsonResponse({ success: false, error: `rate limited: ${RATE_LIMIT_PER_HOUR} analyses per hour cap reached` }, 429)
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ success: false, error: 'invalid JSON body' }, 400)
  }

  const ticker = String(body.ticker ?? '').trim()
  const company_name = String(body.company_name ?? '').trim()
  const drug_name = body.drug_name ? String(body.drug_name) : undefined
  const indication = body.indication ? String(body.indication) : undefined
  const catalyst_type = String(body.catalyst_type ?? '').trim()
  const catalyst_date = String(body.catalyst_date ?? '').trim()
  const rawPrecision = String(body.catalyst_date_precision ?? 'day')
  const catalyst_date_precision = (
    ['day', 'month', 'year', 'unknown'].includes(rawPrecision) ? rawPrecision : 'day'
  ) as 'day' | 'month' | 'year' | 'unknown'
  const filing_text = String(body.filing_text ?? '')

  if (!ticker || !company_name || !catalyst_type || !catalyst_date) {
    return jsonResponse({ success: false, error: 'missing required fields' }, 400)
  }
  if (filing_text.length < 200) {
    return jsonResponse({ success: false, error: 'filing_text must be at least 200 characters' }, 400)
  }
  if (filing_text.length > MAX_FILING_CHARS) {
    return jsonResponse({ success: false, error: `filing_text exceeds ${MAX_FILING_CHARS} character cap` }, 400)
  }

  const marketMetrics = await fetchMarketMetrics(adminClient, ticker)
  const userPrompt = buildUserPrompt({
    ticker,
    company_name,
    drug_name,
    indication,
    catalyst_type,
    catalyst_date,
    catalyst_date_precision,
    filing_text,
    market_metrics: marketMetrics,
  })

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(sseEvent(event, data)))
        } catch {
          /* controller closed */
        }
      }

      // Periodic keepalive so the gateway sees regular bytes and
      // doesn't terminate an apparently-idle connection while Claude
      // is still thinking.
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive\n\n`))
        } catch {
          clearInterval(keepalive)
        }
      }, KEEPALIVE_MS)

      try {
        send('start', { ticker, company_name })

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
            stream: true,
            system: SYSTEM_PROMPT,
            tools: [
              { type: 'web_search_20250305', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES },
            ],
            messages: [{ role: 'user', content: userPrompt }],
          }),
        })

        if (!claudeResp.ok || !claudeResp.body) {
          const detail = await claudeResp.text().catch(() => '')
          send('error', {
            error: `claude returned ${claudeResp.status}`,
            detail: detail.slice(0, 500),
          })
          return
        }

        // Parse Anthropic's SSE stream incrementally. Accumulate text
        // from `text_delta` events; track citations / search count
        // from server_tool_use blocks. Forward digestible events to
        // the client as we go.
        const reader = claudeResp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let textAccum = ''
        const citations: unknown[] = []
        let searchCount = 0
        let stopReason: string | null = null

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6).trim()
            if (!payload || payload === '[DONE]') continue
            let evt: Record<string, unknown>
            try {
              evt = JSON.parse(payload)
            } catch {
              continue
            }
            const t = evt.type as string

            if (t === 'content_block_start') {
              const cb = evt.content_block as Record<string, unknown> | undefined
              if (cb?.type === 'server_tool_use') {
                searchCount++
                const input = cb.input as Record<string, unknown> | undefined
                send('search', { query: input?.query ?? '(unknown query)' })
              } else if (cb?.type === 'web_search_tool_result') {
                // Extract URLs from the actual search results so we
                // capture sources Claude *saw* even when it didn't
                // inline-cite them. content is an array of
                // { type: 'web_search_result', url, title, page_age }.
                const results = (cb.content as Array<Record<string, unknown>> | undefined) || []
                for (const r of results) {
                  if (r?.type === 'web_search_result' && r.url) {
                    citations.push({
                      url: String(r.url),
                      title: r.title ? String(r.title) : String(r.url),
                      page_age: r.page_age ?? null,
                    })
                  }
                }
              }
            } else if (t === 'content_block_delta') {
              const delta = evt.delta as Record<string, unknown> | undefined
              if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                textAccum += delta.text
                send('text', { delta: delta.text })
              }
              if (delta?.type === 'citations_delta') {
                const c = (delta as { citation?: unknown }).citation
                if (c) citations.push(c)
              }
            } else if (t === 'message_delta') {
              const d = evt.delta as Record<string, unknown> | undefined
              if (d?.stop_reason) stopReason = d.stop_reason as string
            } else if (t === 'message_stop') {
              // wrap up below
            } else if (t === 'error') {
              const err = evt.error as Record<string, unknown> | undefined
              send('error', { error: (err?.message as string) || 'claude stream error' })
              return
            }
          }
        }

        if (stopReason && stopReason !== 'end_turn' && stopReason !== 'tool_use') {
          send('error', { error: `analysis truncated (stop_reason=${stopReason})` })
          return
        }

        // Parse the accumulated text as JSON.
        let analysis: unknown
        try {
          analysis = extractJson(textAccum)
        } catch (e) {
          send('error', {
            error: 'JSON parse failed: ' + (e as Error).message,
            raw: textAccum.slice(0, 500),
          })
          return
        }

        // Log the successful Claude call AFTER the stream completes
        // so failed/aborted calls don't count against quota.
        await adminClient.from('claude_calls').insert({ user_id: user.id })

        send('complete', {
          analysis,
          market_metrics: marketMetrics,
          citations,
          web_searches_used: searchCount,
        })
      } catch (e) {
        send('error', { error: (e as Error).message || 'stream failed' })
      } finally {
        clearInterval(keepalive)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
  })

  // text/plain instead of text/event-stream — iOS Safari has known
  // fetch+streaming bugs with text/event-stream content-type
  // (response.body sometimes never arrives, or the connection drops
  // mid-stream). We're parsing the SSE format manually on the client,
  // so the browser doesn't need to interpret the content-type.
  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})
