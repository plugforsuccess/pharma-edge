// Checks for src/utils/entryEvents.js (what entry alerts fire on).
// Run: npm run entryevents:check
import { entryEvents } from '../src/utils/entryEvents.js'
import { entryModel, DEFAULT_PARAMS } from '../src/utils/indicators.js'
import { periodKey, suiteModel } from '../src/utils/signalSuite.js'

let passed = 0
const failures = []
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++
  else failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// Uptrend with a pullback to the 200-day (the indicator checks' series).
const bars = []
let c = 100
let d = Date.UTC(2023, 0, 2)
for (let i = 0; i < 420; i++) {
  while ([0, 6].includes(new Date(d).getUTCDay())) d += 86400000
  if (i >= 330 && i < 345) c *= 0.985
  else c *= 1.002
  bars.push({ t: new Date(d).toISOString().slice(0, 10), o: c, h: c * 1.005, l: c * 0.995, c, v: 1e6 })
  d += 86400000
}
const P = { ...DEFAULT_PARAMS, ivRankMax: 101 } // HV-rank gate off for synthetic data
const full = entryModel(bars, { params: P })
const first = full.trades[0]
eq('the series has a buy-zone trade', first != null, true)

// Cut the history at the cluster's first signal day: that's "today".
const today = bars.slice(0, first.i + 1)
const e1 = entryEvents({ ticker: 'TST', daily: today, weekly: [], params: P })
eq('buy zone fires on its first day', e1.map((x) => [x.kind, x.event_date]), [['entry_buy_zone', first.t]])
eq('message names the ticker', e1[0].message.startsWith('TST entered the LEAPS buy zone'), true)

// Two days into the cluster (still YES): same event_date → the unique index dedupes.
const sig = full.signals.filter((i) => i >= first.i && i <= first.i + 2 && full.cond[i].all)
const later = sig[sig.length - 1]
const e2 = entryEvents({ ticker: 'TST', daily: bars.slice(0, later + 1), weekly: [], params: P })
eq('a later day in the same cluster keeps the cluster start date', e2.map((x) => x.event_date), later === first.i ? [first.t] : [first.t])

// Not YES today → nothing.
const quiet = bars.slice(0, 300)
eq('no entry when the buy zone is NO', entryEvents({ ticker: 'TST', daily: quiet, weekly: [], params: P }).length, 0)
eq('default thresholds: the HV gate blocks the synthetic entry', entryEvents({ ticker: 'TST', daily: today, weekly: [] }).length, 0)
eq('too little history → nothing', entryEvents({ ticker: 'TST', daily: bars.slice(0, 100), weekly: [] }).length, 0)

// Weekly: a completed week only (Friday rule).
eq('week key sanity', periodKey('2026-10-02', '1wk'), '2026-09-28')
const loose = { windowBull: 60, windowBear: 120, velocityPts: -100, atrExpansion: 0, volumeFloor: 0, vixMax: 1000 }
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const wk = []
let wc = 100
let wd = Date.UTC(2005, 0, 3)
for (let i = 0; i < 700; i++) {
  const o = wc
  wc = o * (1 + Math.sin(i / 9) * 0.03 + 0.002 + (rnd() - 0.5) * 0.03)
  wk.push({ t: new Date(wd).toISOString().slice(0, 10), o, h: Math.max(o, wc) * 1.01, l: Math.min(o, wc) * 0.99, c: wc, v: Math.round(1e6 * (0.5 + rnd() * 2)) })
  wd += 7 * 86400000
}
const lastMonday = wk[wk.length - 1].t
const fri = new Date(`${lastMonday}T12:00:00Z`); fri.setUTCDate(fri.getUTCDate() + 4)
const wed = new Date(`${lastMonday}T12:00:00Z`); wed.setUTCDate(wed.getUTCDate() + 2)
const dayBar = (t) => [{ t: t.toISOString().slice(0, 10), o: 1, h: 1, l: 1, c: 1, v: 1 }]
const onFri = entryEvents({ ticker: 'W', daily: dayBar(fri), weekly: wk, suiteParams: loose })
const onWed = entryEvents({ ticker: 'W', daily: dayBar(wed), weekly: wk, suiteParams: loose })
eq('weekly events are Hardening bulls', [...onFri, ...onWed].every((x) => x.kind === 'entry_hardening_bull'), true)
eq('mid-week, the open week never alerts', onWed.every((x) => x.event_date !== lastMonday), true)
eq('weekly event dates are week starts', [...onFri, ...onWed].every((x) => periodKey(x.event_date, '1wk') === x.event_date), true)

// Pin a real Hardening bull to the last week: it alerts on Friday, not mid-week.
const allBulls = suiteModel(wk, { params: loose }).bulls.filter((b) => b.i >= 300)
eq('synthetic weekly series has bulls', allBulls.length > 0, true)
if (allBulls.length) {
  const b = allBulls[0]
  const cut = wk.slice(0, b.i + 1)
  const mon = cut[cut.length - 1].t
  const f2 = new Date(`${mon}T12:00:00Z`); f2.setUTCDate(f2.getUTCDate() + 4)
  const w2 = new Date(`${mon}T12:00:00Z`); w2.setUTCDate(w2.getUTCDate() + 2)
  eq('bull in the closed week alerts on Friday', entryEvents({ ticker: 'W', daily: dayBar(f2), weekly: cut, suiteParams: loose }).map((x) => x.event_date).includes(mon), true)
  eq('same bull mid-week (week still open) does not', entryEvents({ ticker: 'W', daily: dayBar(w2), weekly: cut, suiteParams: loose }).map((x) => x.event_date).includes(mon), false)
  // The next Wednesday, last week is closed → it alerts then.
  const next = wk.slice(0, b.i + 2)
  const w3 = new Date(`${next[next.length - 1].t}T12:00:00Z`); w3.setUTCDate(w3.getUTCDate() + 2)
  eq('a missed Friday still alerts the next week', entryEvents({ ticker: 'W', daily: dayBar(w3), weekly: next, suiteParams: loose }).map((x) => x.event_date).includes(mon), true)
}

console.log(`entry-event checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
