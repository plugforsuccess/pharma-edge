// Peer comparison (Portfolio → Peers; owner, 2026-10-03): where the user's
// net worth before tax ranks among US households, from the Federal
// Reserve's Survey of Consumer Finances 2022 (src/data/netWorthBenchmarks.json,
// built by scraper/build_net_worth_benchmarks.py — inflation-adjusted).
// Pure functions; `npm run peers:check` runs scripts/check-peers.mjs.
//
// The survey counts households, so comparisons are household-level: age
// band (from the birth date), couple / single (filing status: joint or
// separate = couple), homeowner (a primary home among the holdings),
// income band, and — only when the user shares them — education, race /
// ethnicity and, for single households only, sex. Each comparison is
// within the user's age band when the survey has ≥ 100 such households,
// else across all ages.

// No line breaks inside an age band ("ages 35–44" stays on one line).
const NB = '\u00a0'
const J = '\u2060'
export const AGE_LABELS = {
  under_35: `under${NB}35`, '35_44': `35–${J}44`, '45_54': `45–${J}54`, '55_64': `55–${J}64`, '65_74': `65–${J}74`, '75_plus': '75+',
}
export const SEX_OPTIONS = [{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }]
export const RACE_OPTIONS = [
  { value: 'white', label: 'White (non-Hispanic)', group: 'White households' },
  { value: 'black', label: 'Black (non-Hispanic)', group: 'Black households' },
  { value: 'hispanic', label: 'Hispanic or Latino', group: 'Hispanic households' },
  { value: 'other', label: 'Other or multiple races', group: 'Other or multiracial households' },
]
export const EDUCATION_OPTIONS = [
  { value: 'no_hs', label: 'No high school diploma', group: 'No high school diploma' },
  { value: 'hs', label: 'High school diploma', group: 'High school graduates' },
  { value: 'some_college', label: 'Some college or associate degree', group: 'Some college' },
  { value: 'bachelors', label: "Bachelor's degree or higher", group: 'College graduates' },
]

// Whole years old on `today` ('YYYY-MM-DD').
export function ageOn(birthDate, today) {
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthDate ?? ''))
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(today ?? ''))
  if (!b || !t) return null
  let age = +t[1] - +b[1]
  if (+t[2] < +b[2] || (+t[2] === +b[2] && +t[3] < +b[3])) age -= 1
  return age >= 0 ? age : null
}

// The survey's age classes (AGECL).
export function ageBand(age) {
  if (!(age >= 0)) return null
  if (age < 35) return 'under_35'
  if (age < 45) return '35_44'
  if (age < 55) return '45_54'
  if (age < 65) return '55_64'
  if (age < 75) return '65_74'
  return '75_plus'
}

// Percentile (0–100) of `x` among the group's values at `ps`. Below the
// lowest point → its percentile, flagged `below`; above the highest →
// flagged `above` (e.g. top 0.1%).
export function percentileOf(values, ps, x) {
  if (!values?.length || !Number.isFinite(x)) return null
  if (x <= values[0]) return { pct: ps[0], below: x < values[0] }
  const last = values.length - 1
  if (x >= values[last]) return { pct: ps[last], above: x > values[last] }
  let j = 1
  while (j < last && values[j] < x) j++
  const lo = values[j - 1]
  const hi = values[j]
  const t = hi > lo ? (x - lo) / (hi - lo) : 0
  return { pct: ps[j - 1] + t * (ps[j] - ps[j - 1]) }
}

