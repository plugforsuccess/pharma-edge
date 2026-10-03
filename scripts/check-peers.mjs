// Checks for src/utils/peers.js (npm run peers:check).
import { ageOn, ageBand, percentileOf, rankLabel, incomeBand, incomeRangeLabel, peerComparisons } from '../src/utils/peers.js'

let passed = 0
const failures = []
function eq(name, got, want, tol = 0) {
  const ok = typeof want === 'number' && typeof got === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

eq('age before birthday', ageOn('1990-10-05', '2026-10-03'), 35)
eq('age on birthday', ageOn('1990-10-03', '2026-10-03'), 36)
eq('age leap day', ageOn('2000-02-29', '2026-02-28'), 25)
eq('no birth date', ageOn(null, '2026-10-03'), null)
eq('bands', [20, 34, 35, 44, 45, 64, 65, 74, 75, 90].map(ageBand), ['under_35', 'under_35', '35_44', '35_44', '45_54', '55_64', '65_74', '65_74', '75_plus', '75_plus'])

const ps = [1, 25, 50, 75, 99]
const vals = [0, 100, 200, 400, 1000]
eq('interpolates', percentileOf(vals, ps, 300).pct, 62.5)
eq('at a point', percentileOf(vals, ps, 200).pct, 50)
eq('below the lowest', percentileOf(vals, ps, -50), { pct: 1, below: true })
eq('above the highest', percentileOf(vals, ps, 5000), { pct: 99, above: true })
eq('rank top half', rankLabel({ pct: 82.4 }), 'Top 18%')
eq('rank bottom half', rankLabel({ pct: 30.2 }), '30th percentile')
eq('ordinals', [1.2, 2, 3, 11, 22].map((pct) => rankLabel({ pct })), ['1st percentile', '2nd percentile', '3rd percentile', '11th percentile', '22nd percentile'])
eq('rank very top', rankLabel({ pct: 99.9, above: true }), 'Top 0.1%')
eq('rank bottom', rankLabel({ pct: 1, below: true }), 'Bottom 1%')

const bands = { edges_pct: [0, 20, 40, 60, 80, 90, 100], cutoffs: [30000, 60000, 100000, 170000, 280000] }
eq('income lowest band', incomeBand(10000, bands), 'p0_20')
eq('income on a cutoff', incomeBand(60000, bands), 'p40_60')
eq('income top band', incomeBand(800000, bands), 'p90_100')
eq('income range label', incomeRangeLabel(150000, { cutoffs: [35880, 61862, 103928, 173213, 284565] }), 'Income $104K–$173K')
eq('income range label top', incomeRangeLabel(300000, { cutoffs: [35880, 61862, 103928, 173213, 284565] }), 'Income $285K+')
eq('income range label bottom', incomeRangeLabel(20000, { cutoffs: [35880, 61862, 103928, 173213, 284565] }), 'Income under $36K')

const g = (mult, households = 500) => ({ households, values: ps.map((_, i) => vals[i] * mult) })
const benchmarks = {
  percentiles: ps,
  income_bands: bands,
  groups: {
    all: g(1), 'age:35_44': g(2), 'household:single': g(1), 'age:35_44|household:single': g(3),
    'home:owner': g(4), 'income:p90_100': g(5), 'age:35_44|income:p90_100': g(6),
    'sex:single_female': g(1), 'age:35_44|sex:single_female': g(2),
    'race:black': g(1), 'education:bachelors': g(2), 'age:35_44|education:bachelors': g(2),
    'household:couple': g(2),
  },
}
const base = { benchmarks, netWorth: 600, birthDate: '1988-05-01', today: '2026-10-03', filingStatus: 'single', income: 800000 }
const out = peerComparisons({ ...base, sex: 'female', race: 'black', education: 'bachelors', homeowner: true })
eq('age from birth date', out.age, 38)
eq('headline is the age band', [out.rows[0].key, out.rows[0].headline], ['age:35_44', true])
eq('headline percentile', out.rows[0].pct, 62.5)
eq('within age when the cross exists', out.rows.find((r) => r.key.endsWith('household:single')).key, 'age:35_44|household:single')
eq('falls back to all ages', out.rows.find((r) => r.key.endsWith('home:owner')).label, 'Homeowners')
eq('race falls back too', out.rows.find((r) => r.key.endsWith('race:black')).withinAge, false)
eq('single women shown for singles', out.rows.some((r) => r.key.endsWith('sex:single_female')), true)
const married = peerComparisons({ ...base, filingStatus: 'mfj', sex: 'female' })
eq('no sex comparison for couples', married.rows.some((r) => r.key.includes('sex:')), false)
eq('couples comparison', married.rows.some((r) => r.key.endsWith('household:couple')), true)
const none = peerComparisons({ ...base })
eq('optional groups left out when not shared', none.rows.some((r) => /race|education|sex/.test(r.key)), false)
eq('homeowner row only when known', none.rows.some((r) => r.key.includes('home:')), false)
eq('no birth date → no headline', peerComparisons({ ...base, birthDate: null }).rows[0].key, 'all')

console.log(`peers checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
