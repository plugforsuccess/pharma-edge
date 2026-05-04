// Pharma Edge — send-alerts edge function.
//
// Service-role-only endpoint. Called by send-catalyst-alerts.yml (cron) to
// fan out catalyst-approaching reminders and post-catalyst outcome
// reminders. Daily digest stays in scraper/main.py (Week 5) — there's no
// daily_digest case here on purpose.
//
// Security: verify_jwt=true at the platform level validates signature and
// expiry; we additionally require the JWT's `role` claim to be
// `service_role` so a regular logged-in user cannot fan out emails to
// arbitrary user_ids on someone else's Resend budget.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const APP_URL = Deno.env.get('APP_URL') || 'https://APP_URL_NOT_SET.example'
const FROM_ADDRESS = Deno.env.get('RESEND_FROM') || 'onboarding@resend.dev'

const ALLOWED_TYPES = new Set([
  'catalyst_approaching_14d',
  'catalyst_approaching_7d',
  'catalyst_tomorrow',
  'outcome_reminder',
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
    // base64url -> base64
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    return JSON.parse(atob(padded))
  } catch {
    return null
  }
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
  if (!userId || !signalId) {
    return json({ success: false, error: 'user_id and signal_id required' }, 400)
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

  const { data: signal, error: signalError } = await supabase
    .from('signals')
    .select('id, ticker, direction, trade_type, catalyst_date, thesis')
    .eq('id', signalId)
    .eq('user_id', userId)
    .maybeSingle()
  if (signalError || !signal) {
    return json({ success: false, error: 'signal not found for user' }, 404)
  }

  let subject = ''
  let htmlBody = ''

  if (alertType === 'outcome_reminder') {
    subject = `Log outcome for ${signal.ticker} — catalyst was yesterday`
    htmlBody = outcomeReminderHtml(signal)
  } else {
    const days = alertType === 'catalyst_approaching_14d'
      ? 14
      : alertType === 'catalyst_approaching_7d'
        ? 7
        : 1
    const niceDate = new Date(signal.catalyst_date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    subject = `${signal.ticker} catalyst in ${days} day${days > 1 ? 's' : ''} — ${niceDate}`
    htmlBody = catalystReminderHtml(signal, days)
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

  const { error: insertError } = await supabase.from('alerts').insert({
    user_id: userId,
    signal_id: signalId,
    alert_type: alertType,
    message: subject,
    sent_via: 'email',
  })
  if (insertError) {
    // Email already went out; surface but don't fail loudly.
    return json({ success: true, email_id: emailData.id, alert_log_error: insertError.message })
  }

  return json({ success: true, email_id: emailData.id })
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
