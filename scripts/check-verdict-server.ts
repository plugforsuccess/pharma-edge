// Verdict regression runner — server side (Deno).
//
// Mirror of scripts/check-verdict-client.mjs. Loads the same JSON
// fixtures and runs them against the SERVER verdict module
// (supabase/functions/monitor-positions/thesisVerdict.ts) so we catch
// any drift between the two implementations.
//
// Both runners must pass for a verdict logic edit to land — that's
// the mechanical drift guard from AUTO_TRADE_MANAGEMENT.md §9.
//
// Run via `npm run verdict:check:server` (requires `deno` on PATH)
// or both with `npm run verdict:check`.

import { computeThesisVerdict } from '../supabase/functions/monitor-positions/thesisVerdict.ts'

interface Fixture {
  name: string
  note?: string
  input: {
    entry: Parameters<typeof computeThesisVerdict>[0]
    live: Parameters<typeof computeThesisVerdict>[1]
    trade: Parameters<typeof computeThesisVerdict>[2]
  }
  expected: {
    state?: string
    state_not?: string
    reasons_contains_any?: string[]
  }
}

const fixturesPath = new URL('./verdict-fixtures.json', import.meta.url)
const fixtures: Fixture[] = JSON.parse(await Deno.readTextFile(fixturesPath))

let passed = 0
let failed = 0
const failures: Array<{ name: string; errors: string[]; result: unknown }> = []

for (const f of fixtures) {
  const result = computeThesisVerdict(f.input.entry, f.input.live, f.input.trade)
  const errors: string[] = []

  if (f.expected.state != null && result.state !== f.expected.state) {
    errors.push(`expected state=${f.expected.state}, got ${result.state}`)
  }
  if (f.expected.state_not != null && result.state === f.expected.state_not) {
    errors.push(`state should NOT be ${f.expected.state_not}, but it is`)
  }

  const needles = f.expected.reasons_contains_any ?? []
  if (needles.length > 0) {
    const hay = result.reasons.join(' | ')
    const found = needles.some((n) => hay.includes(n))
    if (!found) {
      errors.push(`reasons missing any of [${needles.join(' | ')}] — got: ${hay}`)
    }
  }

  if (errors.length === 0) {
    passed++
  } else {
    failed++
    failures.push({ name: f.name, errors, result })
  }
}

console.log(`[verdict-server] ${passed} passed, ${failed} failed (of ${fixtures.length})`)
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n  ✗ ${f.name}`)
    for (const e of f.errors) console.error(`    - ${e}`)
    console.error(`    got: ${JSON.stringify(f.result)}`)
  }
  Deno.exit(1)
}
