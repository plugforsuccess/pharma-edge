// Pharma Edge — send-alerts edge function.
//
// Service-role-only endpoint. Called by send-catalyst-alerts.yml (cron) to
// fan out catalyst-approaching reminders and post-catalyst outcome
// reminders. Daily digest stays in scraper/main.py (Week 5).
//
// Each invocation: send the email via Resend, fan out web-push to every
// active push_subscriptions row for the user, then log the alert.
// Push failures don't fail the request; 404/410 subs are deleted.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const APP_URL = Deno.env.get('APP_URL') || 'https://APP_URL_NOT_SET.example'
const FROM_ADDRESS = Deno.env.get('RESEND_FROM') || 'onboarding@resend.dev'
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:noreply@example.com'

const ALLOWED_TYPES = new Set([
  'catalyst_approaching_14d',
  'catalyst_approaching_7d',
  'catalyst_tomorrow',
  'outcome_reminder',
  // Position monitoring alerts (fired by monitor-positions cron).
  // Each fires once per (position_id, alert_type) — idempotency is
  // enforced upstream in monitor-positions via the triggers_fired
  // JSONB column on open_positions.
  'position_stop_loss',
  'position_profit_50',
  'position_profit_100',
  'position_profit_200',
  'position_dte_21',
  'position_expiring_tomorrow',
  'position_filled',
  'position_closed',
])

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

let vapidConfigured = false
function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  vapidConfigured = true
  return true
}

