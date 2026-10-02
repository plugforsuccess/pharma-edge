// Cash Moves — ldp-onboarding edge function.
//
// Takes the LEAPS bot onboarding answers, computes the risk tier, and
// saves the suitability record. ldp_risk_profiles is service-role write
// only (the tier gates what the bot buys and whether it auto-trades),
// so this function is the only path from the form to that table.
//
//   POST { answers: { stated_tolerance, account_size, options_experience, horizon_years },
//          tax: { filing_status, annual_income, state_code },
//          allow_catalyst_plays?: boolean,
//          disclosures: { version, accepted: true } }
//   → { success, profile: { tier, capped_by, rule_results, display, account_tier } }
//
// * user_id comes from the verified JWT, never the body.
// * account_tier (managed vs self-directed) is NEVER set here. New rows
//   get the column default ('self_directed'); existing rows keep theirs.
//   Only an admin / the managed-account flow may change it.
// * The tier rules are a mirror of ldp/risk.py (_shared/ldpRiskTier.ts),
//   kept in parity by ldp/tests/fixtures/risk_tier_cases.json.
// * Tax inputs go to leaps_tax_profiles so the after-tax exit ladder
//   works from day one.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { computeRiskProfile, describe, validateAnswers } from '../_shared/ldpRiskTier.ts'

// Bump when the disclosure text in src/pages/LeapsOnboarding.jsx changes.
export const LDP_DISCLOSURES_VERSION = 'ldp-2026-10-02'

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

  // ── Validate ────────────────────────────────────────────────────
  const answers = validateAnswers(body.answers)
  if (typeof answers === 'string') return json({ success: false, error: answers }, 400)

  const disclosures = (body.disclosures ?? {}) as Record<string, unknown>
  if (disclosures.accepted !== true || disclosures.version !== LDP_DISCLOSURES_VERSION) {
    return json({ success: false, error: 'please review and accept the current disclosures', disclosures_version: LDP_DISCLOSURES_VERSION }, 400)
  }

  const tax = (body.tax ?? {}) as Record<string, unknown>
  const filingStatus = String(tax.filing_status ?? '')
  const annualIncome = Number(tax.annual_income)
  const stateCode = String(tax.state_code ?? '').toUpperCase()
  if (!FILING.has(filingStatus)) return json({ success: false, error: 'filing_status must be single, mfj, mfs, or hoh' }, 400)
  if (!Number.isFinite(annualIncome) || annualIncome < 0 || annualIncome > 1e10) {
    return json({ success: false, error: 'annual_income must be a non-negative number' }, 400)
  }
  if (!/^[A-Z]{2}$/.test(stateCode)) return json({ success: false, error: 'state_code is required' }, 400)

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const { data: taxYear } = await admin.from('tax_year_config').select('tax_year').eq('is_current', true).maybeSingle()
  if (!taxYear) return json({ success: false, error: 'tax figures are not loaded yet' }, 503)
  const { data: stateRow } = await admin.from('state_tax_rates').select('state_code')
    .eq('tax_year', taxYear.tax_year).eq('state_code', stateCode).maybeSingle()
  if (!stateRow) return json({ success: false, error: `unknown state: ${stateCode}` }, 400)

  // ── Compute + save ──────────────────────────────────────────────
  const profile = computeRiskProfile(answers)

  const { data: existing } = await admin.from('ldp_risk_profiles').select('account_tier')
    .eq('user_id', user.id).maybeSingle()
  const accountTier = existing?.account_tier === 'managed' ? 'managed' : 'self_directed'
  const display = describe(profile, accountTier)
  const now = new Date().toISOString()

  const riskRow = {
    user_id: user.id,
    stated_tolerance: answers.stated_tolerance,
    account_size: answers.account_size,
    options_experience: answers.options_experience,
    horizon_years: answers.horizon_years,
    tier: profile.tier,
    capped_by: profile.capped_by,
    rule_results: profile.rules,
    display,
    allow_catalyst_plays: body.allow_catalyst_plays === true,
    disclosures_accepted_at: now,
    disclosures_version: LDP_DISCLOSURES_VERSION,
    computed_at: now,
    // account_tier deliberately omitted — see header.
  }
  const { error: riskErr } = await admin.from('ldp_risk_profiles').upsert(riskRow, { onConflict: 'user_id' })
  if (riskErr) {
    console.error('[ldp-onboarding] risk profile upsert failed', riskErr.message)
    return json({ success: false, error: 'could not save your risk profile' }, 500)
  }

  const taxRow: Record<string, unknown> = {
    user_id: user.id,
    filing_status: filingStatus,
    annual_income: annualIncome,
    state_code: stateCode,
  }
  if (answers.account_size > 0) taxRow.portfolio_size = answers.account_size
  const { error: taxErr } = await admin.from('leaps_tax_profiles').upsert(taxRow, { onConflict: 'user_id' })
  if (taxErr) {
    console.error('[ldp-onboarding] tax profile upsert failed', taxErr.message)
    return json({ success: false, error: 'saved your risk profile, but could not save your tax details' }, 500)
  }

  return json({
    success: true,
    profile: {
      tier: profile.tier,
      capped_by: profile.capped_by,
      rule_results: profile.rules,
      display,
      account_tier: accountTier,
      disclosures_version: LDP_DISCLOSURES_VERSION,
    },
  })
})
