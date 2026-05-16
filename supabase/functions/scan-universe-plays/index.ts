// Cash Moves — scan-universe-plays edge function.
// Verified working 2026-05-13: 7 plays from 2/3 tickers, $0.06 cost,
// 86s duration. compute-gex now self-validates (config.toml verify_jwt=false).
//
// Cross-ticker GEX scanner. Iterates the user's watchlist (stars) ∪
// open-position tickers, runs the same
// Claude prompt as suggest-plays for each ticker, aggregates and
// ranks the resulting plays by ev_edge_bp, writes a snapshot row to
// top_plays_feed.
//
// Triggered by:
//   - Supabase pg_cron every 15 min during RTH (handled in cron SQL)
//   - Manual invocation via service-role JWT for testing
//
// Auth: shared SCAN_AUTH_TOKEN (cron) OR service-role JWT (manual).
// No user JWT path — this is system infrastructure.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  generatePlaysForTicker,
  SCAN_ACCOUNT_SIZE_REFERENCE,
} from '../_shared/playSuggester.ts'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const SCAN_AUTH_TOKEN = Deno.env.get('SCAN_AUTH_TOKEN')

// Anthropic + Polygon comfortable parallelism. Anthropic Sonnet 4.6
// default tier is 4,000 RPM; Polygon Options Advanced is ~200 req/min;
// each ticker triggers ~10 Polygon calls so 8 in flight = ~80/min
// peak — well under the Polygon limit.
//
// History: started at 4. At 4, full 19-ticker scans averaged ~140s,
// hitting Supabase Edge's ~150s runtime cap and getting killed before
// the final top_plays_feed insert. cron.job_run_details showed
// successful HTTP queue but no rows landed. Bumped to 8 → ~75-95s
// per scan, well under the runtime cap. Don't go above 12 without
// measuring Anthropic 429s.
const CONCURRENCY = 2