async function fanOutPush(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  payload: { title: string; body: string; url: string; type: string },
): Promise<{ sent: number; pruned: number; errors: number }> {
  if (!ensureVapidConfigured()) {
    return { sent: 0, pruned: 0, errors: 0 }
  }
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId)

  let sent = 0
  let pruned = 0
  let errors = 0

  for (const sub of subs ?? []) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24 },
      )
      sent += 1
      await supabase
        .from('push_subscriptions')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', sub.id)
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode
      if (status === 404 || status === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id)
        pruned += 1
      } else {
        console.warn('push send failed', status, (err as Error).message)
        errors += 1
      }
    }
  }
  return { sent, pruned, errors }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!RESEND_API_KEY) return json({ success: false, error: 'RESEND_API_KEY not set' }, 500)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  // Service-role-only.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  const token = authHeader.slice('Bearer '.length)
  const claims = decodeJwtPayload(token)
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const alertType = String(body.alert_type ?? '')
  const userId = body.user_id ? String(body.user_id) : null
  const signalId = body.signal_id ? String(body.signal_id) : null

  if (!ALLOWED_TYPES.has(alertType)) {
    return json({ success: false, error: `unsupported alert_type: ${alertType}` }, 400)
  }
  // Two flavours of alert:
  //   - catalyst_* / outcome_reminder → require signal_id, look up signals
  //   - position_*                    → require payload.position_id; we
  //                                     read everything we need straight
  //                                     from the alerts payload (cheaper,
  //                                     and positions can be sourceless)
  const isPositionAlert = alertType.startsWith('position_')
  if (!userId) {
    return json({ success: false, error: 'user_id required' }, 400)
  }
  if (!isPositionAlert && !signalId) {
    return json({ success: false, error: 'signal_id required for catalyst alerts' }, 400)
  }
  const positionPayload = (body.payload ?? {}) as Record<string, unknown>
  if (isPositionAlert && !positionPayload.position_id) {
    return json({ success: false, error: 'payload.position_id required for position alerts' }, 400)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('email, display_name')
    .eq('id', userId)
    .maybeSingle()
  if (profileError || !profile?.email) {
    return json({ success: false, error: 'profile or email not found' }, 404)
  }

  let subject = ''
  let htmlBody = ''
  let pushBody = ''
  let clickUrl = ''

  if (isPositionAlert) {
    const ticker = String(positionPayload.ticker ?? '???')
    const strategy = String(positionPayload.strategy ?? 'spread')
    const longK = positionPayload.long_strike
    const shortK = positionPayload.short_strike
    const pnl = typeof positionPayload.pnl_pct === 'number' ? positionPayload.pnl_pct : null
    const pnlStr = pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}%` : '—'
    const positionId = String(positionPayload.position_id)
    clickUrl = `${APP_URL}/position/${positionId}`

    switch (alertType) {
      case 'position_stop_loss':
        subject = `🛑 ${ticker} stop loss hit — ${pnlStr}`
        pushBody = `${ticker} ${strategy} at ${pnlStr} — exit per the −50% rule.`
        htmlBody = positionAlertHtml(ticker, strategy, longK, shortK, pnlStr,
          'Stop loss triggered', 'Exit immediately per Wiley Edge rules.', clickUrl)
        break
      case 'position_profit_50':
        subject = `${ticker} +50% — sell half`
        pushBody = `${ticker} ${strategy} at +50%. Take partial off per profit ladder.`
        htmlBody = positionAlertHtml(ticker, strategy, longK, shortK, pnlStr,
          'Profit ladder: +50%', 'Sell 50% to lock in.', clickUrl)
        break
      case 'position_profit_100':
        subject = `${ticker} +100% — sell half`
        pushBody = `${ticker} ${strategy} at +100%. Sell 50% to lock in.`
        htmlBody = positionAlertHtml(ticker, strategy, longK, shortK, pnlStr,
          'Profit ladder: +100%', 'Sell 50% to lock in.', clickUrl)
        break
      case 'position_profit_200':
        subject = `${ticker} +200% — sell 75%`
        pushBody = `${ticker} ${strategy} at +200%. Sell 75% per Wiley Edge ladder.`
        htmlBody = positionAlertHtml(ticker, strategy, longK, shortK, pnlStr,
          'Profit ladder: +200%', 'Sell 75% per profit ladder.', clickUrl)
        break
      case 'position_dte_21':
        subject = `${ticker} now 21 DTE — review`
        pushBody = `${ticker} ${strategy} at 21 DTE. Review per the entry rule.`
        htmlBody = positionAlertHtml(ticker, strategy, longK, shortK, pnlStr,
          '21 DTE crossed', 'Review the position. Theta acceleration zone.', clickUrl)
        break
      case 'position_expiring_tomorrow':
        subject = `${ticker} expires tomorrow — close`
        pushBody = `${ticker} ${strategy} expires tomorrow. Close before settlement.`
        htmlBody = positionAlertHtml(ticker, strategy, longK, shortK, pnlStr,
          'Expiring tomorrow', 'Close before expiry to avoid assignment risk.', clickUrl)
        break
      case 'position_filled':
        subject = `${ticker} order filled`
        pushBody = `${ticker} ${strategy} filled. Tracking has begun.`
        htmlBody = positionAlertHtml(ticker, strategy, longK, shortK, pnlStr,
          'Order filled', 'Position is now being monitored.', clickUrl)
        break
      case 'position_closed':
        subject = `${ticker} position closed`
        pushBody = `${ticker} ${strategy} closed. Final P&L ${pnlStr}.`
        htmlBody = positionAlertHtml(ticker, strategy, longK, shortK, pnlStr,
          'Position closed', 'Outcome logged.', clickUrl)
        break
      default:
        subject = `${ticker} position update`
        pushBody = `${ticker} ${strategy}: ${pnlStr}`
        htmlBody = positionAlertHtml(ticker, strategy, longK, shortK, pnlStr,
          'Position update', '', clickUrl)
    }
  } else {
    // ─── Catalyst path (legacy) ────────────────────────────────────
    const { data: signal, error: signalError } = await supabase
      .from('signals')
      .select('id, ticker, direction, trade_type, catalyst_date, thesis')
      .eq('id', signalId)
      .eq('user_id', userId)
      .maybeSingle()
    if (signalError || !signal) {
      return json({ success: false, error: 'signal not found for user' }, 404)
    }
    clickUrl = `${APP_URL}/signal/${signal.id}`
    if (alertType === 'outcome_reminder') {
      subject = `Log outcome for ${signal.ticker} — catalyst was yesterday`
      htmlBody = outcomeReminderHtml(signal)
      pushBody = `Catalyst was yesterday. Log the outcome to keep your record clean.`
    } else {
      const days = alertType === 'catalyst_approaching_14d'
        ? 14
        : alertType === 'catalyst_approaching_7d'
          ? 7
          : 1
      const niceDate = new Date(signal.catalyst_date).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      subject = `${signal.ticker} catalyst in ${days} day${days > 1 ? 's' : ''} — ${niceDate}`
      htmlBody = catalystReminderHtml(signal, days)
      pushBody = `${signal.ticker}: catalyst in ${days} day${days > 1 ? 's' : ''} (${niceDate}).`
    }
  }

  // Email via Resend
  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: profile.email,
      subject,
      html: htmlBody,
    }),
  })

  if (!resendResp.ok) {
    const detail = await resendResp.text().catch(() => '')
    return json(
      { success: false, error: `resend ${resendResp.status}`, detail: detail.slice(0, 500) },
      502,
    )
  }

  const emailData = await resendResp.json().catch(() => ({}))

  // Web-push fan-out
  const pushStats = await fanOutPush(supabase, userId, {
    title: 'Wiley Edge',
    body: pushBody,
    url: clickUrl,
    type: alertType,
  })

  const sentVia = pushStats.sent > 0 ? 'push' : 'email'
  const { error: insertError } = await supabase.from('alerts').insert({
    user_id: userId,
    signal_id: signalId,
    alert_type: alertType,
    message: subject,
    sent_via: sentVia,
  })
  if (insertError) {
    return json({
      success: true,
      email_id: emailData.id,
      push: pushStats,
      alert_log_error: insertError.message,
    })
  }

  return json({ success: true, email_id: emailData.id, push: pushStats })
})

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function catalystReminderHtml(signal: Record<string, string>, daysRemaining: number): string {
  const urgencyColor =
    daysRemaining <= 1 ? '#ef4444' : daysRemaining <= 7 ? '#eab308' : '#6366f1'
  const direction = String(signal.direction ?? '').replace('_', ' ').toUpperCase()
  const tradeType = String(signal.trade_type ?? '').toUpperCase()
  const dayCallout = daysRemaining === 1 ? `
    <div class="rules">
      <div class="rules-title">Pre-Catalyst Reminder</div>
      <div class="rule">• Consider exiting today to capture IV spike</div>
      <div class="rule">• Never hold through binary event unless edge is extreme</div>
      <div class="rule">• Sell into volatility — not after the announcement</div>
    </div>` : `
    <div class="rules">
      <div class="rules-title">Rules Reminder</div>
      <div class="rule">• Stop loss: exit if option down -50%</div>
      <div class="rule">• Exit day before catalyst to capture IV</div>
      <div class="rule">• Verify thesis still intact before catalyst</div>
    </div>`

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { background:#0a0a0f; color:#e8e8f0; font-family:'Courier New',monospace; padding:24px; }
    .container { max-width:480px; margin:0 auto; }
    .alert-banner { background:${urgencyColor}22; border:1px solid ${urgencyColor}; border-radius:8px; padding:16px; margin-bottom:24px; }
    .days { color:${urgencyColor}; font-size:32px; font-weight:bold; }
    .label { color:#6b6b8a; font-size:11px; text-transform:uppercase; letter-spacing:1px; }
    .card { background:#111118; border:1px solid #1e1e2e; border-radius:8px; padding:16px; margin-bottom:12px; }
    .ticker { color:white; font-size:18px; font-weight:bold; }
    .direction { color:#ef4444; font-size:11px; font-weight:bold; }
    .thesis { color:#6b6b8a; font-size:12px; line-height:1.5; margin-top:8px; white-space:pre-wrap; }
    .rules { background:#1a0000; border:1px solid #7f1d1d; border-radius:8px; padding:12px; }
    .rules-title { color:#ef4444; font-size:10px; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }
    .rule { color:#6b6b8a; font-size:11px; margin-bottom:4px; }
    .cta { background:#ef4444; color:white; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:bold; font-size:13px; display:inline-block; margin-top:16px; }
  </style></head><body><div class="container">
    <div class="alert-banner">
      <div class="days">${daysRemaining} DAY${daysRemaining > 1 ? 'S' : ''}</div>
      <div class="label">Until catalyst</div>
    </div>
    <div class="card">
      <div class="ticker">${escapeHtml(signal.ticker)}</div>
      <div class="direction">${escapeHtml(direction)} · ${escapeHtml(tradeType)}</div>
      <div class="thesis">${escapeHtml(String(signal.thesis ?? ''))}</div>
    </div>
    ${dayCallout}
    <div style="text-align:center;">
      <a href="${APP_URL}/signal/${escapeHtml(String(signal.id ?? ''))}" class="cta">View Signal →</a>
    </div>
  </div></body></html>`
}

