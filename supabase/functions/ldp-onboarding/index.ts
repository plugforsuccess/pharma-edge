// Cash Moves — ldp-onboarding edge function.
//
// The only write path into ldp_risk_profiles (service-role write only —
// the tier gates what the bot buys and whether it auto-trades). Used by
// both /leaps/onboarding (first run) and /settings (later edits).
//
//   POST {
//     answers?:  { stated_tolerance, account_size, options_experience, horizon_years },
//     tax?:      { filing_status, annual_income, state_code },
//     allow_catalyst_plays?: boolean,
//     exit_ladder?: { targets: number[], fractions: number[] | null },
//     disclosures?: { version, accepted: true },
//   }
//   → { success, profile: { tier, capped_by, rule_results, display, account_tier,
//                           allow_catalyst_plays, exit_ladder, rung_fractions } }
//
// * user_id comes from the verified JWT, never the body.
// * Changing the risk answers recomputes the tier (_shared/ldpRiskTier.ts,
//   a mirror of ldp/risk.py kept in parity by fixtures). It needs the
//   current disclosures accepted — in this request, or already on file.
// * account_tier (managed vs self-directed) is NEVER set here. New rows
//   get the column default ('self_directed'); existing rows keep theirs.
// * exit_ladder / allow_catalyst_plays can be updated on their own once
//   a profile exists.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { computeRiskProfile, describe, validateAnswers } from '../_shared/ldpRiskTier.ts'

// Bump when the disclosure text in src/lib/ldpDisclosures.js changes.
export const LDP_DISCLOSURES_VERSION = 'ldp-2026-10-02'

// Exit Target ladder bounds: 1–5 rungs, each an after-tax gain multiple
// of basis in (0, 10], strictly ascending; sell shares > 0 summing to 1.
const LADDER_MAX_RUNGS = 5
const LADDER_MAX_TARGET = 10

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

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

const FILING = new Set(['single', 'mfj', 'mfs', 'hoh'])

