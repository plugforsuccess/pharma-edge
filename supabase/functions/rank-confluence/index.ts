// Confluence ranking edge function (owner, 2026-10-04).
// Ranks ~545 tickers on buy/sell confluence, pooled history, and E+T+B convergence.
// Runs on Supabase infrastructure to bypass organization network policy.
//
// Modes: full (rank + alerts), rank-only (rank, no alerts), dry-run (print, no writes)
// Env: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, RESEND_FROM, APP_URL (optional)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { yahooBars } from '../_shared/yahoo.ts'
import {
  entryModel, HORIZONS,
} from '../_shared/indicators.js'
import { suiteModel } from '../_shared/signalSuite.js'
import {
  confluenceModel, poolStats, blendedEstimate, MIN_SCORE, SIDES,
} from '../_shared/confluence.js'
import { CHART_TICKERS } from '../_shared/chartTickers.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'Cash Moves <alerts@cashmoves.io>'
const APP_URL = Deno.env.get('APP_URL') || 'https://cashmoves.io'

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

const DEFAULT_UNIVERSE = CHART_TICKERS

const CONCURRENCY = 4
const TOP = 10

interface AnalysisResult {
  ticker: string
  asOf: string
  close: number
  conditionsMet: number
  trendUp: boolean
  etbConvergence: boolean
  buy: {
    today: { now: { score: number; lit: string[] } | null }
    setups: Array<{ key: string }>
  }
  sell: {
    today: { now: { score: number; lit: string[] } | null }
    setups: Array<{ key: string }>
  }
}

interface RankRow {
  side: string
  ticker: string
  as_of: string
  close: number
  score: number
  lit: string[]
  combo: string | null
  conditions_met: number | null
  trend_up: boolean
  own_n: number
  pool_n: number
  est_at_turn: number | null
  est_3m: number | null
  est_6m: number | null
  est_12m: number | null
  est_win_6m: number | null
  last_signal: string | null
  etb_convergence: boolean
  rank: number | null
}

function analyze(ticker: string, bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>): AnalysisResult | null {
  if (!bars || bars.length < 300) return null
  const model = entryModel(bars)
  const suite = suiteModel(bars)
  const conf = confluenceModel({ bars, model, suite, horizons: HORIZONS })
  const lastIdx = bars.length - 1
  const lastSignal = (flags: Record<string, boolean[]>) => {
    for (let i = lastIdx; i >= Math.max(0, lastIdx - 10); i--) {
      if (Object.values(flags).filter((f) => f && Array.isArray(f)).some((f) => f[i])) {
        return bars[i].t
      }
    }
    return null
  }
  const c = model.status.cond
  const etbToday = conf.buy.flags.etb?.[lastIdx]?.fired ?? false
  return {
    ticker,
    asOf: bars[lastIdx].t,
    close: bars[lastIdx].c,
    trendUp: model.status.slope200 != null && model.status.slope200 > 0,
    conditionsMet: ['band', 'rising', 'trend', 'rsi', 'iv'].filter((k) => c[k]).length,
    etbConvergence: etbToday,
    buy: { today: conf.buy.today, setups: conf.buy.setups, lastSignal: lastSignal(conf.buy.flags) },
    sell: { today: conf.sell.today, setups: conf.sell.setups, lastSignal: lastSignal(conf.sell.flags) },
  }
}

function rankAll(results: AnalysisResult[], pools: Record<string, Record<string, any>>): RankRow[] {
  const rows: RankRow[] = []
  for (const side of SIDES) {
    const cands: RankRow[] = []
    for (const r of results) {
      const est = blendedEstimate({ today: r[side].today, setups: r[side].setups, pool: pools[side], horizons: HORIZONS, side })
      const now = r[side].today.now
      const row: RankRow = {
        side,
        ticker: r.ticker,
        as_of: r.asOf,
        close: r.close,
        score: now?.score ?? 0,
        lit: now?.lit ?? [],
        combo: now?.key || null,
        conditions_met: side === 'buy' ? r.conditionsMet : null,
        trend_up: r.trendUp,
        own_n: est?.ownN ?? 0,
        pool_n: est?.poolN ?? 0,
        est_at_turn: est?.atTurn ?? null,
        est_3m: est?.horizons?.find((x: any) => x.label === '3M')?.avg ?? null,
        est_6m: est?.horizons?.find((x: any) => x.label === '6M')?.avg ?? null,
        est_12m: est?.horizons?.find((x: any) => x.label === '12M')?.avg ?? null,
        est_win_6m: est?.horizons?.find((x: any) => x.label === '6M')?.winRate ?? null,
        last_signal: r[side].lastSignal,
        etb_convergence: side === 'buy' ? r.etbConvergence : false,
        rank: null,
      }
      rows.push(row)
      const eligible = row.score >= MIN_SCORE && (side === 'buy' ? row.trend_up : true)
      if (eligible) cands.push(row)
    }
    cands.sort((a, b) => {
      if (side === 'buy') {
        if (b.etb_convergence !== a.etb_convergence) return (b.etb_convergence ? 1 : 0) - (a.etb_convergence ? 1 : 0)
      }
      return b.score - a.score || (side === 'buy' ? (b.conditions_met ?? 0) - (a.conditions_met ?? 0) : 0)
        || String(b.last_signal ?? '').localeCompare(String(a.last_signal ?? ''))
        || (side === 'buy' ? (b.est_6m ?? 0) - (a.est_6m ?? 0) : (a.est_3m ?? 0) - (b.est_3m ?? 0))
    })
    cands.forEach((row, k) => { row.rank = k + 1 })
  }
  return rows
}

