// Cash Moves — theme-notes edge function (owner, 2026-10-19: "build option 2").
//
// One short "what's driving it" note per industry theme among today's ranked
// leaders: the driver and up to three risks, each tied to a source Claude's
// web search actually returned from an allow-listed news domain. Anything
// without such a source is dropped; a theme with no sourced driver gets no
// note. Written to theme_notes, read by the Leaders list. Every call is
// logged to claude_calls (user_id null, function_name 'theme-notes').
//
// Service-role only (.github/workflows/theme-notes.yml after the nightly
// ranking). OFF until the THEME_NOTES_ENABLED secret is 'true' — the app
// works without it; the Leaders list simply shows no notes.
// POST { dry_run?: true, limit?: number } — dry_run returns the themes it
// would summarise and calls nothing.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const ENABLED = Deno.env.get('THEME_NOTES_ENABLED') === 'true'

// CLAUDE.md: Claude Sonnet 4.6 for the app's Claude calls.
const MODEL = 'claude-sonnet-4-6'
const PRICE = { input: 3 / 1e6, output: 15 / 1e6, cacheWrite: 3.75 / 1e6, cacheRead: 0.3 / 1e6, search: 10 / 1000 }
const MAX_THEMES = 15
const ALLOWED = [
  'reuters.com', 'apnews.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'cnbc.com', 'barrons.com',
  'marketwatch.com', 'nytimes.com', 'economist.com', 'axios.com', 'fortune.com',
  'sec.gov', 'eia.gov', 'federalreserve.gov', 'bls.gov', 'iea.org', 'opec.org', 'fda.gov', 'cms.gov',
]
const KINDS = new Set(['geopolitical', 'macro', 'company', 'regulatory', 'commodity', 'event'])

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

function claimsOf(token: string): Record<string, unknown> | null {
  try {
    const p = token.split('.')[1]
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
  } catch {
    return null
  }
}

const SYSTEM = `You write one short, factual note on what is driving a group of stocks right now, for an options app's list of strong stocks ("leaders").

Use web search (2–3 searches) for news from the last 30 days. Then answer with ONLY a JSON object, no prose around it:
{"driver": {"text": "...", "url": "...", "name": "...", "date": "YYYY-MM-DD"},
 "risks": [{"kind": "geopolitical|macro|company|regulatory|commodity|event", "text": "...", "url": "...", "name": "...", "date": "YYYY-MM-DD"}]}

Rules:
- driver.text: one sentence (max 30 words) on why this group has been rising.
- risks: up to 3, each one sentence (max 30 words): what could reverse the move. Most important first.
- Every url must be a page your search returned. name = the publication. date = the article date.
- Numbers only if the source states them. No predictions of your own, no price targets.
- Never say buy, sell, hold or recommend anything.
- If you can't find a sourced driver, answer {"driver": null, "risks": []}.`

type Source = { url: string; name: string; date: string | null }

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }
const allowedHost = (u: string) => { const h = hostOf(u); return ALLOWED.some((d) => h === d || h.endsWith(`.${d}`)) }
const clean = (s: unknown, max = 240) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const dateOrNull = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null)
const ADVICE = /\b(buy|sell|hold|recommend|should (?:buy|sell))\b/i

