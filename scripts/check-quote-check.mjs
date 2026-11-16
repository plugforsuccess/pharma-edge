import { spreadQuote, quoteSummary } from '../src/utils/quoteCheck.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
const bars = Array.from({ length: 120 }, (_, i) => { const c = 10 * (1 + 0.05 * (i % 2 ? 1 : -1)); return { t: day(i), o: c, h: c, l: c, c, v: 1e6 } })
const S = 10
const calls = [8, 9, 10, 10.5, 11, 12, 13, 14, 15].map((k) => ({ strike: k, bid: Math.max(0, Math.max(0.05, S - k + 1) - 0.1), ask: Math.max(0.05, S - k + 1) + 0.1, iv: 1.0, oi: 100 }))
const q = spreadQuote(bars, { spot: S, expiry: '2026-12-18', dte: 30, calls })
ok(q.ok && q.quoted && q.k1 === 10, 'short leg = first listed strike at or above the price')
ok(q.k2 > q.k1 && q.width === q.k2 - q.k1, 'long leg above, width from listed strikes')
ok(q.model > 0 && q.realMid != null && Math.abs(q.realNatural - (q.bid1 - q.ask2)) < 1e-9, 'model, mid and natural credits')
ok(spreadQuote(bars, { spot: S, dte: 30, calls: [] }).ok === false && spreadQuote(bars, { spot: S, dte: 30, calls: [{ strike: 8 }, { strike: 9 }] }).reason === 'no ATM strike', 'no chain / no ATM strike')
const noQuote = spreadQuote(bars, { spot: S, dte: 30, calls: calls.map((c) => ({ ...c, bid: 0, ask: 0 })) })
ok(noQuote.ok && !noQuote.quoted && noQuote.realMid == null, 'no bids → not quoted')
const s = quoteSummary([{ ...q, ticker: 'A' }, { ...noQuote, ticker: 'B' }, { ok: false, ticker: 'C' }])
ok(s.stocks === 3 && s.withChain === 2 && s.quoted === 1 && Math.abs(s.midVsModel - q.realMid / q.model) < 1e-9, 'summary counts and ratio')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
