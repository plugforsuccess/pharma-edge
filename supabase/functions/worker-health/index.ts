// Dead-man switch for the streaming + polling pipeline.
//
// Two workers are critical to live UX:
//   * dxlink-worker (Fly.io)        — writes dxlink_quotes per tick
//   * monitor-positions (GH cron)   — writes open_positions.last_polled_at
//
// Both can fail silently — Fly machines OOM, GH cron skips a run, JWT
// rotates and nobody notices. Until this function existed we had no
// way to know either was dead short of opening the app and seeing
// stale numbers.
//
// Invoked every 15 min by the worker-health.yml workflow during RTH.
// If the latest row in either feed is older than its threshold, sends
// an alert email to the admin and writes a `health_alert` row so we
// have a cooldown trail (no more than 1 email per 60 min).
//
// service-role-only — workflow passes SUPABASE_SERVICE_ROLE_KEY as the
// Authorization header. Anything else is rejected.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const FROM_ADDRESS = Deno.env.get('RESEND_FROM') || 'onboarding@resend.dev'
const APP_URL = Deno.env.get('APP_URL') || 'https://pharma-edge.vercel.app'

// Staleness thresholds during RTH. dxlink streams every <1s so 15 min
// is conservative; monitor-positions runs every 5 min so 30 min is two
// missed crons. Both numbers are easy to tune later.
const DXLINK_STALE_MIN = 15
const MONITOR_STALE_MIN = 30

// Suppress repeated emails within this window — we still log the
// state on every run but only one email per cooldown.
const ALERT_COOLDOWN_MIN = 60

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

// Returns true if `now` falls inside US equity RTH (Mon–Fri,
// 9:30am–4:00pm ET). Uses Intl to dodge DST math.
function isRegularTradingHours(now: Date): boolean {
  const nyParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const weekday = nyParts.find((p) => p.type === 'weekday')?.value
  const hour = Number(nyParts.find((p) => p.type === 'hour')?.value)
  const minute = Number(nyParts.find((p) => p.type === 'minute')?.value)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const mins = hour * 60 + minute
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}

function minutesAgo(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return (Date.now() - t) / 60_000
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  const token = authHeader.slice('Bearer '.length)
  const claims = decodeJwtPayload(token)
  if (!claims || claims.role !== 'service_role') {
    return json({ success: false, error: 'service_role required' }, 403)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const now = new Date()
  const rth = isRegularTradingHours(now)

  // Outside RTH, neither worker is supposed to be writing — skip the
  // staleness check entirely so we don't wake the admin at 4am with
  // false alarms. (Pre-market / after-hours data would be a separate
  // feature; today the workers go quiet outside 9:30–16:00 ET.)
  if (!rth) {
    return json({ success: true, rth: false, skipped: 'outside RTH' })
  }

  // Latest write across all dxlink_quotes rows.
  const { data: dxRow, error: dxErr } = await supabase
    .from('dxlink_quotes')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (dxErr) {
    return json({ success: false, error: `dxlink check failed: ${dxErr.message}` }, 502)
  }
  const dxAgeMin = minutesAgo(dxRow?.updated_at)

  // Latest poll across OPEN positions only — closed positions stop
  // getting polled by design, we don't want to alert on those.
  let monAgeMin: number | null = null
  let openCount = 0
  const { data: openRows, error: openErr } = await supabase
    .from('open_positions')
    .select('last_polled_at')
    .eq('status', 'open')
  if (openErr) {
    return json({ success: false, error: `open_positions check failed: ${openErr.message}` }, 502)
  }
  openCount = openRows?.length ?? 0
  if (openCount > 0) {
    const newest = openRows
      .map((r) => (r.last_polled_at ? new Date(r.last_polled_at).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0)
    monAgeMin = newest > 0 ? (Date.now() - newest) / 60_000 : null
  }

  const issues: string[] = []
  if (dxAgeMin != null && dxAgeMin > DXLINK_STALE_MIN) {
    issues.push(
      `dxlink-worker stale: ${Math.round(dxAgeMin)} min since last write (threshold ${DXLINK_STALE_MIN}). ` +
        `Position pages will show "delayed" P&L and HeatPulse will fall back to Yahoo (15-min delayed).`,
    )
  }
  if (monAgeMin != null && monAgeMin > MONITOR_STALE_MIN) {
    issues.push(
      `monitor-positions stale: ${Math.round(monAgeMin)} min since last open-position poll (threshold ${MONITOR_STALE_MIN}, ${openCount} open). ` +
        `Stop-loss / profit-take alerts won't fire until this resumes.`,
    )
  }

  // If everything's healthy, nothing to do.
  if (issues.length === 0) {
    return json({
      success: true,
      rth: true,
      dxAgeMin: dxAgeMin == null ? null : Math.round(dxAgeMin),
      monAgeMin: monAgeMin == null ? null : Math.round(monAgeMin),
      openCount,
      healthy: true,
    })
  }

  // Cooldown — check whether we already emailed in the last hour.
  // health_alerts table: (id, kind, sent_at, payload). Logging the
  // staleness even when we suppress the email so the admin view can
  // show a continuous timeline.
  const cooldownCutoff = new Date(Date.now() - ALERT_COOLDOWN_MIN * 60_000).toISOString()
  const { data: recent } = await supabase
    .from('health_alerts')
    .select('id, sent_at')
    .gte('sent_at', cooldownCutoff)
    .order('sent_at', { ascending: false })
    .limit(1)
  const recentAlert = recent && recent[0]

  let emailSent = false
  let emailError: string | null = null

  if (!recentAlert && RESEND_API_KEY) {
    // Send to the first admin's email. Cheap admin-only fan-out;
    // multi-admin support can come later.
    const { data: admin } = await supabase
      .from('profiles')
      .select('email')
      .eq('is_admin', true)
      .not('email', 'is', null)
      .limit(1)
      .maybeSingle()
    if (admin?.email) {
      const bodyText = [
        'Cash Moves worker health alert',
        '',
        `Tripped at: ${now.toISOString()}`,
        `App: ${APP_URL}`,
        '',
        ...issues.map((i) => `• ${i}`),
        '',
        'Suggested fix:',
        '  • dxlink-worker: cd dxlink-worker && flyctl deploy',
        '                   (or flyctl machine restart <id>)',
        '  • monitor-positions: gh workflow run monitor-positions.yml',
        '',
        `(You will not get another email for ${ALERT_COOLDOWN_MIN} min — fix the workers, this cron will go quiet on its own.)`,
      ].join('\n')

      const resendResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: admin.email,
          subject: `[Cash Moves] Worker health — ${issues.length} stale`,
          text: bodyText,
        }),
      })
      if (resendResp.ok) {
        emailSent = true
      } else {
        emailError = `resend ${resendResp.status}`
      }
    } else {
      emailError = 'no admin email found'
    }
  }

  // Always log the health_alerts row, even when we suppressed email
  // for cooldown — gives us an audit trail.
  await supabase.from('health_alerts').insert({
    kind: 'worker_stale',
    payload: {
      issues,
      dxAgeMin: dxAgeMin == null ? null : Math.round(dxAgeMin),
      monAgeMin: monAgeMin == null ? null : Math.round(monAgeMin),
      openCount,
      emailSent,
      emailError,
      suppressed: !!recentAlert,
    },
  })

  return json({
    success: true,
    rth: true,
    dxAgeMin: dxAgeMin == null ? null : Math.round(dxAgeMin),
    monAgeMin: monAgeMin == null ? null : Math.round(monAgeMin),
    openCount,
    healthy: false,
    issues,
    emailSent,
    emailError,
    suppressed: !!recentAlert,
  })
})
