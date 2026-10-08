// npm run orderflow:backtest -- [options]
//
// Historical validation for NIGHTFLOW (src/utils/orderflow/backtest.js).
// Sources:
//   --db --symbols AIRJ,NAUT --from 2026-10-01 --to 2026-10-31
//        recorded prints + quotes (orderflow_prints / orderflow_quotes);
//        needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment
//   --file days.jsonl   one JSON object per line: { symbol, date, events: [...] }
//                       (events as the engine takes them: kind quote|trade|book)
//   --synthetic         the scripted demo scenarios — a PIPELINE CHECK ONLY,
//                       never evidence that the detectors work on real markets
// Options: --drop 0.15 (selloff size), --horizon 60 (minutes),
//          --lead 30 (minutes an alert may precede the peak), --fp 0.05,
//          --out orderflow-backtest.json
//
// Signals come from causal snapshots only; hindsight labels selloffs for
// grading. The score threshold is fitted on the earliest 70% of dates and
// reported on the rest. Include failed breakouts and winners, not just
// collapses, or the false-positive rate means nothing.
import { readFileSync, writeFileSync } from 'node:fs'
import { walkForward, generateScenario, SCENARIOS, sessionOf } from '../src/utils/orderflow/index.js'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d }
const has = (k) => args.includes(`--${k}`)
const gradeOpts = { dropPct: Number(opt('drop', 0.15)), horizonMs: Number(opt('horizon', 60)) * 60_000, leadMs: Number(opt('lead', 30)) * 60_000, fpDrop: Number(opt('fp', 0.05)) }

async function fromDb() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  const symbols = String(opt('symbols', '')).split(',').filter(Boolean)
  const from = Date.parse(`${opt('from')}T00:00:00Z`), to = Date.parse(`${opt('to')}T23:59:59Z`)
  const get = async (table, cols, sym) => {
    const rows = []
    for (let off = 0; ; off += 1000) {
      const r = await fetch(`${url}/rest/v1/${table}?select=${cols}&symbol=eq.${sym}&t_ms=gte.${from}&t_ms=lte.${to}&order=t_ms`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${off}-${off + 999}` } })
      if (!r.ok) throw new Error(`${table} ${r.status}`)
      const page = await r.json()
      rows.push(...page)
      if (page.length < 1000) return rows
    }
  }
  const days = []
  for (const sym of symbols) {
    const [prints, quotes] = await Promise.all([get('orderflow_prints', 't_ms,price,size,type,src_id,bid,ask,conds,eth,valid', sym), get('orderflow_quotes', 't_ms,bid,ask,bid_size,ask_size', sym)])
    const ev = [
      ...quotes.map((q) => ({ kind: 'quote', t: +q.t_ms, bid: +q.bid, ask: +q.ask, bidSize: q.bid_size == null ? null : +q.bid_size, askSize: q.ask_size == null ? null : +q.ask_size })),
      ...prints.map((p) => ({ kind: 'trade', t: +p.t_ms, price: +p.price, size: +p.size, type: p.type, id: p.src_id, bid: p.bid == null ? null : +p.bid, ask: p.ask == null ? null : +p.ask, conds: p.conds ?? '', eth: p.eth, valid: p.valid })),
    ].sort((a, b) => a.t - b.t)
    const byDay = new Map()
    for (const e of ev) {
      if (sessionOf(e.t) === 'closed') continue
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(e.t))
      if (!byDay.has(d)) byDay.set(d, [])
      byDay.get(d).push(e)
    }
    for (const [date, events] of byDay) days.push({ symbol: sym, date, events, source: 'replay' })
    console.log(`${sym}: ${prints.length} prints, ${quotes.length} quotes, ${byDay.size} days`)
  }
  return days
}

function fromFile(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((d) => ({ source: 'replay', ...d }))
}

function synthetic() {
  console.log('SYNTHETIC PIPELINE CHECK — generated data; these numbers say nothing about real markets.')
  const names = Object.keys(SCENARIOS).filter((n) => n !== 'quiet')
  return Array.from({ length: 12 }, (_, i) => {
    const g = generateScenario(names[i % names.length], { seed: 100 + i })
    return { symbol: 'DEMO', date: `2026-09-${String(i + 1).padStart(2, '0')}`, events: g.events, source: 'synthetic' }
  })
}

const days = has('db') ? await fromDb() : opt('file') ? fromFile(opt('file')) : has('synthetic') ? synthetic() : null
if (!days) { console.error('choose a source: --db …, --file days.jsonl or --synthetic'); process.exit(2) }
if (new Set(days.map((d) => d.date)).size < 2) { console.error('need at least 2 distinct dates (train + test)'); process.exit(2) }

const wf = walkForward(days, { gradeOpts })
const line = (name, g) => g && console.log(`${name.padEnd(22)} selloffs ${g.selloffs} · preceded ${g.coverage == null ? '—' : `${Math.round(g.coverage * 100)}%`} · signals ${g.signals} · false+ ${g.falsePositiveRate == null ? '—' : `${Math.round(g.falsePositiveRate * 100)}%`} · median time to reversal ${g.medianReversalMin == null ? '—' : `${g.medianReversalMin.toFixed(1)} min`} · MAE med ${g.maeMedian == null ? '—' : `${(g.maeMedian * 100).toFixed(1)}%`} · 15m after ${g.after['15m'].mean == null ? '—' : `${(g.after['15m'].mean * 100).toFixed(1)}%`} · cost ${g.costBpsMedian == null ? '—' : `${g.costBpsMedian.toFixed(0)} bps`}`)
console.log(`\ntrain ${wf.trainDates[0]}…${wf.trainDates.at(-1)} (${wf.trainDates.length} d) → score threshold ${wf.chosenThreshold}`)
line('train (score)', wf.train)
line('test (score)', wf.test)
line('test (sell alerts ≥2)', wf.alertsTest)
if (wf.test) for (const [s, v] of Object.entries(wf.test.bySession)) console.log(`  ${s.padEnd(11)} ${v.n} signals, precision ${Math.round(v.precision * 100)}%`)
const out = opt('out', 'orderflow-backtest.json')
writeFileSync(out, JSON.stringify({ ran_at: new Date().toISOString(), source: has('db') ? 'db' : opt('file') ? 'file' : 'synthetic', gradeOpts, ...wf }, null, 1))
console.log(`\nwrote ${out}`)
