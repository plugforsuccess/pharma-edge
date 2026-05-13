// Bot daily report — runs at 4:15 PM ET, emails today's recap.
//
// One row per user-day in bot_runs. Reads recent trades + current
// open positions + kill-switch state, emails a plain-text summary
// to the user via Resend.
//
// Built thin in PR #1 — emits the email skeleton with current
// schema fields. PR #4 (the actual bot entry/exit logic) will be
// what populates trades_attempted, daily_pnl, etc. Until then this
// reports the bot's state honestly: "paused, no activity today" if
// the bot isn't running.
//
// Invoked by .github/workflows/bot-daily-report.yml at 20:15 UTC
// (4:15 PM ET DST) and 21:15 UTC (4:15 PM ET standard). The edge
// function double-checks the time-of-day and skips if it's
// firing outside the expected window.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const FROM_ADDRESS = Deno.env.get('RESEND_FROM') || 'onboarding@resend.dev'
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

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split('.')
    if (!payload) return null
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    return JSON.parse(atob(padded))
  } catch {
    return null
  }
}

interface BotConfig {
  enabled?: boolean
  mode?: 'paper' | 'live'
}

interface ProfileRow {
  id: string
  email: string | null
  bot_config: BotConfig | null
  bot_paused_until: string | null
  bot_paused_reason: string | null
}

interface BotRunRow {
  mode: string
  reason: string | null
  trades_attempted: number
  trades_filled: number
  wins_count: number
  losses_count: number
  daily_pnl: number
  kill_switch_state: string
  kill_switch_fired_at: string | null
  kill_switch_reason: string | null
}

function todayNyDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function formatPct(pnl: number, nlv: number): string {
  if (!nlv) return '—'
  const pct = (pnl / nlv) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

function formatDollars(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : '−'
  return `${sign}$${Math.abs(n).toFixed(2)}`
}

function buildReportBody(
  profile: ProfileRow,
  run: BotRunRow | null,
  openPositions: Array<{ ticker: string; strategy_type: string; long_strike: number; short_strike: number; expiration: string; contracts_remaining: number; last_pnl_pct: number | null }>,
  startingNlv: number,
): string {
  const lines: string[] = []
  lines.push('Cash Moves — Bot daily report')
  lines.push(`Date: ${todayNyDate()} (US Eastern)`)
  lines.push('')

  // ── Mode summary ─────────────────────────────────────────────
  const mode = profile.bot_config?.mode ?? 'paper'
  const enabled = profile.bot_config?.enabled ?? false
  if (profile.bot_paused_until) {
    const pausedUntil = new Date(profile.bot_paused_until)
    if (pausedUntil.getTime() > Date.now()) {
      lines.push(`STATUS: HALTED`)
      lines.push(`Reason: ${profile.bot_paused_reason ?? 'unknown'}`)
      lines.push(`Until:  ${profile.bot_paused_until}`)
      lines.push('')
      lines.push('Flip profiles.bot_paused_until to NULL in Settings to resume.')
      return lines.join('\n')
    }
  }
  if (!enabled) {
    lines.push('STATUS: Disabled (Bot not enabled in Settings)')
    lines.push('')
    lines.push('No bot activity today.')
    return lines.join('\n')
  }
  lines.push(`MODE:   ${mode.toUpperCase()}`)
  lines.push('')

  // ── Today's activity ─────────────────────────────────────────
  lines.push('TODAY')
  lines.push('──────')
  if (!run) {
    lines.push('No activity logged.')
  } else {
    lines.push(`Trades attempted: ${run.trades_attempted}`)
    lines.push(`Trades filled:    ${run.trades_filled}`)
    lines.push(`Wins / Losses:    ${run.wins_count} / ${run.losses_count}`)
    lines.push(`Realized P&L:     ${formatDollars(run.daily_pnl)} (${formatPct(run.daily_pnl, startingNlv)} of NLV)`)
    lines.push(`Kill switch:      ${run.kill_switch_state}`)
    if (run.kill_switch_fired_at) {
      lines.push(`  Fired at: ${run.kill_switch_fired_at}`)
      lines.push(`  Reason:   ${run.kill_switch_reason ?? '—'}`)
    }
  }
  lines.push('')

  // ── Open positions ───────────────────────────────────────────
  lines.push(`OPEN POSITIONS (${openPositions.length})`)
  lines.push('─────────────────')
  if (openPositions.length === 0) {
    lines.push('None.')
  } else {
    for (const p of openPositions) {
      const strikes =
        Number.isFinite(p.long_strike) && Number.isFinite(p.short_strike)
          ? `${p.long_strike}/${p.short_strike}`
          : ''
      const pnl = p.last_pnl_pct != null ? `${p.last_pnl_pct >= 0 ? '+' : ''}${Number(p.last_pnl_pct).toFixed(0)}%` : '—'
      lines.push(
        `  ${p.ticker} · ${p.strategy_type.replace(/_/g, ' ')} ${strikes} · exp ${p.expiration} · ${p.contracts_remaining}c · ${pnl}`,
      )
    }
  }
  lines.push('')
  lines.push('Open positions auto-manage via the existing exit-rule engine.')
  lines.push('Profit targets, stops, and time-stops fire without further input.')
  lines.push('')
  lines.push(`Tomorrow's intended mode: ${mode.toUpperCase()} (unless paused)`)
  lines.push('')
  lines.push(`Halt the bot anytime: ${APP_URL}/admin (kill switch)`)

  return lines.join('\n')
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  // Service-role only.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  const claims = decodeJwtPayload(authHeader.slice('Bearer '.length))
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const today = todayNyDate()

  // Find every user with the bot ever configured (whether enabled or
  // not — we still want to send "bot paused, no activity" reports so
  // the user knows the system is in fact off).
  const { data: profiles, error: profilesErr } = await supabase
    .from('profiles')
    .select('id, email, bot_config, bot_paused_until, bot_paused_reason')
    .not('bot_config', 'is', null)
  if (profilesErr) {
    return json({ success: false, error: `profiles fetch: ${profilesErr.message}` }, 502)
  }

  const summary = {
    eligible_users: 0,
    emails_sent: 0,
    emails_skipped: 0,
    emails_failed: 0,
  }

  for (const profile of (profiles ?? []) as ProfileRow[]) {
    const enabled = profile.bot_config?.enabled ?? false
    if (!enabled && !profile.bot_paused_until) {
      // Bot never enabled — no report.
      summary.emails_skipped++
      continue
    }
    if (!profile.email) {
      summary.emails_skipped++
      continue
    }
    summary.eligible_users++

    const { data: runRow } = await supabase
      .from('bot_runs')
      .select('mode, reason, trades_attempted, trades_filled, wins_count, losses_count, daily_pnl, kill_switch_state, kill_switch_fired_at, kill_switch_reason, starting_nlv')
      .eq('user_id', profile.id)
      .eq('run_date', today)
      .maybeSingle()

    const { data: openPositions } = await supabase
      .from('open_positions')
      .select('ticker, strategy_type, long_strike, short_strike, expiration, contracts_remaining, last_pnl_pct')
      .eq('user_id', profile.id)
      .eq('status', 'open')

    const startingNlv = Number(runRow?.starting_nlv) || 0
    const body = buildReportBody(profile, runRow ?? null, openPositions ?? [], startingNlv)

    if (!RESEND_API_KEY) {
      summary.emails_skipped++
      console.warn('[daily-report] RESEND_API_KEY not set; would have emailed:', profile.email)
      continue
    }

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: profile.email,
        subject: `[Cash Moves Bot] Daily report — ${today}`,
        text: body,
      }),
    })
    if (resendResp.ok) {
      summary.emails_sent++
    } else {
      summary.emails_failed++
      const detail = await resendResp.text().catch(() => '')
      console.warn('[daily-report] resend failed', resendResp.status, detail.slice(0, 200))
    }
  }

  return json({ success: true, summary })
})
