// Cash Moves — fetch-filings edge function.
//
// Given a ticker (and optionally a company_name), pulls a digestible
// snapshot from three public sources:
//   * SEC EDGAR full-text search — recent 8-K / S-3 / 10-K mentions
//   * ClinicalTrials.gov v2 — active trials matching the company
//   * FDA press-release RSS — mentions of the ticker or company
//
// Each source is independently try/catched so a single bad endpoint
// doesn't kill the whole request. Returns a concatenated text payload
// ready to paste into the AnalyzeFilingPanel textarea, plus a
// structured `sources` array for UI display.
//
// Auth: requires a real user JWT.
// Required Supabase secret: SEC_USER_AGENT (e.g. "PharmaEdge name@email.tld").

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SEC_USER_AGENT = Deno.env.get('SEC_USER_AGENT')

const SEC_FTS = 'https://efts.sec.gov/LATEST/search-index'
const CTGOV = 'https://clinicaltrials.gov/api/v2/studies'
const FDA_RSS =
  'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml'

const SEC_LOOKBACK_DAYS = 90
const FDA_LOOKBACK_DAYS = 30
const FETCH_TIMEOUT_MS = 15_000
const MAX_SEC_HITS = 5
const MAX_CT_TRIALS = 5
const MAX_FDA_ENTRIES = 3
const MAX_PER_SECTION_CHARS = 12_000

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

function timed(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(id) }
}