// Cap on plays per feed row. Most users won't scroll past 10; 15
// gives breathing room so the next user opening the app sees a fresh
// top-10 even if the top few got consumed by earlier loggers.
const MAX_PLAYS_PER_FEED = 15

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'edge function misconfigured' }, 500)
  }

  const startedAt = Date.now()
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Auth: cron secret OR service-role JWT OR vault-stored cron token.
  //
  // The vault path is what makes the pg_cron schedule work without any
  // dashboard env-var setup. We store the token in vault.decrypted_secrets
  // under the name 'cron_scan_auth_token' (see migration); pg_cron reads
  // the same row when building its Bearer header. Both sides agree on
  // the value with zero manual config.
  const authHeader = req.headers.get('Authorization') || ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''

  const isCron = !!SCAN_AUTH_TOKEN && bearer === SCAN_AUTH_TOKEN
  const isServiceRole = !!SUPABASE_SERVICE_ROLE_KEY && bearer === SUPABASE_SERVICE_ROLE_KEY
  let isVaultCron = false
  if (!isCron && !isServiceRole && bearer) {
    // vault.decrypted_secrets is not reachable via PostgREST .schema()
    // lookups; we bridge it through a SECURITY DEFINER RPC in public
    // that service_role can call. See migration cron_token_rpc.
    const { data: vaultToken } = await adminClient.rpc('get_cron_scan_auth_token')
    isVaultCron = typeof vaultToken === 'string' && vaultToken.length > 0 && bearer === vaultToken
  }
  if (!isCron && !isServiceRole && !isVaultCron) {
    return json({ error: 'unauthorized' }, 401)
  }

  // Optional body for manual overrides (e.g. { scan_kind: 'manual',
  // force: true } to bypass the RTH check during testing).
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body is fine */ }
  const scanKind = (body.scan_kind === 'manual' || body.scan_kind === 'eod')
    ? body.scan_kind
    : 'rth_15min'
  const force = body.force === true

  // Belt-and-braces RTH check. The cron schedule limits firing to
  // 13:00-21:00 UTC weekdays, but this catches market holidays and
  // off-schedule manual hits. `force: true` bypasses for testing.
  if (!force && scanKind === 'rth_15min' && !isWithinRth()) {
    return json({ skipped: true, reason: 'outside RTH' }, 200)
  }

  // Fan out with bounded concurrency. Promise.allSettled semantics:
  // one ticker's failure doesn't poison others.
  const results: Array<{
    ticker: string
    success: boolean
    plays: any[]
    error?: string
    cost_usd: number
    claude_call_id: string | null
    rejections: Record<string, unknown> | null
  }> = []

  // Scan universe = the user's curated watchlist (stars) ∪ tickers
  // they hold an open position in. NOT the old hardcoded 19-name
  // SCAN_UNIVERSE — that 19 × CONCURRENCY-8 × every-15-min × the
  // (now enriched) prompt is what blew the Anthropic 30K-tokens/min
  // org cap and drained the credit balance. Discovery is now
  // explicitly manual: star a name to have it auto-scanned. Empty
  // watchlist + no open positions → scan nothing (correct + free;
  // we deliberately do NOT fall back to the 19-list, that would
  // recreate the blowout the moment credits are restored).
  const { data: wl } = await adminClient
    .from('watchlist').select('ticker')
  const { data: op } = await adminClient
    .from('open_positions').select('ticker').eq('status', 'open')
  const dynamicUniverse = Array.from(new Set([
    ...(wl ?? []).map((r: { ticker: string }) => String(r.ticker).toUpperCase()),
    ...(op ?? []).map((r: { ticker: string }) => String(r.ticker).toUpperCase()),
  ])).filter(Boolean)

  if (dynamicUniverse.length === 0) {
    return json({
      skipped: true,
      reason: 'empty watchlist + no open positions — nothing to scan',
      scan_kind: scanKind,
      tickers_scanned: 0,
    }, 200)
  }

  const queue = [...dynamicUniverse]
  const inflight = new Set<Promise<void>>()
  while (queue.length > 0 || inflight.size > 0) {
    while (inflight.size < CONCURRENCY && queue.length > 0) {
      const ticker = queue.shift()!
      const task = (async () => {
        try {
          const result = await generatePlaysForTicker(
            adminClient,
            ticker,
            SCAN_ACCOUNT_SIZE_REFERENCE,
            {
              functionName: 'scan-universe-plays',
              userId: null,
              topN: 5,
              supabaseUrl: SUPABASE_URL!,
              supabaseAnonKey: SUPABASE_ANON_KEY!,
              supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY!,
              anthropicApiKey: ANTHROPIC_API_KEY!,
            },
          )
          results.push({
            ticker,
            success: true,
            plays: result.parsed?.plays ?? [],
            cost_usd: result.costUsd,
            claude_call_id: result.claudeCallId,
            rejections: result.rejections,
          })
        } catch (err) {
          results.push({
            ticker,
            success: false,
            plays: [],
            error: err instanceof Error ? err.message : String(err),
            cost_usd: 0,
            claude_call_id: null,
            rejections: null,
          })
        }
      })()
      inflight.add(task)
      task.finally(() => inflight.delete(task))
    }
    if (inflight.size > 0) await Promise.race(inflight)
  }

  // Aggregate. Attach the source ticker + claude_call_id onto each
  // play so the frontend can deep-link the user into LogSignal with
  // full provenance. Rank by ev_edge_bp DESC; null edge goes last.
  const allPlays: any[] = []
  const errors: Record<string, string> = {}
  // Why-killed roll-up. Without this, a scan where Claude proposed
  // strong plays but every one died at Polygon price-verification is
  // indistinguishable from a genuine no-setup day — the exact
  // ambiguity that made "0 plays all day" un-diagnosable.
  const rejAgg = {
    pricing: 0, rr: 0, ev: 0, pop: 0, structure: 0,
    proposed: 0, verified: 0,
    // Universe-wide structure mix — how much of Claude's proposal
    // budget is still going to credit/IC structures that almost never
    // clear. Trend this across scans to judge prompt-rule compliance.
    mix: { credit_proposed: 0, debit_proposed: 0, credit_verified: 0, debit_verified: 0 },
    by_ticker: {} as Record<string, Record<string, unknown>>,
  }
  let totalCostUsd = 0
  for (const r of results) {
    if (!r.success) {
      errors[r.ticker] = r.error || 'unknown error'
      continue
    }
    totalCostUsd += r.cost_usd
    const rej = r.rejections as Record<string, number> | null
    if (rej && Number(rej.total) > 0) {
      rejAgg.pricing += Number(rej.pricing) || 0
      rejAgg.rr += Number(rej.rr) || 0
      rejAgg.ev += Number(rej.ev) || 0
      rejAgg.pop += Number(rej.pop) || 0
      rejAgg.structure += Number(rej.structure) || 0
      rejAgg.proposed += Number(rej.proposed) || 0
      rejAgg.verified += Number(rej.verified) || 0
      const m = (r.rejections as { mix?: Record<string, number> } | null)?.mix
      if (m) {
        rejAgg.mix.credit_proposed += Number(m.credit_proposed) || 0
        rejAgg.mix.debit_proposed += Number(m.debit_proposed) || 0
        rejAgg.mix.credit_verified += Number(m.credit_verified) || 0
        rejAgg.mix.debit_verified += Number(m.debit_verified) || 0
      }
      rejAgg.by_ticker[r.ticker] = r.rejections!
    }
    for (const play of r.plays) {
      allPlays.push({
        ...play,
        ticker: r.ticker,
        claude_call_id: r.claude_call_id,
      })
    }
  }
  const pricingRejections = (rejAgg.pricing + rejAgg.rr + rejAgg.ev +
    rejAgg.pop + rejAgg.structure) > 0 ? rejAgg : null
  allPlays.sort((a, b) => {
    const ae = typeof a.ev_edge_bp === 'number' ? a.ev_edge_bp : -Infinity
    const be = typeof b.ev_edge_bp === 'number' ? b.ev_edge_bp : -Infinity
    return be - ae
  })
  const rankedPlays = allPlays.slice(0, MAX_PLAYS_PER_FEED)
  const totalGenerated = allPlays.length
  const tickersSucceeded = results.filter((r) => r.success).length
  const tickersFailed = results.filter((r) => !r.success).length
  const durationMs = Date.now() - startedAt

  const { error: insertError } = await adminClient
    .from('top_plays_feed')
    .insert({
      scan_kind: scanKind,
      universe: dynamicUniverse,
      tickers_scanned: dynamicUniverse.length,
      tickers_succeeded: tickersSucceeded,
      tickers_failed: tickersFailed,
      total_plays_generated: totalGenerated,
      total_plays_after_filter: rankedPlays.length,
      duration_ms: durationMs,
      total_cost_usd: totalCostUsd,
      ranked_plays: rankedPlays,
      errors: Object.keys(errors).length > 0 ? errors : null,
      pricing_rejections: pricingRejections,
      pricing_source: 'verified',
      pricing_verified_at: new Date().toISOString(),
    })
  if (insertError) {
    console.error('[scan] top_plays_feed insert failed:', insertError.message)
    return json({ success: false, error: insertError.message }, 500)
  }

  return json({
    success: true,
    scan_kind: scanKind,
    duration_ms: durationMs,
    tickers_scanned: dynamicUniverse.length,
    tickers_succeeded: tickersSucceeded,
    tickers_failed: tickersFailed,
    total_plays_generated: totalGenerated,
    total_plays_after_filter: rankedPlays.length,
    total_cost_usd: totalCostUsd,
    errors: Object.keys(errors).length > 0 ? errors : null,
    pricing_rejections: pricingRejections,
  }, 200)
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

function isWithinRth(): boolean {
  // ET: Mon-Fri, 10:00am-4:00pm. Scan starts at 10:00, not the 9:30
  // open: the first 30 min is the least-reliable GEX read of the day —
  // dealer hedges from the opening auction haven't settled, overnight
  // gamma is still unwinding, and spreads are wide, so a 9:30 scan
  // surfaces noise dressed as a setup. Letting the matrix stabilize
  // until 10:00 trades one scan for materially better signal.
  // Holidays are out of scope here — the function will run and produce
  // a feed; that's harmless (cost is bounded by the dynamic universe
  // size and Anthropic prompt caching).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date())
  const weekday = parts.find((p) => p.type === 'weekday')?.value
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const mins = hour * 60 + minute
  return mins >= 10 * 60 && mins < 16 * 60
}