// "Top 18%" in the top half; "30th percentile" below the median; "Top
// 0.1%" past the highest point; "Bottom 1%" under the lowest.
export function rankLabel(r) {
  if (!r) return '—'
  if (r.below) return 'Bottom 1%'
  const top = 100 - r.pct
  if (r.above || top < 1) return `Top ${fmtPct(Math.max(top, 0.1))}%`
  if (r.pct < 50) return `${ordinal(Math.max(1, Math.round(r.pct)))} percentile`
  return `Top ${Math.max(1, Math.round(top))}%`
}
// "96th percentile" (rounded down so it never overstates; 99.5 → "99.5th").
export function percentileLabel(r) {
  if (!r || r.pct == null) return null
  if (r.below) return 'Below the 1st percentile'
  if (r.above) return `Above the ${fmtPct(r.pct)}th percentile`
  const p = r.pct >= 99 ? Math.floor(r.pct * 10) / 10 : Math.floor(r.pct)
  return `${Number.isInteger(p) ? ordinal(Math.max(1, p)) : `${p}th`} percentile`
}
function ordinal(n) {
  const t = n % 100
  if (t >= 11 && t <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}
function fmtPct(n) {
  return n < 1 ? String(+n.toFixed(1)) : String(Math.round(n))
}

// Income band key for household income (the survey's INCCAT cut points).
export function incomeBand(income, bands) {
  if (!Number.isFinite(income) || !bands?.cutoffs?.length) return null
  const e = bands.edges_pct
  let i = 0
  while (i < bands.cutoffs.length && income >= bands.cutoffs[i]) i++
  return `p${e[i]}_${e[i + 1]}`
}

// The band's household-income range, for its label: "Income $104K–$173K",
// "Income under $36K", "Income $285K+".
export function incomeRangeLabel(income, bands) {
  if (!Number.isFinite(income) || !bands?.cutoffs?.length) return null
  const c = bands.cutoffs
  let i = 0
  while (i < c.length && income >= c[i]) i++
  const k = (n) => `$${Math.round(n / 1000)}K`
  if (i === 0) return `Income under ${k(c[0])}`
  if (i === c.length) return `Income ${k(c[c.length - 1])}+`
  return `Income ${k(c[i - 1])}–${k(c[i])}`
}

// Every comparison for this user, headline (age band) first. Each row:
// { key, label, rank, top (0–100 share of households above), median,
//   p75, p90, households, withinAge }.
export function peerComparisons({
  benchmarks, netWorth, birthDate, today, filingStatus, income, homeowner = null,
  sex = null, race = null, education = null,
}) {
  if (!benchmarks?.groups || !Number.isFinite(netWorth)) return { rows: [], age: null, band: null }
  const ps = benchmarks.percentiles
  const at = (vals, p) => vals[ps.indexOf(p)]
  const age = ageOn(birthDate, today)
  const band = ageBand(age)
  const ageText = band ? `ages${NB}${AGE_LABELS[band]}` : null
  const couple = filingStatus === 'mfj' || filingStatus === 'mfs'

  const rows = []
  const add = (key, label, { cross = true } = {}) => {
    const crossed = cross && band ? benchmarks.groups[`age:${band}|${key}`] : null
    const g = crossed ?? benchmarks.groups[key]
    if (!g) return
    const r = percentileOf(g.values, ps, netWorth)
    rows.push({
      key: crossed ? `age:${band}|${key}` : key,
      label: crossed ? `${label}, ${ageText}` : label,
      rank: rankLabel(r),
      pctLabel: percentileLabel(r),
      pct: r?.pct ?? null,
      top: r ? 100 - r.pct : null,
      median: at(g.values, 50),
      p75: at(g.values, 75),
      p90: at(g.values, 90),
      mean: g.mean ?? null,
      households: g.households,
      withinAge: !!crossed,
    })
  }

  if (band && benchmarks.groups[`age:${band}`]) {
    const g = benchmarks.groups[`age:${band}`]
    const r = percentileOf(g.values, ps, netWorth)
    rows.push({ key: `age:${band}`, label: `Households, ${ageText}`, rank: rankLabel(r), pctLabel: percentileLabel(r), pct: r?.pct ?? null,
      top: r ? 100 - r.pct : null, median: at(g.values, 50), p75: at(g.values, 75), p90: at(g.values, 90),
      mean: g.mean ?? null, households: g.households, withinAge: true, headline: true })
  }
  add('all', 'All US households', { cross: false })
  add(couple ? 'household:couple' : 'household:single', couple ? 'Couples' : 'Single households')
  if (homeowner === true) add('home:owner', 'Homeowners')
  const ib = incomeBand(Number(income), benchmarks.income_bands)
  if (ib) add(`income:${ib}`, incomeRangeLabel(Number(income), benchmarks.income_bands))
  if (!couple && (sex === 'female' || sex === 'male')) add(`sex:single_${sex}`, sex === 'female' ? 'Single women' : 'Single men')
  const ed = EDUCATION_OPTIONS.find((o) => o.value === education)
  if (ed) add(`education:${ed.value}`, ed.group)
  const rc = RACE_OPTIONS.find((o) => o.value === race)
  if (rc) add(`race:${rc.value}`, rc.group)
  return { rows, age, band }
}
