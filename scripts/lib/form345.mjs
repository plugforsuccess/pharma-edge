// SEC Form 3/4/5 bulk data (DERA, one zip per quarter since 2006):
// https://www.sec.gov/files/dera/data/form-345/2024q1_form345.zip →
// SUBMISSION.tsv (accession, filing date, issuer symbol), REPORTINGOWNER.tsv
// (accession → owner CIK) and NONDERIV_TRANS.tsv (each non-derivative
// transaction: date, code S / P / …, shares, price). This loader returns,
// per symbol in `wanted`, the open-market trades as { filed, date, code,
// shares, price, owner } — the input for insiderSignals() in
// src/utils/insiders.js. Quarters that aren't published yet (404) are skipped.
import { createReadStream, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { secJson } from './sec.mjs'

const UA = process.env.SEC_USER_AGENT || 'Cash Moves research admin@cashmoves.io'
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' }
// '15-FEB-2024' / '2024-02-15' / '2024-02-15 00:00:00' → '2024-02-15'
export function isoDate(s) {
  if (!s) return null
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})/i.exec(s)
  if (m) return `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1]}`
  const n = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return n ? n[1] : null
}

export function quartersSince(from = '2021q1', now = new Date()) {
  const out = []
  let [y, q] = [Number(from.slice(0, 4)), Number(from.slice(5))]
  const endY = now.getUTCFullYear(), endQ = Math.floor(now.getUTCMonth() / 3) + 1
  while (y < endY || (y === endY && q <= endQ)) { out.push(`${y}q${q}`); if (++q > 4) { q = 1; y++ } }
  return out
}

// SEC has served these files from two paths over the years; try both and
// say which status each gave, so a missing quarter is never silent.
const URLS = (q) => [
  `https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/${q}_form345.zip`,
  `https://www.sec.gov/files/dera/data/form-345/${q}_form345.zip`,
]
async function download(q, to, log) {
  const seen = []
  for (const url of URLS(q)) {
    for (let a = 0; a < 3; a++) {
      let r
      try { r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/zip,*/*' } }) } catch (e) { seen.push(`error ${e.message}`); await new Promise((res) => setTimeout(res, 3000 * (a + 1))); continue }
      if (r.ok) { writeFileSync(to, Buffer.from(await r.arrayBuffer())); return true }
      seen.push(String(r.status))
      if (r.status === 404 || r.status === 403) break
      await new Promise((res) => setTimeout(res, 3000 * (a + 1)))
    }
  }
  log(`  ${q}: not downloaded (${seen.join(', ')})`)
  return false
}

async function* tsv(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let head = null
  for await (const line of rl) {
    const cells = line.split('\t')
    if (!head) { head = cells.map((h) => h.trim().toUpperCase()); continue }
    const row = {}
    head.forEach((h, i) => { row[h] = cells[i] })
    yield row
  }
}

// wanted: Set of symbols. → { trades: Map symbol → [...], quarters: [loaded], missing: [...] }
export async function loadForm345(wanted, { dir = '.form345', from = '2021q1', log = console.log } = {}) {
  mkdirSync(dir, { recursive: true })
  const trades = new Map(), quarters = [], missing = []
  for (const q of quartersSince(from)) {
    const zip = join(dir, `${q}.zip`)
    if (!existsSync(zip)) {
      const okDl = await download(q, zip, log)
      if (!okDl) { missing.push(q); continue }
    }
    const out = join(dir, q)
    rmSync(out, { recursive: true, force: true })
    try { execFileSync('unzip', ['-o', '-q', zip, '-d', out]) } catch (e) { missing.push(q); log(`  ${q}: unzip failed (${e.message})`); continue }
    const file = (name) => { const f = execFileSync('find', [out, '-iname', name]).toString().trim().split('\n')[0]; return f || null }
    const sub = file('SUBMISSION.tsv'), own = file('REPORTINGOWNER.tsv'), tr = file('NONDERIV_TRANS.tsv')
    if (!sub || !own || !tr) { missing.push(q); log(`  ${q}: files missing`); continue }
    // accession → { filed, symbol } for wanted issuers only
    const acc = new Map()
    for await (const r of tsv(sub)) {
      const sym = (r.ISSUERTRADINGSYMBOL || '').trim().toUpperCase().replace(/-/g, '.')
      if (wanted.has(sym)) acc.set(r.ACCESSION_NUMBER, { filed: isoDate(r.FILING_DATE), symbol: sym })
    }
    const owner = new Map()
    for await (const r of tsv(own)) if (acc.has(r.ACCESSION_NUMBER) && !owner.has(r.ACCESSION_NUMBER)) owner.set(r.ACCESSION_NUMBER, r.RPTOWNERCIK || r.RPTOWNERNAME)
    let n = 0
    for await (const r of tsv(tr)) {
      const a = acc.get(r.ACCESSION_NUMBER)
      if (!a) continue
      const code = (r.TRANS_CODE || '').trim().toUpperCase()
      if (code !== 'S' && code !== 'P') continue
      const shares = Number(r.TRANS_SHARES), price = Number(r.TRANS_PRICEPERSHARE)
      if (!(shares > 0)) continue
      if (!trades.has(a.symbol)) trades.set(a.symbol, [])
      trades.get(a.symbol).push({ filed: a.filed, date: isoDate(r.TRANS_DATE), code, shares, price: price > 0 ? price : 0, owner: owner.get(r.ACCESSION_NUMBER) ?? r.ACCESSION_NUMBER })
      n++
    }
    quarters.push(q)
    log(`  ${q}: ${acc.size} filings on wanted issuers, ${n} open-market trades`)
    rmSync(out, { recursive: true, force: true })
  }
  return { trades, quarters, missing }
}
