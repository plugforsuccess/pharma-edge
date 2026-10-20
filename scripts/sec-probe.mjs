// Research probe (owner, 2026-10-20: "What about companies like $KO and
// $XOM"): for a few tickers, today's Leaders price checks, the cash-flow
// verdict, and which SEC cash-flow / revenue tags the company actually files
// (latest annual period of each) — to find why XOM / APA read "no data".
import { dailyBars } from './lib/marketData.mjs'
import { cikMap, companyFacts } from './lib/sec.mjs'
import { leaderSeries, leaderMisses } from '../src/utils/leaders.js'
import { qualityAt, qualityParams } from '../src/utils/quality.js'
import { trailingVol, OPTION_MODEL } from '../src/utils/replay.js'

const tickers = (process.env.TICKERS || 'XOM,APA,KO').split(',').map((s) => s.trim().toUpperCase())
const oil = new Set(['XOM', 'APA', 'CVX', 'COP', 'OXY'])
const spy = await dailyBars('SPY')
const ciks = await cikMap()
const today = new Date().toISOString().slice(0, 10)
for (const tk of tickers) {
  console.log(`\n=== ${tk}`)
  try {
    const bars = await dailyBars(tk)
    const tr = leaderSeries(bars, spy, { vol: trailingVol(bars.map((b) => b.c), OPTION_MODEL.volBars) }).at(bars.length - 1)
    const p = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)
    console.log(`  price rule: ${leaderMisses(tr).length ? `not a leader (misses ${leaderMisses(tr).join(', ')})` : 'LEADER'} · 12-1 ${p(tr?.mom12)} · vs 200-day ${p(tr?.vs200)} · 200-day slope ${p(tr?.slope200)} · vol rank ${p(tr?.volRank)}`)
  } catch (e) { console.log(`  bars: ${e.message}`) }
  const cik = ciks.get(tk)
  if (!cik) { console.log('  no SEC CIK'); continue }
  const facts = (await companyFacts([tk], ciks)).facts.get(tk)
  if (!facts) { console.log(`  CIK ${cik}: no companyfacts`); continue }
  const g = facts.facts?.['us-gaap'] ?? {}
  const ocf = g.NetCashProvidedByUsedInOperatingActivities?.units?.USD ?? []
  console.log(`  CIK ${cik} · ${facts.entityName} · us-gaap tags ${Object.keys(g).length} · namespaces ${Object.keys(facts.facts ?? {}).join(', ')}`)
  console.log(`  operating cash flow rows ${ocf.length}; latest: ${ocf.slice(-4).map((f) => `${f.form} ${f.start ?? '?'}→${f.end} filed ${f.filed}`).join(' | ')}`)
  const q = qualityAt(facts, today, qualityParams(oil.has(tk) ? 'Oil' : null))
  console.log(`  cash flow (${oil.has(tk) ? 'oil' : 'standard'} rule): ${q.pass ? 'PASS' : `fail ${q.misses.join(', ')}`}${q.why ? ` — ${q.why}` : ''} · FCF margin ${q.fcfMargin == null ? '—' : (q.fcfMargin * 100).toFixed(1) + '%'} · net debt ${q.netDebtYears == null ? '—' : q.netDebtYears.toFixed(1) + ' yrs FCF'} · shares ${q.shareGrowth == null ? '—' : (q.shareGrowth * 100).toFixed(1) + '%'} · FY end ${q.end ?? '—'}`)
  for (const ns of Object.keys(facts.facts ?? {})) {
    const tags = Object.entries(facts.facts[ns]).filter(([k]) => /OperatingActivities|Revenue|Sales|CapitalExpenditure|PropertyPlantAndEquipment|LongTermDebt$|DilutedShares/i.test(k))
    for (const [k, v] of tags) {
      const rows = Object.values(v.units ?? {}).flat().filter((f) => /^10-K/.test(f.form ?? '') && f.start && (Date.parse(f.end) - Date.parse(f.start)) / 864e5 > 330)
      const last = rows.sort((a, b) => a.end.localeCompare(b.end)).pop()
      if (last) console.log(`    ${ns}:${k} · latest annual ${last.start}→${last.end} filed ${last.filed} · ${last.val}`)
    }
  }
}
