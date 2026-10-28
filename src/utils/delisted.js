// Delisted filers from SEC submissions (pre-registered 2026-10-28, list-entry
// bear addendum 1): when and why a float-range filer lost its listing. Pure;
// npm run delisted:check.
const DAY = 86400e3
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)
const MERGER = new Set(['DEFM14A', 'SC TO-T', 'SC 14D9'])

// rows: [{ form, date, items }] oldest first; floatYear: latest year in the float range.
export function exitOf(rows, floatYear) {
  const first = (f) => rows.find(f)?.date ?? null
  const delisted = first((r) => r.form === '25' || r.form === '25-NSE') ?? first((r) => r.form.startsWith('15-'))
  const notice = first((r) => r.form === '8-K' && r.items.includes('3.01'))
  const bankrupt = rows.some((r) => r.form === '8-K' && r.items.includes('1.03'))
  const acquired = rows.some((r) => MERGER.has(r.form))
  const reason = !delisted ? 'no delisting filing' : bankrupt ? 'bankruptcy' : acquired ? 'acquired' : 'delisted, other'
  const mid = floatYear ? `${floatYear}-06-30` : null
  return {
    reason, delisted, notice,
    noticeToDelist: delisted && notice && notice <= delisted ? days(notice, delisted) : null,
    floatToDelist: delisted && mid && mid <= delisted ? days(mid, delisted) : null,
  }
}

const q = (xs, p) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const k = (v.length - 1) * p, lo = Math.floor(k); return v[lo] + (v[Math.ceil(k)] - v[lo]) * (k - lo) }
export function exitStats(exits) {
  const by = {}
  for (const e of exits) by[e.reason] = (by[e.reason] ?? 0) + 1
  const span = (key) => { const v = exits.map((e) => e[key]).filter(Number.isFinite); return { n: v.length, p25: q(v, 0.25), median: q(v, 0.5), p75: q(v, 0.75), avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null } }
  return { n: exits.length, by, noticeToDelist: span('noticeToDelist'), floatToDelist: span('floatToDelist') }
}