function poolRows(pools: Record<string, Record<string, any>>, results: AnalysisResult[], asOf: string) {
  const out = []
  for (const side of SIDES) {
    for (const p of Object.values(pools[side])) {
      const hz = (label: string) => p.horizons?.find((x: any) => x.label === label)
      out.push({
        side,
        combo: p.key,
        lit: p.lit,
        score: p.score,
        n: p.n,
        graded: p.graded,
        at_turn: p.atTurn,
        avg_3m: hz('3M')?.avg ?? null,
        avg_6m: hz('6M')?.avg ?? null,
        avg_12m: hz('12M')?.avg ?? null,
        win_3m: hz('3M')?.winRate ?? null,
        win_6m: hz('6M')?.winRate ?? null,
        win_12m: hz('12M')?.winRate ?? null,
        tickers: results.length,
        as_of: asOf,
        updated_at: new Date().toISOString(),
      })
    }
  }
  return out
}

async function rankConfluence(
  db: ReturnType<typeof createClient>,
  mode: 'full' | 'rank-only' | 'dry-run',
) {
  console.log(`[rank-confluence] Starting in ${mode} mode`)
  const t0 = Date.now()

  const universe = DEFAULT_UNIVERSE
  const failed: string[] = []
  let done = 0
  const results: AnalysisResult[] = []

  for (const ticker of universe) {
    try {
      const bars = await yahooBars(ticker, '5y')
      const result = analyze(ticker, bars)
      if (result) results.push(result)
    } catch (e) {
      failed.push(`${ticker}: ${(e as Error).message}`)
    } finally {
      done++
      if (done % 10 === 0) console.log(`  ${done}/${universe.length} · ${failed.length} failed · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
  }

  if (!results.length) throw new Error(`no tickers analyzed (${failed.slice(0, 5).join('; ')})`)

  const asOf = results.map((r) => r.asOf).sort().pop()!
  const pools = Object.fromEntries(SIDES.map((side) => [side, poolStats(results.map((r) => r[side].setups), HORIZONS, side)]))
  const rows = rankAll(results, pools)
  const pool = poolRows(pools, results, asOf)

  console.log(`Analyzed ${results.length}/${universe.length} tickers in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${failed.length} failed; as of ${asOf}`)
  if (failed.length) console.log('Failed (first 10):', failed.slice(0, 10).join(' | '))

  for (const side of SIDES) {
    const top = rows.filter((r) => r.side === side && r.rank != null).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)).slice(0, TOP)
    console.log(`\nTop ${TOP} ${side}:`)
    for (const r of top) {
      const pct = (x: number | null) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)
      console.log(`  ${String(r.rank).padStart(2)}. ${r.ticker.padEnd(6)} ${r.score}/5 ${(r.combo || '').padEnd(28)} 3M ${pct(r.est_3m)} 6M ${pct(r.est_6m)}  at turn ${pct(r.est_at_turn)}  (own ${r.own_n}, pool ${r.pool_n})`)
    }
  }

  if (mode === 'dry-run') return { status: 'dry-run complete', analyzed: results.length, failed: failed.length }

  for (let k = 0; k < rows.length; k += 500) {
    const { error } = await db.from('confluence_ranks').upsert(
      rows.slice(k, k + 500).map((r) => ({ ...r, updated_at: new Date().toISOString() })),
      { onConflict: 'side,ticker' },
    )
    if (error) throw new Error(`confluence_ranks: ${error.message}`)
  }

  for (let k = 0; k < pool.length; k += 500) {
    const { error } = await db.from('confluence_pool').upsert(pool.slice(k, k + 500), { onConflict: 'side,combo' })
    if (error) throw new Error(`confluence_pool: ${error.message}`)
  }
  console.log(`Wrote ${rows.length} rank rows and ${pool.length} pool rows.`)

  if (mode !== 'full') return { status: 'rank-only complete', analyzed: results.length, rows_written: rows.length }

  const { data: prevRows } = await db.from('confluence_ranks').select('side, ticker, rank').not('rank', 'is', null).lte('rank', TOP)
  const prevTop = new Set((prevRows ?? []).map((r: any) => `${r.side}:${r.ticker}`))

  const entered = rows.filter((r) => r.rank != null && r.rank <= TOP && !prevTop.has(`${r.side}:${r.ticker}`))
  if (!entered.length) {
    console.log('No new top-10 entries.')
    return { status: 'full complete', analyzed: results.length, alerts_sent: 0 }
  }

  const { data: users } = await db.from('profiles').select('id').eq('entry_alerts', true)
  const ids = (users ?? []).map((u: any) => u.id)
  if (!ids.length) return { status: 'full complete', analyzed: results.length, alerts_sent: 0 }

  const [{ data: wl }, { data: pos }] = await Promise.all([
    db.from('watchlist').select('user_id, ticker').in('user_id', ids),
    db.from('leaps_positions').select('user_id, ticker').in('user_id', ids).is('closed_at', null).not('ticker', 'is', null),
  ])

  const follows = new Map<string, Set<string>>()
  const holds = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, u: string, t: string | null) => {
    const s = String(t ?? '').toUpperCase()
    if (!m.has(u)) m.set(u, new Set())
    m.get(u)!.add(s)
  }

  for (const r of wl ?? []) add(follows, r.user_id, r.ticker)
  for (const r of pos ?? []) {
    add(follows, r.user_id, r.ticker)
    add(holds, r.user_id, r.ticker)
  }

  let written = 0
  const mail = new Map<string, Array<{ message: string; url: string }>>()

  for (const id of ids) {
    for (const r of entered) {
      const mine = r.side === 'buy' ? follows.get(id)?.has(r.ticker) : holds.get(id)?.has(r.ticker)
      if (!mine) continue

      const kind = r.side === 'buy' ? 'confluence_top_buy' : 'confluence_top_sell'
      const pct = (x: number | null) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)
      const message = r.side === 'buy'
        ? `${r.ticker} is #${r.rank} for lows (buy) — ${r.score} of 5 signals agree; this setup averaged ${pct(r.est_6m)} over 6 months.`
        : `${r.ticker} is #${r.rank} for extended highs (exit) — ${r.score} of 5 sell signals agree; after this setup the stock averaged ${pct(r.est_3m)} over 3 months.`

      const { data, error } = await db.from('alerts').upsert(
        { user_id: id, alert_type: kind, ticker: r.ticker, event_date: r.as_of, message, sent_via: 'email' },
        { onConflict: 'user_id,alert_type,ticker,event_date', ignoreDuplicates: true },
      ).select('id')

      if (error) {
        console.warn('alert insert failed', error.message)
        continue
      }
      if (!data?.length) continue

      written++
      if (!mail.has(id)) mail.set(id, [])
      mail.get(id)!.push({ message, url: `${APP_URL}/charts/entry/${encodeURIComponent(r.ticker)}` })
    }
  }

  console.log(`Alerts written: ${written} for ${mail.size} user(s).`)

  if (RESEND_API_KEY) {
    for (const [id, items] of mail) {
      const { data } = await db.auth.admin.getUserById(id)
      const to = data?.user?.email
      if (!to) continue

      const html = `<p>New confluence calls on your tickers:</p><ul>${items.map((x) => `<li>${x.message} <a href="${x.url}">Open the chart</a></li>`).join('')}</ul><p style="color:#888">Suggestions, not advice. Stock returns, not option returns.</p>`
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM,
          to,
          subject: `Cash Moves: ${items.length} new confluence call${items.length === 1 ? '' : 's'}`,
          html,
        }),
      })
      if (!resp.ok) console.warn('resend failed', resp.status)
    }
  } else {
    console.log(`Resend not configured — ${mail.size} email(s) skipped (placeholder).`)
  }

  return { status: 'full complete', analyzed: results.length, alerts_sent: written }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const mode = String(body.mode ?? 'dry-run')
  if (!['full', 'rank-only', 'dry-run'].includes(mode)) {
    return json({ success: false, error: 'mode must be full, rank-only, or dry-run' }, 400)
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  try {
    const result = await rankConfluence(db, mode as 'full' | 'rank-only' | 'dry-run')
    return json({ success: true, mode, result })
  } catch (err) {
    console.error('Ranking error:', err)
    return json(
      { success: false, error: err instanceof Error ? err.message : 'unknown error' },
      500,
    )
  }
})
