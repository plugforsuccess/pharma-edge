// LDP risk tier — TypeScript mirror of ldp/risk.py (compute_risk_profile
// + describe). The Python engine is the source of truth; this copy lets
// the ldp-onboarding edge function compute and return the tier
// immediately. Parity is enforced by ldp/tests/fixtures/risk_tier_cases.json,
// checked by both `pytest ldp` and `npm run ldp:risk:check`. Edit both
// files together and regenerate the fixtures.
//
// Rules, in order — the LOWEST resulting tier wins:
//   1. start from the stated tolerance
//   2. account under risk.minAccountAggressive → cap at moderate
//   3. options experience = none              → cap at moderate
//   4. horizon under risk.minHorizonYears     → cap at conservative

import { LDP_CONFIG } from './ldpConfig.generated.ts'

export type RiskTier = 'conservative' | 'moderate' | 'aggressive'
export type Experience = 'none' | 'some' | 'experienced'
export type AccountTier = 'managed' | 'self_directed'

export const RISK_TIERS: RiskTier[] = ['conservative', 'moderate', 'aggressive']
const RANK: Record<RiskTier, number> = { conservative: 0, moderate: 1, aggressive: 2 }

export interface OnboardingAnswers {
  stated_tolerance: RiskTier
  account_size: number
  options_experience: Experience
  horizon_years: number
}

export interface RuleResult {
  rule: string
  fired: boolean
  cap: RiskTier | null
  detail: string
}

export interface RiskProfile {
  tier: RiskTier
  capped_by: string | null
  rules: RuleResult[]
}

type Config = {
  risk: { minAccountAggressive: number; minHorizonYears: number }
  satellite: { maxPerName: number; maxTotal: number }
}

// Python `{:g}` for the values we format (whole numbers and short decimals).
const g = (n: number) => String(Number(n))
// Python `{:,.0f}`.
const money = (n: number) => Math.round(n).toLocaleString('en-US')
// Python `{:.0%}`.
const pct0 = (x: number) => `${Math.round(x * 100)}%`

export function validateAnswers(a: unknown): OnboardingAnswers | string {
  if (!a || typeof a !== 'object') return 'answers are required'
  const o = a as Record<string, unknown>
  const tol = o.stated_tolerance
  const exp = o.options_experience
  const size = Number(o.account_size)
  const years = Number(o.horizon_years)
  if (typeof tol !== 'string' || !(tol in RANK)) return 'stated_tolerance must be conservative, moderate, or aggressive'
  if (exp !== 'none' && exp !== 'some' && exp !== 'experienced') return 'options_experience must be none, some, or experienced'
  if (!Number.isFinite(size) || size < 0 || size > 1e10) return 'account_size must be a non-negative number'
  if (!Number.isFinite(years) || years < 0 || years > 100) return 'horizon_years must be between 0 and 100'
  return { stated_tolerance: tol as RiskTier, options_experience: exp, account_size: size, horizon_years: years }
}

export function computeRiskProfile(a: OnboardingAnswers, cfg: Config = LDP_CONFIG): RiskProfile {
  const smallAccount = a.account_size < cfg.risk.minAccountAggressive
  const noExperience = a.options_experience === 'none'
  const shortHorizon = a.horizon_years < cfg.risk.minHorizonYears
  const rules: RuleResult[] = [
    { rule: 'stated_tolerance', fired: true, cap: a.stated_tolerance, detail: `stated tolerance: ${a.stated_tolerance}` },
    {
      rule: 'account_size', fired: smallAccount, cap: smallAccount ? 'moderate' : null,
      detail: `account $${money(a.account_size)} vs $${money(cfg.risk.minAccountAggressive)} minimum for aggressive`,
    },
    {
      rule: 'options_experience', fired: noExperience, cap: noExperience ? 'moderate' : null,
      detail: `options experience: ${a.options_experience}`,
    },
    {
      rule: 'time_horizon', fired: shortHorizon, cap: shortHorizon ? 'conservative' : null,
      detail: `horizon ${g(a.horizon_years)} yr vs ${g(cfg.risk.minHorizonYears)} yr minimum`,
    },
  ]
  let tier = a.stated_tolerance
  let cappedBy: string | null = null
  for (const r of rules.slice(1)) {
    // Strictly lower only: equal caps report the first rule in order.
    if (r.fired && r.cap && RANK[r.cap] < RANK[tier]) {
      tier = r.cap
      cappedBy = r.rule
    }
  }
  return { tier, capped_by: cappedBy, rules }
}

const TIER_LABELS: Record<RiskTier, string> = {
  conservative: 'Conservative',
  moderate: 'Moderate',
  aggressive: 'Aggressive',
}

function tierAllows(tier: RiskTier, cfg: Config): string {
  if (tier === 'conservative') return 'Core sector-ETF LEAPS only. Small-cap satellites are never traded or suggested.'
  if (tier === 'moderate') return 'Core sector-ETF LEAPS, plus small-cap satellites as suggestions you approve one by one.'
  return 'Core sector-ETF LEAPS, plus small-cap satellites within size caps ' +
    `(${pct0(cfg.satellite.maxPerName)} per name, ${pct0(cfg.satellite.maxTotal)} total).`
}

function cappedByText(cappedBy: string | null, cfg: Config): string {
  if (cappedBy === 'account_size') return `Capped at Moderate because the account is under $${money(cfg.risk.minAccountAggressive)}.`
  if (cappedBy === 'options_experience') return 'Capped at Moderate because you have no options experience yet.'
  if (cappedBy === 'time_horizon') return `Capped at Conservative because your time horizon is under ${g(cfg.risk.minHorizonYears)} years.`
  return 'Based on your stated risk tolerance.'
}

export function describe(p: RiskProfile, accountTier: AccountTier, cfg: Config = LDP_CONFIG) {
  return {
    tier: p.tier,
    label: TIER_LABELS[p.tier],
    capped_by: p.capped_by,
    capped_by_text: cappedByText(p.capped_by, cfg),
    allows: tierAllows(p.tier, cfg),
    account_text: accountTier === 'managed'
      ? 'Managed account — the bot places trades for you within these limits.'
      : 'Self-directed account — the bot suggests trades; you place them.',
  }
}
