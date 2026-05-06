// Cash Moves — monitor-positions edge function.
//
// Iterates every public.open_positions row with status='open', fetches
// the current spread mid, computes P&L %, fires alerts when thresholds
// hit (Cash Moves rules: -50% stop, +50/+100/+200 profit ladder, DTE
// < 21, expiring tomorrow). Idempotent on triggers_fired so we never
// double-alert.
//
// Called by the monitor-positions GHA cron every 5 min during US RTH.
//
// Auth model: this is a service-role-only function (cron calls it with
// the service role JWT). Refuses anything else.
//
// Price source order:
//   1. Tastytrade /market-data/by-type?equity-option=long_occ,short_occ
//      (production REST endpoint usually returns 502 — same gotcha as
//      compute-gex — but cheap to try)
//   2. Yahoo /v7/finance/options/{ticker}?date=<expiry-unix> filtered to
//      our two strikes (15-min delayed but reliable)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const APP_URL = Deno.env.get('APP_URL') || 'https://pharma-edge.vercel.app'

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

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
let yahooCachedAuth: { cookie: string; crumb: string; expiresAt: number } | null = null

async function getYahooAuth(): Promise<{ cookie: string; crumb: string }> {
  const now = Date.now()
  if (yahooCachedAuth && yahooCachedAuth.expiresAt > now) {
    return { cookie: yahooCachedAuth.cookie, crumb: yahooCachedAuth.crumb }
  }
  const cookieResp = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA, 'Accept': '*/*' },
    redirect: 'manual',
  })
  await cookieResp.body?.cancel().catch(() => {})
  type HeadersWithSet = Headers & { getSetCookie?: () => string[] }
  const headers = cookieResp.headers as HeadersWithSet
  let setCookies: string[] = []
  if (typeof headers.getSetCookie === 'function') setCookies = headers.getSetCookie()
  if (setCookies.length === 0) {
    const raw = cookieResp.headers.get('set-cookie')
    if (raw) setCookies = raw.split(/,(?=\s*[A-Za-z][A-Za-z0-9_-]*=)/)
  }
  const parts = setCookies.map((c) => c.split(';')[0].trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('yahoo: no session cookies')
  const cookie = parts.join('; ')
  const crumbResp = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': '*/*' },
  })
  if (!crumbResp.ok) throw new Error(`yahoo crumb: ${crumbResp.status}`)
  const crumb = (await crumbResp.text()).trim()
  if (!crumb || crumb.length > 64 || crumb.includes('<')) {
    throw new Error('yahoo crumb: invalid')
  }
  yahooCachedAuth = { cookie, crumb, expiresAt: now + 30 * 60 * 1000 }
  return { cookie, crumb }
}

interface YahooContract {
  contractSymbol: string
  strike: number
  lastPrice: number | undefined
  bid: number | undefined
  ask: number | undefined
}

async function fetchYahooSpreadMid(
  ticker: string,
  expiration: string,
  longStrike: number,
  shortStrike: number,
  optionType: 'C' | 'P',
): Promise<{ mid: number | null; source: string; error?: string }> {
  try {
    const expUnix = Math.floor(new Date(expiration + 'T00:00:00Z').getTime() / 1000)
    const { cookie, crumb } = await getYahooAuth()
    const params = new URLSearchParams({ crumb, date: String(expUnix) })
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?${params}`,
      { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Cookie': cookie } },
    )
    if (!resp.ok) {
      if (resp.status === 401) yahooCachedAuth = null
      return { mid: null, source: 'yahoo', error: `yahoo status ${resp.status}` }
    }
    const body = await resp.json()
    const result = body?.optionChain?.result?.[0]?.options?.[0]
    if (!result) return { mid: null, source: 'yahoo', error: 'no options block' }
    const list: YahooContract[] = optionType === 'C' ? (result.calls ?? []) : (result.puts ?? [])
    const long = list.find((c) => Math.abs(Number(c.strike) - longStrike) < 0.001)
    const short = list.find((c) => Math.abs(Number(c.strike) - shortStrike) < 0.001)
    if (!long || !short) {
      return { mid: null, source: 'yahoo', error: 'strikes not found in chain' }
    }
    const mid = (priceOf(long) ?? 0) - (priceOf(short) ?? 0)
    return { mid, source: 'yahoo' }
  } catch (e) {
    return { mid: null, source: 'yahoo', error: e instanceof Error ? e.message : 'yahoo threw' }
  }
}

function priceOf(c: YahooContract): number | null {
  const last = Number(c.lastPrice)
  const bid = Number(c.bid)
  const ask = Number(c.ask)
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    return (bid + ask) / 2
  }
  if (Number.isFinite(last) && last > 0) return last
  return null
}

interface Position {
  id: string
  user_id: string
  signal_id: string | null
  ticker: string
  strategy_type: string
  long_strike: number
  short_strike: number
  expiration: string
  contracts: number
  entry_debit_per_spread: number
  triggers_fired: Record<string, string>
  thesis: string | null
}

function isCallSpread(strategy: string): boolean {
  return strategy === 'BULL_CALL' || strategy === 'BEAR_CALL_CREDIT'
}

function daysUntil(date: string): number {
  const d = new Date(date + 'T00:00:00Z').getTime()
  return Math.ceil((d - Date.now()) / 86_400_000)
}

interface TriggerCheck {
  type: string
  fired: boolean
  message: string
}

function evaluateTriggers(
  pos: Position,
  pnlPct: number | null,
  dte: number,
): TriggerCheck[] {
  const fired = pos.triggers_fired || {}
  const out: TriggerCheck[] = []

  // Profit ladder + stop loss only fire when we have a current P&L
  if (pnlPct != null) {
    if (pnlPct <= -50 && !fired.position_stop_loss) {
      out.push({
        type: 'position_stop_loss',
        fired: true,
        message: `${pos.ticker} ${pos.strategy_type} hit −50% stop loss (${pnlPct.toFixed(0)}%)`,
      })
    }
    if (pnlPct >= 50 && !fired.position_profit_50) {
      out.push({
        type: 'position_profit_50',
        fired: true,
        message: `${pos.ticker} ${pos.strategy_type} at +50% — sell 50% per Cash Moves rules`,
      })
    }
    if (pnlPct >= 100 && !fired.position_profit_100) {
      out.push({
        type: 'position_profit_100',
        fired: true,
        message: `${pos.ticker} ${pos.strategy_type} at +100% — sell 50% to lock in`,
      })
    }
    if (pnlPct >= 200 && !fired.position_profit_200) {
      out.push({
        type: 'position_profit_200',
        fired: true,
        message: `${pos.ticker} ${pos.strategy_type} at +200% — sell 75% per profit ladder`,
      })
    }
  }

  if (dte <= 21 && dte > 1 && !fired.position_dte_21) {
    out.push({
      type: 'position_dte_21',
      fired: true,
      message: `${pos.ticker} ${pos.strategy_type} now ${dte} DTE — review per 21-DTE rule`,
    })
  }
  if (dte <= 1 && !fired.position_expiring_tomorrow) {
    out.push({
      type: 'position_expiring_tomorrow',
      fired: true,
      message: `${pos.ticker} ${pos.strategy_type} expires ${dte === 0 ? 'today' : 'tomorrow'} — close before expiry`,
    })
  }

  return out
}

async function fireAlert(
  supabase: ReturnType<typeof createClient>,
  pos: Position,
  trigger: TriggerCheck,
  pnlPct: number | null,
): Promise<void> {
  // Insert alert row first (idempotent against unique constraint if any)
  const alertRow = {
    user_id: pos.user_id,
    alert_type: trigger.type,
    payload: {
      position_id: pos.id,
      ticker: pos.ticker,
      strategy: pos.strategy_type,
      long_strike: pos.long_strike,
      short_strike: pos.short_strike,
      expiration: pos.expiration,
      contracts: pos.contracts,
      entry_debit: pos.entry_debit_per_spread,
      pnl_pct: pnlPct,
      message: trigger.message,
      url: `${APP_URL}/position/${pos.id}`,
    },
    sent_at: new Date().toISOString(),
  }
  const { error: alertErr } = await supabase.from('alerts').insert(alertRow)
  if (alertErr) {
    console.error('[monitor] alerts insert failed', alertErr)
    // continue anyway — push/email still useful
  }

  // Fan out via send-alerts (which handles email + web push)
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/send-alerts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: pos.user_id,
        alert_type: trigger.type,
        payload: alertRow.payload,
      }),
    })
  } catch (e) {
    console.error('[monitor] send-alerts call failed', e)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'misconfigured' }, 500)
  }

  // Service-role-only: only the cron should call this. We check that
  // the JWT's role claim is service_role.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const token = authHeader.slice('Bearer '.length)
  let role: string | undefined
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    role = payload?.role
  } catch { /* fall through */ }
  if (role !== 'service_role') return json({ success: false, error: 'service role required' }, 403)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Pull every open position. At realistic scale (one user, dozens of
  // positions max) this is fine; if it grows we'd page or filter by
  // last_polled_at older than 4 min.
  const { data: rows, error } = await supabase
    .from('open_positions')
    .select(
      'id, user_id, signal_id, ticker, strategy_type, long_strike, short_strike, expiration, contracts, entry_debit_per_spread, triggers_fired, thesis',
    )
    .eq('status', 'open')
  if (error) return json({ success: false, error: error.message }, 500)

  const positions = (rows ?? []) as Position[]
  let pollSucceeded = 0
  let pollFailed = 0
  let triggersFired = 0

  for (const pos of positions) {
    const optionType: 'C' | 'P' = isCallSpread(pos.strategy_type) ? 'C' : 'P'
    const dte = daysUntil(pos.expiration)

    // Auto-expire if DTE < 0 — option has settled, mark closed.
    if (dte < 0) {
      await supabase
        .from('open_positions')
        .update({
          status: 'expired',
          closed_at: new Date().toISOString(),
          last_polled_at: new Date().toISOString(),
        })
        .eq('id', pos.id)
      continue
    }

    // Fetch current spread mid. Yahoo only for now (Tastytrade REST is
    // broken on prod — see CLAUDE.md). 15-min delayed is acceptable
    // for stop-loss and profit-take alerts.
    const { mid, source, error: fetchErr } = await fetchYahooSpreadMid(
      pos.ticker,
      pos.expiration,
      pos.long_strike,
      pos.short_strike,
      optionType,
    )

    if (mid == null) {
      pollFailed++
      console.warn(`[monitor] ${pos.ticker} ${pos.long_strike}/${pos.short_strike}: ${fetchErr}`)
      // still touch last_polled_at so we know we tried
      await supabase
        .from('open_positions')
        .update({ last_polled_at: new Date().toISOString(), last_poll_source: source })
        .eq('id', pos.id)
      continue
    }
    pollSucceeded++

    const pnlPct = pos.entry_debit_per_spread > 0
      ? ((mid - pos.entry_debit_per_spread) / pos.entry_debit_per_spread) * 100
      : null

    // Evaluate triggers
    const triggers = evaluateTriggers(pos, pnlPct, dte)
    if (triggers.length > 0) {
      const newFired = { ...pos.triggers_fired }
      for (const t of triggers) {
        newFired[t.type] = new Date().toISOString()
        await fireAlert(supabase, pos, t, pnlPct)
        triggersFired++
      }
      await supabase
        .from('open_positions')
        .update({
          last_mid_per_spread: mid,
          last_pnl_pct: pnlPct,
          last_polled_at: new Date().toISOString(),
          last_poll_source: source,
          triggers_fired: newFired,
        })
        .eq('id', pos.id)
    } else {
      await supabase
        .from('open_positions')
        .update({
          last_mid_per_spread: mid,
          last_pnl_pct: pnlPct,
          last_polled_at: new Date().toISOString(),
          last_poll_source: source,
        })
        .eq('id', pos.id)
    }
  }

  return json({
    success: true,
    polled: positions.length,
    pollSucceeded,
    pollFailed,
    triggersFired,
  })
})