function validateLadder(raw: unknown): { targets: number[]; fractions: number[] | null } | string {
  if (!raw || typeof raw !== 'object') return 'exit_ladder must be an object'
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.targets)) return 'exit_ladder.targets must be a list'
  const targets = o.targets.map(Number)
  if (targets.length < 1 || targets.length > LADDER_MAX_RUNGS) return `exit targets: 1 to ${LADDER_MAX_RUNGS} rungs`
  if (targets.some((t) => !Number.isFinite(t) || t <= 0 || t > LADDER_MAX_TARGET)) {
    return `each exit target must be above 0% and at most ${LADDER_MAX_TARGET * 100}% after tax`
  }
  for (let i = 1; i < targets.length; i++) {
    if (targets[i] <= targets[i - 1]) return 'exit targets must increase from rung to rung'
  }
  let fractions: number[] | null = null
  if (o.fractions != null) {
    if (!Array.isArray(o.fractions) || o.fractions.length !== targets.length) {
      return 'one sell share per exit target'
    }
    fractions = o.fractions.map(Number)
    if (fractions.some((f) => !Number.isFinite(f) || f <= 0)) return 'each sell share must be above 0%'
    const sum = fractions.reduce((a, b) => a + b, 0)
    if (Math.abs(sum - 1) > 0.001) return 'sell shares must add up to 100%'
  }
  return { targets, fractions }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ success: false, error: 'unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'invalid JSON body' }, 400)
  }

  const hasAnswers = body.answers != null
  const hasTax = body.tax != null
  const hasLadder = body.exit_ladder != null
  const hasCatalyst = typeof body.allow_catalyst_plays === 'boolean'
  if (!hasAnswers && !hasTax && !hasLadder && !hasCatalyst) {
    return json({ success: false, error: 'nothing to save' }, 400)
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const { data: existing } = await admin.from('ldp_risk_profiles')
    .select('account_tier, disclosures_version').eq('user_id', user.id).maybeSingle()

  // ── Validate ────────────────────────────────────────────────────
  let answers = null
  if (hasAnswers) {
    const a = validateAnswers(body.answers)
    if (typeof a === 'string') return json({ success: false, error: a }, 400)
    answers = a
    const d = (body.disclosures ?? {}) as Record<string, unknown>
    const acceptedNow = d.accepted === true && d.version === LDP_DISCLOSURES_VERSION
    const onFile = existing?.disclosures_version === LDP_DISCLOSURES_VERSION
    if (!acceptedNow && !onFile) {
      return json({
        success: false,
        error: 'please review and accept the current disclosures',
        disclosures_required: true,
        disclosures_version: LDP_DISCLOSURES_VERSION,
      }, 400)
    }
  } else if (!existing && (hasLadder || hasCatalyst)) {
    return json({ success: false, error: 'complete your risk profile first' }, 400)
  }

  let ladder = null
  if (hasLadder) {
    const l = validateLadder(body.exit_ladder)
    if (typeof l === 'string') return json({ success: false, error: l }, 400)
    ladder = l
  }

  let taxRow: Record<string, unknown> | null = null
  if (hasTax) {
    const tax = body.tax as Record<string, unknown>
    const filingStatus = String(tax.filing_status ?? '')
    const annualIncome = Number(tax.annual_income)
    const stateCode = String(tax.state_code ?? '').toUpperCase()
    if (!FILING.has(filingStatus)) return json({ success: false, error: 'filing_status must be single, mfj, mfs, or hoh' }, 400)
    if (!Number.isFinite(annualIncome) || annualIncome < 0 || annualIncome > 1e10) {
      return json({ success: false, error: 'annual_income must be a non-negative number' }, 400)
    }
    if (!/^[A-Z]{2}$/.test(stateCode)) return json({ success: false, error: 'state_code is required' }, 400)
    const { data: taxYear } = await admin.from('tax_year_config').select('tax_year').eq('is_current', true).maybeSingle()
    if (!taxYear) return json({ success: false, error: 'tax figures are not loaded yet' }, 503)
    const { data: stateRow } = await admin.from('state_tax_rates').select('state_code')
      .eq('tax_year', taxYear.tax_year).eq('state_code', stateCode).maybeSingle()
    if (!stateRow) return json({ success: false, error: `unknown state: ${stateCode}` }, 400)
    taxRow = { user_id: user.id, filing_status: filingStatus, annual_income: annualIncome, state_code: stateCode }
    if (answers && answers.account_size > 0) taxRow.portfolio_size = answers.account_size
  }

  // ── Save ────────────────────────────────────────────────────────
  const accountTier = existing?.account_tier === 'managed' ? 'managed' : 'self_directed'
  const now = new Date().toISOString()
  const riskPatch: Record<string, unknown> = {}

  if (answers) {
    const profile = computeRiskProfile(answers)
    Object.assign(riskPatch, {
      stated_tolerance: answers.stated_tolerance,
      account_size: answers.account_size,
      options_experience: answers.options_experience,
      horizon_years: answers.horizon_years,
      tier: profile.tier,
      capped_by: profile.capped_by,
      rule_results: profile.rules,
      display: describe(profile, accountTier),
      computed_at: now,
    })
    const d = (body.disclosures ?? {}) as Record<string, unknown>
    if (d.accepted === true && d.version === LDP_DISCLOSURES_VERSION) {
      riskPatch.disclosures_accepted_at = now
      riskPatch.disclosures_version = LDP_DISCLOSURES_VERSION
    }
  }
  if (hasCatalyst) riskPatch.allow_catalyst_plays = body.allow_catalyst_plays === true
  if (ladder) {
    riskPatch.exit_ladder = ladder.targets
    riskPatch.rung_fractions = ladder.fractions
  }

  if (Object.keys(riskPatch).length > 0) {
    // account_tier deliberately never written — see header.
    const q = answers
      ? admin.from('ldp_risk_profiles').upsert({ user_id: user.id, ...riskPatch }, { onConflict: 'user_id' })
      : admin.from('ldp_risk_profiles').update(riskPatch).eq('user_id', user.id)
    const { error: riskErr } = await q
    if (riskErr) {
      console.error('[ldp-onboarding] risk profile write failed', riskErr.message)
      return json({ success: false, error: 'could not save your risk profile' }, 500)
    }
  }

  if (taxRow) {
    const { error: taxErr } = await admin.from('leaps_tax_profiles').upsert(taxRow, { onConflict: 'user_id' })
    if (taxErr) {
      console.error('[ldp-onboarding] tax profile upsert failed', taxErr.message)
      return json({ success: false, error: 'saved your risk profile, but could not save your tax details' }, 500)
    }
  }

  const { data: saved } = await admin.from('ldp_risk_profiles')
    .select('tier, capped_by, rule_results, display, account_tier, allow_catalyst_plays, exit_ladder, rung_fractions, disclosures_version')
    .eq('user_id', user.id).maybeSingle()

  return json({ success: true, profile: saved ? { ...saved, rule_results: saved.rule_results } : null })
})
