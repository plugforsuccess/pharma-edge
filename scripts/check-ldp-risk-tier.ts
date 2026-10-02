// LDP risk-tier parity check — TypeScript side.
//
// Runs every case in ldp/tests/fixtures/risk_tier_cases.json (generated
// from the Python engine) through supabase/functions/_shared/ldpRiskTier.ts
// and fails on any difference in tier, capping rule, rule results or UI
// copy. Run with `npm run ldp:risk:check`.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { computeRiskProfile, describe } from '../supabase/functions/_shared/ldpRiskTier.ts'

const here = dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(readFileSync(resolve(here, '../ldp/tests/fixtures/risk_tier_cases.json'), 'utf8'))

let failed = 0
for (const c of cases) {
  const p = computeRiskProfile(c.answers)
  const got = { tier: p.tier, capped_by: p.capped_by, rules: p.rules, display: describe(p, c.account_tier) }
  const a = JSON.stringify(got, Object.keys(got).sort())
  const want = JSON.stringify(c.expected, Object.keys(c.expected).sort())
  if (JSON.stringify(sortDeep(got)) !== JSON.stringify(sortDeep(c.expected))) {
    failed++
    if (failed <= 5) console.error('✗', JSON.stringify(c.answers), c.account_tier, '\n  got ', a, '\n  want', want)
  }
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]))
  }
  return v
}

console.log(`ldp risk-tier parity: ${cases.length - failed} passed, ${failed} failed`)
if (failed) process.exit(1)
