// entry-scan — daily entry alerts (owner, 2026-10-03: "ensure the next
// entry"). Service-role only; called by .github/workflows/entry-scan.yml
// after the US close on weekdays.
//
// For every user with profiles.entry_alerts on, the tickers they follow —
// their watchlist (Tracking) plus open share / option holdings — are checked
// once per ticker (shared across users):
//   entry_buy_zone        the LEAPS buy zone is YES on the latest daily bar,
//                         with the default thresholds (users' adjusted
//                         thresholds live on their devices only). One alert
//                         per buy-zone cluster: event_date = the cluster's
//                         first day, and the cluster must have started in the
//                         last 3 trading days (a missed run still alerts).
//   entry_hardening_bull  a weekly Hardening bull in the last two completed
//                         weeks (the current week counts once it has closed,
//                         i.e. when the latest daily bar is a Friday).
//                         event_date = that week's start.
// Each alert is written to public.alerts (the in-app bell) and pushed to the
// user's devices. The unique index alerts_entry_once makes every
// (user, kind, ticker, event_date) fire once, so re-runs are safe.
//
// The math is the browser's: _shared/entryEvents.js, indicators.js and
// signalSuite.js are generated copies of src/utils/ (npm run
// indicators:sync); entryEvents decides what to alert.
//
// POST {}                       scan everyone
// POST { dry_run: true }        compute and report, write / push nothing
// POST { tickers: ["XLK"] }     limit to these tickers (testing)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'
import { yahooChart, type Bar } from '../_shared/yahoo.ts'
import { entryEvents } from '../_shared/entryEvents.js'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:noreply@example.com'
const MAX_TICKERS = 80
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
function claimsOf(token: string): Record<string, unknown> | null {
  try {
    const p = token.split('.')[1]
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
  } catch {
    return null
  }
}

let vapidReady = false
function vapid(): boolean {
  if (vapidReady) return true
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  vapidReady = true
  return true
}

// deno-lint-ignore no-explicit-any
async function push(db: any, userId: string, payload: { title: string; body: string; url: string; type: string }) {
  if (!vapid()) return { sent: 0 }
  const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId)
  let sent = 0
  for (const sub of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 60 * 60 * 24 })
      sent++
      await db.from('push_subscriptions').update({ last_used_at: new Date().toISOString() }).eq('id', sub.id)
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode
      if (status === 404 || status === 410) await db.from('push_subscriptions').delete().eq('id', sub.id)
      else console.warn('push failed', status)
    }
  }
  return { sent }
}

type Entry = { kind: 'entry_buy_zone' | 'entry_hardening_bull'; ticker: string; event_date: string; message: string; title: string }

// The ticker's entries today (empty when none): fetch, then the shared math.
async function entriesFor(ticker: string, spyW: Array<{ t: string; c: number }>, vixW: Array<{ t: string; c: number }>): Promise<Entry[]> {
  const symbol = ticker.replace(/\./g, '-')
  const [daily, weekly] = await Promise.all([
    yahooChart(symbol, '5y', '1d').then((r) => r.bars as Bar[]),
    yahooChart(symbol, 'max', '1wk').then((r) => r.bars as Bar[]),
  ])
  // deno-lint-ignore no-explicit-any
  return (entryEvents as any)({ ticker, daily, weekly, spyWeekly: spyW, vixWeekly: vixW }) as Entry[]
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ success: false, error: 'edge function misconfigured' }, 500)
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ') || claimsOf(auth.slice(7))?.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body */ }
  const dryRun = body.dry_run === true
  const only = Array.isArray(body.tickers) ? new Set((body.tickers as unknown[]).map((x) => String(x).toUpperCase())) : null

  const db = createClient(SUPABASE_URL, SERVICE_KEY)
  const { data: users } = await db.from('profiles').select('id').eq('entry_alerts', true)
  const userIds = (users ?? []).map((u: { id: string }) => u.id)
  if (!userIds.length) return json({ success: true, users: 0, tickers: 0, alerts: 0 })

  // ticker → users who follow it (Tracking + open share / option holdings).
  const follows = new Map<string, Set<string>>()
  const add = (t: string | null, u: string) => {
    const k = String(t ?? '').trim().toUpperCase()
    if (!TICKER_RE.test(k) || (only && !only.has(k))) return
    if (!follows.has(k)) follows.set(k, new Set())
    follows.get(k)!.add(u)
  }
  const [{ data: wl }, { data: pos }] = await Promise.all([
    db.from('watchlist').select('user_id, ticker').in('user_id', userIds),
    db.from('leaps_positions').select('user_id, ticker, instrument_type').in('user_id', userIds).is('closed_at', null)
      .in('instrument_type', ['stock', 'equity_option']),
  ])
  for (const r of wl ?? []) add(r.ticker, r.user_id)
  for (const r of pos ?? []) add(r.ticker, r.user_id)
  const tickers = [...follows.keys()].sort().slice(0, MAX_TICKERS)

  const [spyW, vixW] = await Promise.all(['SPY', '^VIX'].map(async (sym) => {
    try { return (await yahooChart(sym, 'max', '1wk')).bars.map((b) => ({ t: String(b.t), c: b.c })) } catch { return [] }
  }))

  const report: Array<Record<string, unknown>> = []
  let written = 0
  let pushed = 0
  // Yahoo fetches in parallel batches (edge functions have a wall-clock limit).
  const found: Array<{ ticker: string; entries: Entry[] }> = []
  for (let k = 0; k < tickers.length; k += 6) {
    const batch = tickers.slice(k, k + 6)
    const res = await Promise.all(batch.map((ticker) => entriesFor(ticker, spyW, vixW)
      .then((entries) => ({ ticker, entries }))
      .catch((e) => { report.push({ ticker, error: (e as Error).message }); return { ticker, entries: [] as Entry[] } })))
    found.push(...res)
  }
  for (const { ticker, entries } of found) {
    for (const e of entries) {
      report.push({ ticker, kind: e.kind, event_date: e.event_date, users: follows.get(ticker)!.size })
      if (dryRun) continue
      for (const userId of follows.get(ticker)!) {
        // Insert once; a duplicate (user, kind, ticker, event_date) is skipped.
        const { data: row, error } = await db.from('alerts').upsert({
          user_id: userId, alert_type: e.kind, message: e.message, ticker: e.ticker, event_date: e.event_date, sent_via: 'push',
        }, { onConflict: 'user_id,alert_type,ticker,event_date', ignoreDuplicates: true }).select('id')
        if (error) { console.warn('alert insert failed', error.message); continue }
        if (!row?.length) continue // already alerted
        written++
        const r = await push(db, userId, { title: e.title, body: e.message, url: `/charts/entry/${encodeURIComponent(ticker)}`, type: e.kind })
        pushed += r.sent
      }
    }
  }
  return json({ success: true, dry_run: dryRun, users: userIds.length, tickers: tickers.length, entries: report, alerts: written, pushes: pushed })
})