interface Source {
  type: 'sec' | 'ctgov' | 'fda'
  title: string
  url?: string
  date?: string
  summary?: string
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

async function fetchSec(
  ticker: string,
  company: string | undefined,
): Promise<{ text: string; sources: Source[] }> {
  if (!SEC_USER_AGENT) {
    return {
      text: '=== SEC EDGAR — skipped (SEC_USER_AGENT not set) ===\n',
      sources: [],
    }
  }
  const params = new URLSearchParams({
    q: company ? `"${ticker}" OR "${company}"` : `"${ticker}"`,
    dateRange: 'custom',
    startdt: daysAgo(SEC_LOOKBACK_DAYS),
    forms: '8-K,S-3,10-K,10-Q',
  })
  const t = timed(FETCH_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(`${SEC_FTS}?${params}`, {
      headers: { 'User-Agent': SEC_USER_AGENT, 'Accept-Encoding': 'gzip' },
      signal: t.signal,
    })
  } finally {
    t.cancel()
  }
  if (!resp.ok) {
    return {
      text: `=== SEC EDGAR — error ${resp.status} ===\n`,
      sources: [],
    }
  }
  const body = await resp.json()
  const hits = (body?.hits?.hits ?? []) as Array<{ _source?: Record<string, unknown> }>

  const sources: Source[] = []
  let text = '=== SEC EDGAR — Recent Filings ===\n\n'
  for (const hit of hits.slice(0, MAX_SEC_HITS)) {
    const src = hit._source ?? {}
    const tickers = (src.tickers as string[]) || []
    const formType = String(src.form_type ?? '8-K')
    const fileDate = String(src.file_date ?? '')
    const entityName = String(src.entity_name ?? '')
    const filePath = String(src.file_path ?? '')
    const periodOfReport = String(src.period_of_report ?? '')
    const url = filePath ? `https://www.sec.gov/Archives/edgar/${filePath}` : undefined
    const title = `${formType} — ${entityName}`
    text += `[${fileDate}] ${title} (tickers: ${tickers.join(', ') || '—'})\n`
    if (periodOfReport) text += `  Period: ${periodOfReport}\n`
    if (url) text += `  URL: ${url}\n`
    text += '\n'
    sources.push({ type: 'sec', title, date: fileDate, url })
  }
  if (sources.length === 0) text += '(no recent filings found)\n'
  return { text: text.slice(0, MAX_PER_SECTION_CHARS), sources }
}

async function fetchCtgov(
  company: string,
): Promise<{ text: string; sources: Source[] }> {
  if (!company) {
    return { text: '=== ClinicalTrials.gov — skipped (no company name) ===\n', sources: [] }
  }
  const params = new URLSearchParams({
    'query.term': company,
    'filter.overallStatus': 'ACTIVE_NOT_RECRUITING,RECRUITING,COMPLETED,TERMINATED',
    fields: [
      'NCTId',
      'BriefTitle',
      'OfficialTitle',
      'Phase',
      'OverallStatus',
      'PrimaryCompletionDate',
      'Condition',
      'InterventionName',
      'EnrollmentCount',
      'PrimaryOutcomeMeasure',
      'WhyStopped',
      'StatusVerifiedDate',
      'LeadSponsorName',
    ].join(','),
    pageSize: '20',
    format: 'json',
  })
  const t = timed(FETCH_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(`${CTGOV}?${params}`, { signal: t.signal })
  } finally {
    t.cancel()
  }
  if (!resp.ok) {
    return { text: `=== ClinicalTrials.gov — error ${resp.status} ===\n`, sources: [] }
  }
  const body = await resp.json()
  const studies = (body?.studies ?? []) as Array<Record<string, unknown>>

  // Filter to studies whose sponsor name actually matches (CT.gov's
  // search is loose).
  const cmpLower = company.toLowerCase()
  const matched = studies.filter((s) => {
    const sponsor = String(
      ((s.protocolSection as Record<string, Record<string, Record<string, unknown>>>) ?? {})
        ?.sponsorCollaboratorsModule?.leadSponsor?.name ?? '',
    ).toLowerCase()
    return sponsor.includes(cmpLower) || cmpLower.includes(sponsor.split(/\s+/)[0] ?? '')
  })
  const list = (matched.length > 0 ? matched : studies).slice(0, MAX_CT_TRIALS)

  const sources: Source[] = []
  let text = '=== ClinicalTrials.gov — Trials ===\n\n'
  for (const study of list) {
    const protocol = (study.protocolSection as Record<string, Record<string, unknown>>) ?? {}
    const ident = (protocol.identificationModule as Record<string, unknown>) ?? {}
    const status = (protocol.statusModule as Record<string, unknown>) ?? {}
    const design = (protocol.designModule as Record<string, unknown>) ?? {}
    const outcomes = (protocol.outcomesModule as Record<string, unknown>) ?? {}
    const conditions = (protocol.conditionsModule as Record<string, unknown>) ?? {}

    const nctId = String(ident.nctId ?? '')
    const title = String(ident.briefTitle ?? '')
    const phases = ((design.phases as string[]) ?? []).join(', ')
    const overallStatus = String(status.overallStatus ?? '')
    const primaryCompletion = String(
      (status.primaryCompletionDateStruct as Record<string, unknown>)?.date ?? '',
    )
    const enrollment = String(
      (design.enrollmentInfo as Record<string, unknown>)?.count ?? '',
    )
    const primaryOutcomes = (outcomes.primaryOutcomes as Array<Record<string, string>>) ?? []
    const whyStopped = String(status.whyStopped ?? '')
    const conditionsList = (conditions.conditions as string[]) ?? []

    text += `[${nctId}] ${title}\n`
    text += `  Phase: ${phases || '—'}    Status: ${overallStatus}    Enrollment: ${enrollment || '—'}\n`
    if (primaryCompletion) text += `  Primary Completion: ${primaryCompletion}\n`
    if (conditionsList.length) text += `  Conditions: ${conditionsList.join(', ')}\n`
    if (primaryOutcomes.length > 0) {
      text += `  Primary Outcomes:\n`
      for (const o of primaryOutcomes.slice(0, 3)) {
        text += `    - ${o.measure || ''}\n`
      }
    }
    if (whyStopped) text += `  WHY STOPPED: ${whyStopped}\n`
    text += `  URL: https://clinicaltrials.gov/study/${nctId}\n\n`

    sources.push({
      type: 'ctgov',
      title,
      date: primaryCompletion,
      url: `https://clinicaltrials.gov/study/${nctId}`,
    })
  }
  if (sources.length === 0) text += '(no trials found)\n'
  return { text: text.slice(0, MAX_PER_SECTION_CHARS), sources }
}

async function fetchFdaRss(
  ticker: string,
  company: string | undefined,
): Promise<{ text: string; sources: Source[] }> {
  const t = timed(FETCH_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(FDA_RSS, { signal: t.signal })
  } finally {
    t.cancel()
  }
  if (!resp.ok) {
    return { text: `=== FDA Press — error ${resp.status} ===\n`, sources: [] }
  }
  const xml = await resp.text()
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1])
  const get = (block: string, tag: string): string => {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)
    const m = block.match(re)
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''
  }

  const cutoff = Date.now() - FDA_LOOKBACK_DAYS * 86_400_000
  const tickerLower = ticker.toLowerCase()
  const companyLower = (company ?? '').toLowerCase()

  const matches: Source[] = []
  for (const block of items) {
    const title = get(block, 'title')
    const link = get(block, 'link')
    const pubDateRaw = get(block, 'pubDate')
    const description = get(block, 'description')

    const pubMs = Date.parse(pubDateRaw)
    if (Number.isFinite(pubMs) && pubMs < cutoff) continue

    const haystack = `${title} ${description}`.toLowerCase()
    const hit =
      haystack.includes(tickerLower) ||
      (companyLower && haystack.includes(companyLower))
    if (!hit) continue

    matches.push({
      type: 'fda',
      title,
      url: link,
      date: pubDateRaw,
      summary: description.replace(/<[^>]+>/g, '').slice(0, 600),
    })
    if (matches.length >= MAX_FDA_ENTRIES) break
  }

  let text = '=== FDA Press Releases ===\n\n'
  if (matches.length === 0) text += '(no recent press releases mentioning ticker / company)\n'
  for (const m of matches) {
    text += `[${m.date || '?'}] ${m.title}\n`
    if (m.url) text += `  URL: ${m.url}\n`
    if (m.summary) text += `  Summary: ${m.summary}\n`
    text += '\n'
  }
  return { text: text.slice(0, MAX_PER_SECTION_CHARS), sources: matches }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

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

  const ticker = String(body.ticker ?? '').trim().toUpperCase()
  const companyName = body.company_name ? String(body.company_name).trim() : undefined

  if (!ticker) return json({ success: false, error: 'ticker is required' }, 400)

  const [secResult, ctResult, fdaResult] = await Promise.allSettled([
    fetchSec(ticker, companyName),
    fetchCtgov(companyName ?? ticker),
    fetchFdaRss(ticker, companyName),
  ])

  function ok<T>(r: PromiseSettledResult<T>): T | null {
    return r.status === 'fulfilled' ? r.value : null
  }
  const sec = ok(secResult)
  const ct = ok(ctResult)
  const fda = ok(fdaResult)

  const errors: string[] = []
  if (secResult.status === 'rejected') errors.push(`sec: ${String(secResult.reason).slice(0, 200)}`)
  if (ctResult.status === 'rejected') errors.push(`ctgov: ${String(ctResult.reason).slice(0, 200)}`)
  if (fdaResult.status === 'rejected') errors.push(`fda: ${String(fdaResult.reason).slice(0, 200)}`)

  const header =
    `Ticker: ${ticker}\n` +
    (companyName ? `Company: ${companyName}\n` : '') +
    `Generated: ${new Date().toISOString()}\n\n`

  const text =
    header +
    (sec?.text ?? '') +
    '\n' +
    (ct?.text ?? '') +
    '\n' +
    (fda?.text ?? '')

  const sources = [
    ...(sec?.sources ?? []),
    ...(ct?.sources ?? []),
    ...(fda?.sources ?? []),
  ]

  return json({
    success: true,
    text,
    sources,
    counts: {
      sec: sec?.sources.length ?? 0,
      ctgov: ct?.sources.length ?? 0,
      fda: fda?.sources.length ?? 0,
    },
    errors,
  })
})
