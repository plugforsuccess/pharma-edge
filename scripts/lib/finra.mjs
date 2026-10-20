// FINRA consolidated short interest (twice-monthly settlement dates) through
// the public Query API: POST api.finra.org/data/group/otcMarket/name/
// consolidatedShortInterest, filtered by symbol. No key is needed for this
// public dataset; when FINRA refuses the runner the caller is told (null)
// rather than guessing. → [{ date, shares }] oldest first.
const URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest'
export const finraStatus = {}

export async function shortInterest(symbol) {
  const out = []
  for (let offset = 0; offset < 20000; offset += 5000) {
    let r
    try {
      r = await fetch(URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ limit: 5000, offset, fields: ['settlementDate', 'currentShortPositionQuantity'], compareFilters: [{ compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: symbol }] }),
      })
    } catch (e) { finraStatus.error = (finraStatus.error ?? 0) + 1; return null }
    if (!r.ok) { finraStatus[r.status] = (finraStatus[r.status] ?? 0) + 1; return null }
    const rows = await r.json()
    if (!Array.isArray(rows)) return null
    for (const x of rows) { const d = String(x.settlementDate ?? '').slice(0, 10); const s = Number(x.currentShortPositionQuantity); if (d && Number.isFinite(s)) out.push({ date: d, shares: s }) }
    if (rows.length < 5000) break
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}
