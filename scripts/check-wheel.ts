// Wheel Strategy regression runner (Deno).
//
// Runs the JSON fixtures against the pure decision engine
// (supabase/functions/_shared/wheelStrategy.ts) so the §4.1/§4.2/§4.3
// trading logic is locked to a spec test — including the build prompt
// §10 golden fixture (golden_now_regime_a).
//
// Run via `npm run wheel:check` (requires `deno` on PATH).

import { evaluateWheelSetup, type WheelInput } from '../supabase/functions/_shared/wheelStrategy.ts'

interface Fixture {
  name: string
  note?: string
  input: WheelInput
  expected: {
    regime?: 'A' | 'B'
    tradeable?: boolean
    call_wall_strike?: number
    put_wall_strike?: number
    suggested_call_strike?: number | null
    suggested_put_strike?: number | null
    disqualify_reasons_empty?: boolean
    reasons_contains_any?: string[]
    wall_trend?: 'TRENDING_UP' | 'ESTABLISHED_PIN' | 'TRENDING_DOWN' | 'UNKNOWN'
    trade_side?: 'put_only' | 'call_only' | 'full'
    wall_confidence?: 'high' | 'reduced' | 'unknown'
    effective_call_strike?: number | null
    effective_put_strike?: number | null
    wall_message_contains_any?: string[]
  }
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

const fixturesPath = new URL('./wheel-fixtures.json', import.meta.url)
const fixtures: Fixture[] = JSON.parse(await Deno.readTextFile(fixturesPath))

let passed = 0
let failed = 0
const failures: Array<{ name: string; errors: string[]; result: unknown }> = []

for (const f of fixtures) {
  const r = evaluateWheelSetup(f.input)
  const e = f.expected
  const errors: string[] = []

  if (has(e, 'regime') && r.regime !== e.regime) {
    errors.push(`expected regime=${e.regime}, got ${r.regime}`)
  }
  if (has(e, 'tradeable') && r.tradeable !== e.tradeable) {
    errors.push(`expected tradeable=${e.tradeable}, got ${r.tradeable}`)
  }
  if (has(e, 'call_wall_strike') && (r.call_wall?.strike ?? null) !== e.call_wall_strike) {
    errors.push(`expected call_wall=${e.call_wall_strike}, got ${r.call_wall?.strike ?? null}`)
  }
  if (has(e, 'put_wall_strike') && (r.put_wall?.strike ?? null) !== e.put_wall_strike) {
    errors.push(`expected put_wall=${e.put_wall_strike}, got ${r.put_wall?.strike ?? null}`)
  }
  if (has(e, 'suggested_call_strike') && r.suggested_call_strike !== e.suggested_call_strike) {
    errors.push(
      `expected suggested_call_strike=${e.suggested_call_strike}, got ${r.suggested_call_strike}`,
    )
  }
  if (has(e, 'suggested_put_strike') && r.suggested_put_strike !== e.suggested_put_strike) {
    errors.push(
      `expected suggested_put_strike=${e.suggested_put_strike}, got ${r.suggested_put_strike}`,
    )
  }
  if (e.disqualify_reasons_empty === true && r.disqualify_reasons.length !== 0) {
    errors.push(`expected no disqualify reasons, got: ${r.disqualify_reasons.join(' | ')}`)
  }
  const needles = e.reasons_contains_any ?? []
  if (needles.length > 0) {
    const hay = r.disqualify_reasons.join(' | ')
    if (!needles.some((n) => hay.includes(n))) {
      errors.push(`reasons missing any of [${needles.join(' | ')}] — got: ${hay}`)
    }
  }

  const wm = r.wall_migration
  if (has(e, 'wall_trend') && wm.trend !== e.wall_trend) {
    errors.push(`expected wall_trend=${e.wall_trend}, got ${wm.trend}`)
  }
  if (has(e, 'trade_side') && wm.trade_side !== e.trade_side) {
    errors.push(`expected trade_side=${e.trade_side}, got ${wm.trade_side}`)
  }
  if (has(e, 'wall_confidence') && wm.confidence !== e.wall_confidence) {
    errors.push(`expected wall_confidence=${e.wall_confidence}, got ${wm.confidence}`)
  }
  if (has(e, 'effective_call_strike') && wm.effective_call_strike !== e.effective_call_strike) {
    errors.push(
      `expected effective_call_strike=${e.effective_call_strike}, got ${wm.effective_call_strike}`,
    )
  }
  if (has(e, 'effective_put_strike') && wm.effective_put_strike !== e.effective_put_strike) {
    errors.push(
      `expected effective_put_strike=${e.effective_put_strike}, got ${wm.effective_put_strike}`,
    )
  }
  const wmNeedles = e.wall_message_contains_any ?? []
  if (wmNeedles.length > 0 && !wmNeedles.some((n) => wm.message.includes(n))) {
    errors.push(`wall message missing any of [${wmNeedles.join(' | ')}] — got: ${wm.message}`)
  }

  if (errors.length === 0) {
    passed++
  } else {
    failed++
    failures.push({ name: f.name, errors, result: r })
  }
}

console.log(`[wheel] ${passed} passed, ${failed} failed (of ${fixtures.length})`)
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`\n  ✗ ${f.name}`)
    for (const e of f.errors) console.error(`    - ${e}`)
    console.error(`    got: ${JSON.stringify(f.result)}`)
  }
  Deno.exit(1)
}
