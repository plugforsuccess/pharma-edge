// Market-time regression runner (Deno). Imports the REAL pure
// helpers from _shared/marketTime.ts and asserts the deterministic
// invariants tonight's hardening depends on — DTE midnight math
// (#202) and the session classifier (#216) including the EDT/EST
// boundary. A copy-paste test would drift and pass while prod
// broke; importing the actual module is the whole point (same
// discipline as the verdict-fixtures guard).
//
// Run: deno run --allow-read scripts/check-market-time.ts

import { classifySession, dteFor } from '../supabase/functions/_shared/marketTime.ts'

interface Fixture {
  name: string
  note?: string
  fn: 'dteFor' | 'classifySession'
  now: string
  arg?: string
  expected: string | number
}

const fixturesPath = new URL('./market-time-fixtures.json', import.meta.url)
const fixtures: Fixture[] = JSON.parse(await Deno.readTextFile(fixturesPath))

let passed = 0
let failed = 0
const failures: Array<{ name: string; got: unknown; expected: unknown }> = []

for (const f of fixtures) {
  const now = new Date(f.now)
  const got = f.fn === 'dteFor'
    ? dteFor(f.arg as string, now)
    : classifySession(now)
  if (got === f.expected) {
    passed++
  } else {
    failed++
    failures.push({ name: f.name, got, expected: f.expected })
  }
}

console.log(`[market-time] ${passed} passed, ${failed} failed (of ${fixtures.length})`)
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`  ✗ ${f.name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.got)}`)
  }
  Deno.exit(1)
}