function outcomeReminderHtml(signal: Record<string, string>): string {
  const niceDate = new Date(String(signal.catalyst_date ?? '')).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { background:#0a0a0f; color:#e8e8f0; font-family:'Courier New',monospace; padding:24px; }
    .container { max-width:480px; margin:0 auto; }
    .card { background:#111118; border:1px solid #1e1e2e; border-radius:8px; padding:16px; margin-bottom:16px; }
    .ticker { color:white; font-size:18px; font-weight:bold; }
    .message { color:#6b6b8a; font-size:13px; line-height:1.5; margin-bottom:16px; }
    .cta { background:#ef4444; color:white; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:bold; font-size:13px; display:inline-block; }
  </style></head><body><div class="container">
    <div class="card">
      <div class="ticker">${escapeHtml(signal.ticker)} — Outcome Pending</div>
    </div>
    <div class="message">
      Your ${escapeHtml(signal.ticker)} catalyst was yesterday (${escapeHtml(niceDate)}).<br><br>
      Log your outcome now to keep your track record accurate and timestamped.
      Your record only has credibility if it's complete.
    </div>
    <div style="text-align:center;">
      <a href="${APP_URL}/signal/${escapeHtml(String(signal.id ?? ''))}" class="cta">Log Outcome →</a>
    </div>
  </div></body></html>`
}

// Position-monitoring email — works for the full ladder of position
// alerts (stop-loss, profit milestones, DTE warning, expiry). Single
// template parameterised by headline + cta.
function positionAlertHtml(
  ticker: string,
  strategy: string,
  longK: unknown,
  shortK: unknown,
  pnl: string,
  headline: string,
  ctaText: string,
  url: string,
): string {
  return `<!doctype html><html><head><meta charset="utf-8" /><style>
    body { font-family: -apple-system, sans-serif; background:#0a0a0f; color:#e8e8f0; padding:24px; }
    .card { max-width:480px; margin:0 auto; background:#111118; border:1px solid #1e1e2e; border-radius:12px; padding:24px; }
    h1 { font-size:18px; margin:0 0 4px; color:#e8b558; }
    .ticker { font-size:28px; font-weight:700; margin:8px 0 4px; }
    .strategy { color:#8b8ba6; font-size:13px; margin-bottom:16px; }
    .strikes { font-family:monospace; color:#e8e8f0; padding:8px 12px; background:#0a0a0f; border-radius:6px; display:inline-block; margin-bottom:12px; }
    .pnl { font-size:24px; font-weight:600; margin:12px 0; }
    .pnl.pos { color:#22c55e; }
    .pnl.neg { color:#ef4444; }
    .cta { display:inline-block; padding:12px 20px; background:#e8b558; color:#06060a; border-radius:8px; text-decoration:none; font-weight:600; margin-top:16px; }
    .note { color:#8b8ba6; font-size:13px; line-height:1.5; }
  </style></head><body>
  <div class="card">
    <h1>${escapeHtml(headline)}</h1>
    <div class="ticker">${escapeHtml(ticker)}</div>
    <div class="strategy">${escapeHtml(strategy)}</div>
    <div class="strikes">${escapeHtml(String(longK ?? ''))} / ${escapeHtml(String(shortK ?? ''))}</div>
    <div class="pnl ${pnl.startsWith('-') || pnl.startsWith('−') ? 'neg' : 'pos'}">${escapeHtml(pnl)}</div>
    ${ctaText ? `<p class="note">${escapeHtml(ctaText)}</p>` : ''}
    <div style="text-align:center;">
      <a href="${escapeHtml(url)}" class="cta">View Position →</a>
    </div>
  </div></body></html>`
}
