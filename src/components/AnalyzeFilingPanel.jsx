import { useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Download,
  Sparkles,
} from 'lucide-react'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/supabase'
import clsx from 'clsx'

const MIN_FILING_CHARS = 200
const MAX_FILING_CHARS = 50_000

export default function AnalyzeFilingPanel({
  ticker,
  companyName,
  drugName,
  indication,
  catalystType,
  catalystDate,
  catalystDatePrecision,
  analysis,
  onAnalysisComplete,
  onAnalysisReset,
}) {
  const [filingText, setFilingText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [fetchInfo, setFetchInfo] = useState('')
  // Live progress fed by the analyze-signal SSE stream.
  const [progressText, setProgressText] = useState('')
  const [searchActivity, setSearchActivity] = useState([])

  async function fetchFilings() {
    if (!ticker?.trim()) {
      setError('Enter a ticker first')
      return
    }
    setFetching(true)
    setError('')
    setFetchInfo('')
    try {
      const { data, error: fnError } = await supabase.functions.invoke('fetch-filings', {
        body: { ticker, company_name: companyName },
      })
      if (fnError) {
        let body = null
        try {
          body = await fnError.context?.json?.()
        } catch {
          /* ignore */
        }
        throw new Error(body?.error || fnError.message || 'fetch failed')
      }
      if (!data?.success) throw new Error(data?.error || 'fetch failed')

      // Append to existing text rather than clobbering — user may have
      // typed a manual snippet first.
      setFilingText((cur) => (cur ? `${cur}\n\n${data.text}` : data.text))

      const c = data.counts || {}
      const errs = (data.errors || []).join('; ')
      setFetchInfo(
        `Pulled ${c.sec ?? 0} SEC · ${c.ctgov ?? 0} CT.gov · ${c.fda ?? 0} FDA${errs ? ` (errors: ${errs})` : ''}`,
      )
    } catch (e) {
      setError(e.message || 'fetch failed')
    }
    setFetching(false)
  }

  async function runAnalysis() {
    if (!filingText.trim()) {
      setError('Paste filing text to analyze')
      return
    }
    if (filingText.length < MIN_FILING_CHARS) {
      setError(`Need at least ${MIN_FILING_CHARS} characters of filing text for a meaningful analysis`)
      return
    }
    if (filingText.length > MAX_FILING_CHARS) {
      setError(`Filing text exceeds the ${MAX_FILING_CHARS.toLocaleString()} character cap`)
      return
    }

    setLoading(true)
    setError('')
    setProgressText('')
    setSearchActivity([])
    try {
      // analyze-signal streams Server-Sent Events. supabase-js's
      // functions.invoke() doesn't read streams, so go raw fetch
      // and parse the SSE protocol manually.
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData?.session?.access_token
      if (!accessToken) throw new Error('Not signed in')

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/analyze-signal`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          ticker,
          company_name: companyName,
          drug_name: drugName,
          indication,
          catalyst_type: catalystType,
          catalyst_date: catalystDate,
          catalyst_date_precision: catalystDatePrecision || 'day',
          filing_text: filingText,
        }),
      })

      if (!resp.ok) {
        // The server may have returned a JSON error before opening a
        // stream (auth failure, rate limit, etc).
        let msg = `analyze-signal returned ${resp.status}`
        try {
          const body = await resp.json()
          if (body?.error) msg = body.error
        } catch {
          /* ignore */
        }
        throw new Error(msg)
      }
      if (!resp.body) throw new Error('analyze-signal returned no body')

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let final = null
      let streamErr = null

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Each SSE event ends with a blank line.
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const block of events) {
          if (!block.trim() || block.trim().startsWith(':')) continue // keepalive
          let eventName = 'message'
          let dataRaw = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim()
            else if (line.startsWith('data: ')) dataRaw += line.slice(6)
          }
          if (!dataRaw) continue
          let payload
          try {
            payload = JSON.parse(dataRaw)
          } catch {
            continue
          }
          if (eventName === 'text' && typeof payload?.delta === 'string') {
            setProgressText((cur) => cur + payload.delta)
          } else if (eventName === 'search') {
            const query = String(payload?.query || '').slice(0, 100)
            setSearchActivity((cur) => [...cur, query])
          } else if (eventName === 'complete') {
            final = payload
          } else if (eventName === 'error') {
            streamErr = payload?.error || 'analysis failed'
          }
        }
      }

      if (streamErr) throw new Error(streamErr)
      if (!final?.analysis) throw new Error('analysis stream ended without a result')

      onAnalysisComplete?.({
        ...final.analysis,
        _market_metrics: final.market_metrics ?? null,
        _citations: final.citations ?? [],
        _web_searches_used: final.web_searches_used ?? 0,
      })
    } catch (e) {
      // Log the full error to the console so we can DevTools-inspect
      // even when the UI fallback text is generic.
      // eslint-disable-next-line no-console
      console.error('[analyze-signal] failed', e)
      const msg = e?.message || String(e) || 'Analysis failed. Check your filing text and try again.'
      setError(msg)
    }
    setLoading(false)
    setProgressText('')
    setSearchActivity([])
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden mb-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-red-400" />
          <span className="text-white text-sm font-semibold">Pre-Trade Research</span>
          {analysis && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border border-green-900 bg-green-950/40 text-green-400">
              ✓ Saved as draft
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp size={14} className="text-zinc-500" />
        ) : (
          <ChevronDown size={14} className="text-zinc-500" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4">
          {!analysis ? (
            <>
              <p className="text-subtle text-xs mb-3">
                Auto-fetch a snapshot from CT.gov, SEC EDGAR, and FDA, or paste text from any
                public source. Edit before analysis. Cash Moves scores the signal.
              </p>

              <div className="flex items-center justify-between mb-3 gap-2">
                <button
                  type="button"
                  onClick={fetchFilings}
                  disabled={fetching || !ticker?.trim()}
                  className="flex items-center gap-2 bg-card border border-border hover:border-red-500
                             disabled:opacity-50 text-white text-xs font-semibold rounded-lg
                             px-3 py-2 transition-colors"
                >
                  {fetching ? (
                    <>
                      <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                      Fetching…
                    </>
                  ) : (
                    <>
                      <Download size={12} />
                      Fetch filings for {ticker || '—'}
                    </>
                  )}
                </button>
                {fetchInfo && (
                  <p className="text-subtle text-[10px] text-right flex-1 truncate">
                    {fetchInfo}
                  </p>
                )}
              </div>

              <textarea
                value={filingText}
                onChange={(e) => setFilingText(e.target.value)}
                placeholder={`Paste filing text here…

Good sources:
• ClinicalTrials.gov study details
• SEC 8-K or 10-Q filing excerpts
• FDA advisory committee briefing documents
• Company press release with trial data
• Patent filings`}
                rows={8}
                maxLength={MAX_FILING_CHARS}
                className="w-full bg-bg border border-border text-zinc-300
                           placeholder-zinc-700 rounded-xl px-4 py-3 text-xs
                           focus:outline-none focus:border-red-500 transition-colors
                           resize-none font-mono"
              />

              <div className="flex items-center justify-between mt-3">
                <p className={clsx(
                  'text-[10px]',
                  filingText.length < MIN_FILING_CHARS ? 'text-muted' : 'text-subtle'
                )}>
                  {filingText.length.toLocaleString()} / {MAX_FILING_CHARS.toLocaleString()} chars
                </p>
                <button
                  type="button"
                  onClick={runAnalysis}
                  disabled={loading || filingText.length < MIN_FILING_CHARS}
                  className="flex items-center gap-2 bg-red-600 hover:bg-red-500
                             disabled:bg-red-950 disabled:text-red-900
                             text-white text-xs font-semibold px-4 py-2 rounded-lg
                             transition-colors"
                >
                  {loading ? (
                    <>
                      <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                      Analyzing…
                    </>
                  ) : (
                    <>
                      <Sparkles size={12} />
                      Analyze Filing
                    </>
                  )}
                </button>
              </div>

              {loading && (progressText || searchActivity.length > 0) && (
                <div className="mt-3 bg-bg border border-border rounded-lg p-3 space-y-2">
                  {searchActivity.length > 0 && (
                    <div>
                      <p className="text-muted text-[10px] uppercase tracking-wider mb-1">
                        Searching the web
                      </p>
                      {searchActivity.slice(-3).map((q, i) => (
                        <p key={i} className="text-zinc-400 text-[11px]">
                          🔍 {q}
                        </p>
                      ))}
                    </div>
                  )}
                  {progressText && (
                    <div>
                      <p className="text-muted text-[10px] uppercase tracking-wider mb-1">
                        Reasoning ({progressText.length} chars)
                      </p>
                      <p className="text-zinc-500 text-[10px] font-mono leading-snug max-h-24 overflow-y-auto whitespace-pre-wrap">
                        {progressText.slice(-400)}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 mt-3 bg-red-950/30 border border-red-900/50 rounded-lg p-3">
                  <AlertCircle size={12} className="text-red-400 mt-0.5 flex-shrink-0" />
                  <p className="text-red-400 text-xs">{error}</p>
                </div>
              )}
            </>
          ) : (
            <AnalysisResult analysis={analysis} onReset={() => onAnalysisReset?.()} />
          )}
        </div>
      )}
    </div>
  )
}

function AnalysisResult({ analysis, onReset }) {
  const directionColor =
    {
      long_put: 'text-red-400 bg-red-950 border-red-800',
      long_call: 'text-green-400 bg-green-950 border-green-800',
      watch: 'text-zinc-400 bg-zinc-900 border-zinc-700',
    }[analysis.direction_recommendation] || 'text-zinc-400 bg-zinc-900 border-zinc-700'

  const confidence = analysis.confidence_score ?? 0
  const yourProb = analysis.your_probability
  const marketProb = analysis.market_implied_probability

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className={clsx('text-xs font-bold px-3 py-1 rounded-full border', directionColor)}>
          {(analysis.direction_recommendation || 'watch').replace('_', ' ').toUpperCase()}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-subtle text-xs">Confidence</span>
          <div className="flex gap-0.5">
            {Array(10)
              .fill(0)
              .map((_, i) => (
                <div
                  key={i}
                  className={clsx(
                    'w-1.5 h-3 rounded-sm',
                    i < confidence ? 'bg-red-500' : 'bg-zinc-800'
                  )}
                />
              ))}
          </div>
          <span className="text-white text-xs font-bold">{confidence}</span>
        </div>
      </div>

      <div>
        <p className="text-muted text-[10px] uppercase tracking-wider mb-1">Thesis</p>
        <p className="text-zinc-300 text-sm leading-relaxed">{analysis.thesis}</p>
      </div>

      {analysis.claude_analysis && (
        <div>
          <p className="text-muted text-[10px] uppercase tracking-wider mb-1">Detailed Analysis</p>
          <p className="text-zinc-400 text-xs leading-relaxed whitespace-pre-wrap">
            {analysis.claude_analysis}
          </p>
        </div>
      )}

      {(analysis.bull_case || analysis.bear_case) && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-green-950/20 border border-green-900/30 rounded-lg p-3">
            <p className="text-green-400 text-[10px] font-semibold mb-1">BULL CASE</p>
            <p className="text-zinc-400 text-[11px] leading-relaxed">{analysis.bull_case || '—'}</p>
          </div>
          <div className="bg-red-950/20 border border-red-900/30 rounded-lg p-3">
            <p className="text-red-400 text-[10px] font-semibold mb-1">BEAR CASE</p>
            <p className="text-zinc-400 text-[11px] leading-relaxed">{analysis.bear_case || '—'}</p>
          </div>
        </div>
      )}

      {yourProb != null && (
        <div className="bg-bg rounded-lg p-3 border border-border">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-white font-bold text-sm">{marketProb ?? '?'}%</p>
              <p className="text-muted text-[10px]">Market</p>
            </div>
            <div>
              <p className="text-red-400 font-bold text-sm">
                {Math.abs((marketProb ?? 50) - yourProb)}pt
              </p>
              <p className="text-muted text-[10px]">Edge</p>
            </div>
            <div>
              <p className="text-white font-bold text-sm">{yourProb}%</p>
              <p className="text-muted text-[10px]">Move Read</p>
            </div>
          </div>
        </div>
      )}

      <SearchProvenance
        searches={analysis._web_searches_used ?? 0}
        citations={analysis._citations ?? []}
      />

      {analysis._market_metrics && (
        <div className="bg-bg border border-border rounded-lg p-3">
          <p className="text-muted text-[10px] uppercase tracking-wider mb-2">
            Live Market Conditions
          </p>
          <div className="grid grid-cols-3 gap-2 text-center">
            {analysis._market_metrics.iv != null && (
              <div>
                <p className="text-white text-sm font-bold">
                  {(analysis._market_metrics.iv * 100).toFixed(1)}%
                </p>
                <p className="text-muted text-[10px]">30-day IV</p>
              </div>
            )}
            {analysis._market_metrics.ivRank != null && (
              <div>
                <p className="text-white text-sm font-bold">
                  {(analysis._market_metrics.ivRank * 100).toFixed(0)}
                </p>
                <p className="text-muted text-[10px]">IV Rank /100</p>
              </div>
            )}
            {analysis._market_metrics.hv30 != null && (
              <div>
                <p className="text-white text-sm font-bold">
                  {(analysis._market_metrics.hv30 * 100).toFixed(1)}%
                </p>
                <p className="text-muted text-[10px]">30-day HV</p>
              </div>
            )}
          </div>
        </div>
      )}

      {analysis.strike_suggestion && (
        <div className="bg-bg border border-border rounded-lg p-3">
          <p className="text-muted text-[10px] uppercase tracking-wider mb-2">
            Strike Suggestion
          </p>
          <div className="grid grid-cols-3 gap-2 text-center mb-2">
            {analysis.strike_suggestion.buy_strike_pct_otm != null && (
              <div>
                <p className="text-white text-sm font-bold">
                  {analysis.strike_suggestion.buy_strike_pct_otm}%
                </p>
                <p className="text-muted text-[10px]">Buy OTM</p>
              </div>
            )}
            {analysis.strike_suggestion.sell_strike_pct_otm != null && (
              <div>
                <p className="text-white text-sm font-bold">
                  {analysis.strike_suggestion.sell_strike_pct_otm}%
                </p>
                <p className="text-muted text-[10px]">Sell OTM</p>
              </div>
            )}
            {analysis.strike_suggestion.expected_move_pct != null && (
              <div>
                <p className="text-red-400 text-sm font-bold">
                  {analysis.strike_suggestion.expected_move_pct}%
                </p>
                <p className="text-muted text-[10px]">Expected Move</p>
              </div>
            )}
          </div>
          {analysis.strike_suggestion.rationale && (
            <p className="text-zinc-400 text-[11px] leading-relaxed">
              {analysis.strike_suggestion.rationale}
            </p>
          )}
        </div>
      )}

      {analysis.flags?.length > 0 && (
        <div>
          <p className="text-muted text-[10px] uppercase tracking-wider mb-2">Red Flags</p>
          <div className="space-y-1">
            {analysis.flags.map((flag, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-red-500 text-xs mt-0.5">⚠</span>
                <p className="text-zinc-400 text-xs">{flag}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {analysis.data_quality && (
        <div className="flex items-center justify-between">
          <div>
            <p className="text-muted text-[10px] uppercase tracking-wider">Data Quality</p>
            <p
              className={clsx('text-xs font-semibold mt-0.5', {
                'text-green-400': analysis.data_quality === 'high',
                'text-yellow-400': analysis.data_quality === 'medium',
                'text-red-400': analysis.data_quality === 'low',
              })}
            >
              {analysis.data_quality.toUpperCase()}
              {analysis.data_quality_reason ? ` — ${analysis.data_quality_reason}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onReset}
            className="text-subtle text-xs hover:text-zinc-400 transition-colors"
          >
            Re-analyze
          </button>
        </div>
      )}
    </div>
  )
}

