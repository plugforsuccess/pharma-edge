// FINRA consolidated short interest (twice-monthly settlement dates) through
// the public Query API: POST api.finra.org/data/group/otcMarket/name/
// consolidatedShortInterest, filtered by symbol. No key is needed for this
// public dataset; when FINRA refuses the runner the caller is told (null)
// rather than guessing. Under load FINRA answers 200 with an empty body or
// 429 / 5xx — each page is retried with backoff before giving up on the
// symbol. → [{ date, shares }] oldest first.
const URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest'
export const finraStatus = {}
const count = (k) => { finraStatus[k] = (finraStatus[k] ?? 0) + 1 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function page(symbol, offset) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(1500 * 2 ** (attempt - 1))
    let r
    try {
      r = await fetch(URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ limit: 5000, offset, fields: ['settlementDate', 'currentShortPositionQuantity'], compareFilters: [{ compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: symbol }] }),
      })
    } catch { count('error'); continue }
    if (r.status === 429 || r.status >= 500) { count(r.status); continue }
    if (!r.ok) { count(r.status); return null }
    const text = await r.text()
    if (!text.trim()) { count('empty'); continue }
    try { const rows = JSON.parse(text); return Array.isArray(rows) ? rows : null } catch { count('badjson'); continue }
  }
  return null
}

export async function shortInterest(symbol) {
  const out = []
  for (let offset = 0; offset < 20000; offset += 5000) {
    const rows = await page(symbol, offset)
    if (!rows) return null
    for (const x of rows) { const d = String(x.settlementDate ?? '').slice(0, 10); const s = Number(x.currentShortPositionQuantity); if (d && Number.isFinite(s)) out.push({ date: d, shares: s }) }
    if (rows.length < 5000) break
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}
