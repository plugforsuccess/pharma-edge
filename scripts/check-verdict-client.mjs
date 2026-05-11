#!/usr/bin/env node
// Verdict regression runner — client side.
//
// Loads scripts/verdict-fixtures.json and exercises every scenario
// against src/utils/thesisVerdict.js. Exits non-zero on any mismatch.
//
// Paired with scripts/check-verdict-server.ts which does the same
// against supabase/functions/monitor-positions/thesisVerdict.ts. Both
// must pass for a verdict logic edit to land — that's the mechanical
// drift guard called out in AUTO_TRADE_MANAGEMENT.md §9.
//
// Run via `npm run verdict:check:client` (or both with
// `npm run verdict:check`).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { computeThesisVerdict } from '../src/utils/thesisVerdict.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesPath = resolve(__dirname, 'verdict-fixtures.json')
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'))

let passed = 0
let failed = 0
const failures = []

for (const f of fixtures) {
  const result = computeThesisVerdict(f.input.entry, f.input.live, f.input.trade)
  const errors = []

  // Either `state` must match exactly OR `state_not` must NOT match.
  // Fixtures use one or the other depending on whether the success
  // condition is "exactly X" or "anything but Y" (e.g. wall-pierce
  // success cases where we only care that we didn't fire invalidated).
  if (f.expected.state != null && result.state !== f.expected.state) {
    errors.push(`expected state=${f.expected.state}, got ${result.state}`)
  }
  if (f.expected.state_not != null && result.state === f.expected.state_not) {
    errors.push(`state should NOT be ${f.expected.state_not}, but it is`)
  }

  // `reasons_contains_any`: at least one reason string must contain
  // at least one of the listed substrings. Substrings, not exact
  // match, so wording changes that preserve meaning still pass.
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

console.log(`[verdict-client] ${passed} passed, ${failed} failed (of ${fixtures.length})`)
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n  ✗ ${f.name}`)
    for (const e of f.errors) console.error(`    - ${e}`)
    console.error(`    got: ${JSON.stringify(f.result)}`)
  }
  process.exit(1)
}
