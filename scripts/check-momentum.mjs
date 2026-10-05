// Checks for src/utils/momentum.js (npm run momentum:check).
import { monthEndIndexes, momentumScore, crossSectionalEntries, MOMENTUM } from '../src/utils/momentum.js'

let passed = 0
const failures = []
const eq = (name, got, want, tol = 0) => {
  const ok = typeof want === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++; else failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

// Trading days from 2024-01-01, weekdays only.
const days = []
for (let d = new Date(Date.UTC(2024, 0, 1)); days.length < 400; d.setUTCDate(d.getUTCDate() + 1)) {
  if ([0, 6].includes(d.getUTCDay())) continue
  days.push(d.toISOString().slice(0, 10))
}
const mk = (ticker, growth) => ({ ticker, bars: days.map((t, i) => { const c = 100 * Math.pow(1 + growth, i); return { t, o: c, h: c, l: c, c, v: 1 } }) })

const a = mk('A', 0.001)
const me = monthEndIndexes(a.bars)
eq('month ends are the bar before a month change', me.slice(0, 2).map((i) => [a.bars[i].t, a.bars[i + 1].t]), [['2024-01-31', '2024-02-01'], ['2024-02-29', '2024-03-01']])
eq('the last bar is never a month end', me[me.length - 1] < a.bars.length - 1, true)
const closes = a.bars.map((b) => b.c)
eq('12-1 score needs a year of history', momentumScore(closes, 251), null)
eq('12-1 score = close 21 bars ago / close 252 bars ago − 1', momentumScore(closes, 300), Math.pow(1.001, 231) - 1, 1e-12)

// 40 names: growth ranks them; the top decile (4) are the entries each
// month; one name below its 200-day is not eligible.
const items = []
for (let k = 0; k < 40; k++) {
  const it = mk(`T${k}`, 0.0002 * k)
  it.s200 = it.bars.map((b) => (k === 39 ? b.c * 1.01 : b.c * 0.99)) // T39 sits below its 200-day
  items.push(it)
}
const { entries, months } = crossSectionalEntries(items)
const scoredMonths = months.filter((m) => m.picked > 0)
eq('months with fewer than minNames scored pick nothing', months.filter((m) => m.names < MOMENTUM.minNames).every((m) => m.picked === 0), true)
eq('top decile of 39 eligible = 3 picks', scoredMonths[0].picked, 3)
eq('eligible names exclude the one below its 200-day', scoredMonths[0].names, 39)
const picked = (t) => entries.get(t).filter(Boolean).length
eq('the fastest eligible names are picked every scored month', [picked('T38'), picked('T37'), picked('T36')], [scoredMonths.length, scoredMonths.length, scoredMonths.length])
eq('the next name down is never picked', picked('T35'), 0)
eq('a name below its 200-day is never picked, however fast', picked('T39'), 0)
eq('entries land on month-end bars only', [...entries.get('T38').keys()].filter((i) => entries.get('T38')[i]).every((i) => monthEndIndexes(items[38].bars).includes(i)), true)

console.log(`momentum checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) { for (const x of failures) console.error('  ✗ ' + x); process.exit(1) }
