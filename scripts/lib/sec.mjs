// SEC EDGAR fetches for the cash-flow quality check (src/utils/quality.js).
// SEC asks for a User-Agent naming the caller and ≤ 10 requests a second; it
// throttles bursts, so every call backs off (up to ~1 min) before giving up.
import { mapLimit } from './marketData.mjs'

const UA = process.env.SEC_USER_AGENT || 'Cash Moves research admin@cashmoves.io'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const secStatus = {}

export async function secJson(url) {
  for (let a = 0; a < 7; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
      if (r.ok) return await r.json()
      secStatus[r.status] = (secStatus[r.status] ?? 0) + 1
      if (r.status === 404) return null
    } catch { secStatus.error = (secStatus.error ?? 0) + 1 }
    await sleep(Math.min(30000, 2000 * 2 ** a))
  }
  return null
}

// Ticker → 10-digit CIK (share classes as BRK.B).
export async function cikMap() {
  const out = new Map()
  const j = await secJson('https://www.sec.gov/files/company_tickers.json')
  for (const v of Object.values(j ?? {})) out.set(String(v.ticker).toUpperCase().replace(/-/g, '.'), String(v.cik_str).padStart(10, '0'))
  return out
}

// A ticker whose SEC record moved to a new holding company keeps its history
// under the old CIK (XOM → ExxonMobil Holdings Corp in 2026, which has only
// 10-Qs so far; Exxon Mobil Corp's 10-Ks stay under 34088). Both are fetched
// and merged, so the latest annual report on file is found either way.
export const PREDECESSOR_CIKS = Object.freeze({ XOM: ['0000034088'] })

// Concatenate every tag's rows across records (each fact keeps its own
// filed date, so point-in-time reads are unchanged).
export function mergeFacts(list) {
  const parts = list.filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? null
  const out = { ...parts[0], facts: {} }
  for (const f of parts) for (const [ns, tags] of Object.entries(f.facts ?? {})) {
    out.facts[ns] ??= {}
    for (const [tag, v] of Object.entries(tags)) {
      const cur = out.facts[ns][tag] ??= { ...v, units: {} }
      for (const [unit, rows] of Object.entries(v.units ?? {})) cur.units[unit] = [...(cur.units[unit] ?? []), ...rows]
    }
  }
  return out
}

// companyfacts per ticker → Map ticker → facts (null when not an SEC filer or
// the fetch failed). Returns { facts, ok, missing, notFiler }.
export async function companyFacts(tickers, ciks) {
  const facts = new Map()
  let ok = 0, missing = 0, notFiler = 0
  await mapLimit(tickers, 2, async (tk) => {
    const cik = ciks.get(tk)
    if (!cik) { notFiler++; facts.set(tk, null); return }
    const all = []
    for (const c of [cik, ...(PREDECESSOR_CIKS[tk] ?? [])]) all.push(await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${c}.json`))
    const f = mergeFacts(all)
    facts.set(tk, f)
    if (f) ok++; else missing++
  }, 300)
  return { facts, ok, missing, notFiler }
}