async function noteFor(admin: ReturnType<typeof createClient>, theme: { name: string; etf: string | null; tickers: string[] }) {
  const user = `Group: ${theme.name}${theme.etf ? ` (tracks the ${theme.etf} fund)` : ''}. Leaders in it today: ${theme.tickers.join(', ')}. Today is ${new Date().toISOString().slice(0, 10)}.`
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 2000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3, allowed_domains: ALLOWED }],
    messages: [{ role: 'user', content: user }],
  }
  const started = Date.now()
  const messages = body.messages as Array<Record<string, unknown>>
  const content: Array<Record<string, any>> = []
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, searches: 0 }
  let last: any = null
  let error: string | null = null
  // Server tools can pause a long turn (stop_reason pause_turn): resend with
  // the partial assistant turn, at most twice.
  for (let round = 0; round < 3; round++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) { error = `anthropic ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 400)}`; break }
    last = await resp.json()
    content.push(...(last.content ?? []))
    const u = last.usage ?? {}
    usage.input_tokens += u.input_tokens ?? 0
    usage.output_tokens += u.output_tokens ?? 0
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0
    usage.searches += u.server_tool_use?.web_search_requests ?? 0
    if (last.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: last.content })
  }
  const cost = usage.input_tokens * PRICE.input + usage.output_tokens * PRICE.output
    + usage.cache_creation_input_tokens * PRICE.cacheWrite + usage.cache_read_input_tokens * PRICE.cacheRead + usage.searches * PRICE.search

  // URLs the search really returned (the only ones a note may cite).
  const seen = new Map<string, { title: string; age: string | null }>()
  for (const b of content) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r?.type === 'web_search_result' && r.url) seen.set(r.url, { title: r.title ?? '', age: r.page_age ?? null })
    }
    // Citations on the answer point at search results too.
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c?.type === 'web_search_result_location' && c.url && !seen.has(c.url)) seen.set(c.url, { title: c.title ?? '', age: null })
    }
  }
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  let parsed: any = null
  if (!error) {
    if (last?.stop_reason === 'refusal') error = 'refusal'
    else {
      const a = text.indexOf('{'), z = text.lastIndexOf('}')
      try { parsed = a >= 0 && z > a ? JSON.parse(text.slice(a, z + 1)) : null } catch { parsed = null }
      if (!parsed) error = 'no JSON in response'
    }
  }

  const { data: call } = await admin.from('claude_calls').insert({
    user_id: null, function_name: 'theme-notes', called_at: new Date().toISOString(), model: MODEL,
    input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
    cache_creation_tokens: usage.cache_creation_input_tokens, cache_read_tokens: usage.cache_read_input_tokens,
    cost_usd: Math.round(cost * 1e6) / 1e6, ticker: theme.etf ?? theme.name,
    prompt_input: body, prompt_output: last, matrix_at_call: { theme }, duration_ms: Date.now() - started, error,
  }).select('id').maybeSingle()
  if (error || !parsed) return { theme: theme.name, ok: false, error, cost }

  const sourced = (x: any): Source | null => {
    const url = typeof x?.url === 'string' ? x.url : ''
    if (!url || !seen.has(url) || !allowedHost(url)) return null
    return { url, name: clean(x.name, 60) || hostOf(url), date: dateOrNull(x.date) }
  }
  const d = parsed.driver
  const dSrc = d ? sourced(d) : null
  const dText = clean(d?.text)
  if (!dSrc || !dText || ADVICE.test(dText)) return { theme: theme.name, ok: false, error: 'no sourced driver', cost }
  const risks = (Array.isArray(parsed.risks) ? parsed.risks : []).map((r: any) => {
    const src = sourced(r)
    const t = clean(r?.text)
    if (!src || !t || ADVICE.test(t)) return null
    return { kind: KINDS.has(r?.kind) ? r.kind : 'event', text: t, ...src }
  }).filter(Boolean).slice(0, 3)

  const asOf = new Date().toISOString().slice(0, 10)
  const { error: upErr } = await admin.from('theme_notes').upsert({
    theme: theme.name, as_of: asOf, etf: theme.etf, tickers: theme.tickers,
    driver: dText, driver_source: dSrc, risks, model: MODEL, claude_call_id: call?.id ?? null,
  }, { onConflict: 'theme,as_of' })
  return { theme: theme.name, ok: !upErr, error: upErr?.message ?? null, risks: risks.length, cost }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ') || claimsOf(auth.slice(7))?.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json({ success: false, error: 'edge function misconfigured' }, 500)
  let opts: Record<string, unknown> = {}
  try { opts = await req.json() } catch { /* empty body */ }
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Themes among today's ranked leaders, most leaders first.
  const { data: rows, error } = await admin.from('confluence_ranks')
    .select('ticker, rank, leader_traits').eq('side', 'buy').not('rank', 'is', null).order('rank').limit(200)
  if (error) return json({ success: false, error: error.message }, 500)
  const byTheme = new Map<string, { name: string; etf: string | null; tickers: string[] }>()
  for (const r of rows ?? []) {
    const t = (r.leader_traits as any)?.theme
    if (!t?.name) continue
    if (!byTheme.has(t.name)) byTheme.set(t.name, { name: t.name, etf: t.etf ?? null, tickers: [] })
    byTheme.get(t.name)!.tickers.push(r.ticker)
  }
  const limit = Math.min(MAX_THEMES, Math.max(1, Number(opts.limit) || MAX_THEMES))
  const themes = [...byTheme.values()].sort((a, b) => b.tickers.length - a.tickers.length).slice(0, limit)

  if (opts.dry_run) return json({ success: true, dry_run: true, enabled: ENABLED, themes })
  if (!ENABLED) return json({ success: true, skipped: 'THEME_NOTES_ENABLED is not true', themes: themes.length })
  if (!ANTHROPIC_API_KEY) return json({ success: true, skipped: 'ANTHROPIC_API_KEY not configured' })

  const results = []
  for (const t of themes) {
    try { results.push(await noteFor(admin, t)) } catch (e) { results.push({ theme: t.name, ok: false, error: e instanceof Error ? e.message : 'failed' }) }
    // Out of credits / bad key: every later call fails the same way.
    const lastErr = String((results[results.length - 1] as any).error ?? '')
    if (/anthropic (400|401|402|403)/.test(lastErr) && /credit|billing|api.key|authentication/i.test(lastErr)) break
  }
  const cost = results.reduce((s, r: any) => s + (r.cost ?? 0), 0)
  return json({ success: true, written: results.filter((r: any) => r.ok).length, cost_usd: Math.round(cost * 100) / 100, results })
})
