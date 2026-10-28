// A universe built from SEC data, never hand-picked (Fade Screen test):
// every filer whose public float (dei:EntityPublicFloat, the mid-year
// instant frame) sat in a range in any of the given years, mapped to a
// listed ticker; then each company's facts fetched one at a time and kept
// only in compact form (companyfacts JSON runs to megabytes per company).
import { secJson, cikMap, mergeFacts, PREDECESSOR_CIKS } from './sec.mjs'
import { mapLimit } from './marketData.mjs'
import { compactFacts } from '../../src/utils/fade.js'

// → Map cik → { float, year } for filers with float in [min, max] in any year.
export async function publicFloatCiks({ years, min, max, log = console.log }) {
  const out = new Map()
  for (const y of years) {
    const j = await secJson(`https://data.sec.gov/api/xbrl/frames/dei/EntityPublicFloat/USD/CY${y}Q2I.json`)
    const rows = j?.data ?? []
    let n = 0
    for (const r of rows) if (r.val >= min && r.val <= max) { n++; const cik = String(r.cik).padStart(10, '0'); if (!out.has(cik)) out.set(cik, { float: r.val, year: y, last: y }); else out.get(cik).last = y }
    log(`  float frame CY${y}Q2I: ${rows.length} filers, ${n} in range`)
  }
  return out
}

// cik → ticker (the first listed class), for the CIKs given.
export async function tickersFor(ciks) {
  const map = await cikMap()
  const byCik = new Map()
  for (const [tk, cik] of map) if (ciks.has(cik) && !byCik.has(cik) && /^[A-Z][A-Z0-9.]{0,5}$/.test(tk)) byCik.set(cik, tk)
  return byCik
}

// Compact facts per ticker, streamed. → { fin: Map ticker → compact, ok, failed }
export async function compactFactsFor(entries, { log = console.log } = {}) {
  const fin = new Map()
  let ok = 0, failed = 0, done = 0
  await mapLimit(entries, 2, async ({ cik, ticker }) => {
    const all = []
    for (const c of [cik, ...(PREDECESSOR_CIKS[ticker] ?? [])]) all.push(await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${c}.json`))
    const f = mergeFacts(all)
    // PROBE_TAGS=AIRJ,… prints every cash-flow-sized duration tag filed in the
    // last year, to find a company's own name for a line (owner, 2026-10-26).
    if (f && (process.env.PROBE_TAGS ?? '').split(',').includes(ticker)) {
      const since = new Date(Date.now() - 400 * 86400e3).toISOString().slice(0, 10)
      for (const [ns, tags] of Object.entries(f.facts ?? {})) for (const [tag, v] of Object.entries(tags ?? {})) {
        const rows = (v?.units?.USD ?? []).filter((r) => r.start && r.filed >= since && Math.abs(r.val) >= 5e5)
        if (rows.length) log(`  PROBE ${ticker} ${ns}:${tag} ${rows.slice(-3).map((r) => `${r.start}→${r.end} ${Math.round(r.val / 1e5) / 10}M`).join(' | ')}`)
      }
    }
    if (f) { fin.set(ticker, compactFacts(f)); ok++ } else failed++
    if (++done % 200 === 0) log(`  facts ${done}/${entries.length} · ${failed} failed`)
  }, 300)
  return { fin, ok, failed }
}
