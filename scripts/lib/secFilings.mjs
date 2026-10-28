// SEC submissions per company (data.sec.gov/submissions/CIK##########.json):
// every filing with its form type, filing date and, for 8-Ks, the item
// numbers — shelves (S-3), prospectus supplements (424B5) and unregistered
// sales (8-K item 3.02) for the Fade Screen's capital-redirect factor and
// the "raised within 6 months" outcome. Older filings sit in paged files
// named in `filings.files`; pages reaching back to `since` are fetched too.
import { secJson } from './sec.mjs'
import { mapLimit } from './marketData.mjs'

const KEEP = new Set(['S-3', 'S-3ASR', '424B5', '8-K'])
function rowsFrom(block) {
  const out = []
  const n = block?.form?.length ?? 0
  for (let k = 0; k < n; k++) {
    const form = block.form[k]
    if (!KEEP.has(form)) continue
    const items = form === '8-K' ? String(block.items?.[k] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : []
    out.push({ form, date: block.filingDate[k], items })
  }
  return out
}

// → { rows: [{ form, date, items }] oldest first, filings since `since`; sic } —
// `sic` is the company's SIC code from the same feed (a string like '2834').
export async function filingsFor(cik, { since = '2021-01-01' } = {}) {
  const j = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`)
  if (!j) return null
  const sic = j.sic ? String(j.sic) : null
  let rows = rowsFrom(j.filings?.recent)
  for (const f of j.filings?.files ?? []) {
    if (f.filingTo && f.filingTo < since) continue
    const page = await secJson(`https://data.sec.gov/submissions/${f.name}`)
    if (page) rows = rows.concat(rowsFrom(page))
  }
  return { rows: rows.filter((r) => r.date >= since).sort((a, b) => a.date.localeCompare(b.date)), sic }
}

// entries: [{ cik, ticker }] → { filings: Map ticker → rows, sics: Map ticker → sic, ok, failed }
export async function filingsMap(entries, { log = console.log } = {}) {
  const filings = new Map(), sics = new Map()
  let ok = 0, failed = 0, done = 0
  await mapLimit(entries, 2, async ({ cik, ticker }) => {
    const got = await filingsFor(cik)
    if (got) { filings.set(ticker, got.rows); sics.set(ticker, got.sic); ok++ } else failed++
    if (++done % 200 === 0) log(`  filings ${done}/${entries.length} · ${failed} failed`)
  }, 300)
  return { filings, sics, ok, failed }
}

// Exit filings (list-entry bear addendum 1): delisting, deregistration, exchange
// notices, bankruptcy, merger / tender — every form since `since`, oldest first.
const EXIT = new Set(['25', '25-NSE', '15-12B', '15-12G', '15-15D', 'DEFM14A', 'SC TO-T', 'SC 14D9', '8-K'])
export async function exitFilingsFor(cik, { since = '2019-01-01' } = {}) {
  const j = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`)
  if (!j) return null
  const take = (b) => { const out = []; for (let k = 0; k < (b?.form?.length ?? 0); k++) { const form = b.form[k]; if (EXIT.has(form)) out.push({ form, date: b.filingDate[k], items: form === '8-K' ? String(b.items?.[k] ?? '').split(',').map((x) => x.trim()).filter(Boolean) : [] }) } return out }
  let rows = take(j.filings?.recent)
  for (const f of j.filings?.files ?? []) {
    if (f.filingTo && f.filingTo < since) continue
    const page = await secJson(`https://data.sec.gov/submissions/${f.name}`)
    if (page) rows = rows.concat(take(page))
  }
  return { name: j.name ?? null, rows: rows.filter((r) => r.date >= since).sort((a, b) => a.date.localeCompare(b.date)) }
}
