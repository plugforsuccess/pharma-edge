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

// companyfacts per ticker → Map ticker → facts (null when not an SEC filer or
// the fetch failed). Returns { facts, ok, missing, notFiler }.
export async function companyFacts(tickers, ciks) {
  const facts = new Map()
  let ok = 0, missing = 0, notFiler = 0
  await mapLimit(tickers, 2, async (tk) => {
    const cik = ciks.get(tk)
    if (!cik) { notFiler++; facts.set(tk, null); return }
    const f = await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`)
    facts.set(tk, f)
    if (f) ok++; else missing++
  }, 300)
  return { facts, ok, missing, notFiler }
}