function SearchProvenance({ searches, citations }) {
  // Always render — when searches=0 we show an honest "no web context"
  // hint so the user knows this analysis was filing-text only.
  const list = Array.isArray(citations) ? citations : []
  // Citations from Anthropic web_search come in as objects; we display
  // url + title when present. Dedup by URL.
  const seen = new Set()
  const items = []
  for (const c of list) {
    const url = c?.url || c?.encrypted_url || ''
    if (!url || seen.has(url)) continue
    seen.add(url)
    items.push({ url, title: c?.title || url })
    if (items.length >= 8) break
  }
  if (searches === 0 && items.length === 0) {
    return (
      <div className="bg-bg border border-border rounded-lg p-3">
        <p className="text-muted text-[10px] uppercase tracking-wider mb-1">
          Web Search
        </p>
        <p className="text-zinc-500 text-xs">
          Analysis based on filing text only — no web context pulled.
        </p>
      </div>
    )
  }
  return (
    <div className="bg-bg border border-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-muted text-[10px] uppercase tracking-wider">
          Web Search
        </p>
        <span className="text-zinc-400 text-[10px]">
          🔍 {searches} {searches === 1 ? 'search' : 'searches'}
        </span>
      </div>
      {items.length > 0 ? (
        <div className="space-y-1">
          {items.map((c, i) => (
            <a
              key={i}
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-red-400 text-xs hover:text-red-300 truncate"
              title={c.url}
            >
              {c.title}
            </a>
          ))}
        </div>
      ) : (
        <p className="text-zinc-500 text-xs">
          {searches} search{searches === 1 ? '' : 'es'} performed but no
          source URLs returned.
        </p>
      )}
    </div>
  )
}
