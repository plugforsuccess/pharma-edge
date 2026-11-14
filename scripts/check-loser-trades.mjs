import { bearPlan, dollarVol20, BEAR_RECORD, TRADEABLE } from '../src/utils/loserTrades.js'
import { bsPut } from '../src/utils/replay.js'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400e3).toISOString().slice(0, 10)
const mk = (n, base, v) => Array.from({ length: n }, (_, i) => { const c = base * (1 + 0.04 * (i % 2 ? 1 : -1)); return { t: day(i), o: c, h: c, l: c, c, v } })
ok(bearPlan(mk(30, 10, 1e6)) === null, 'too few bars → null')
const b = mk(100, 10, 2e5), pl = bearPlan(b)
ok(pl && pl.price === b.at(-1).c && pl.vol > 0.15, 'price and vol')
ok(Math.abs(pl.put.cost - bsPut(pl.price, pl.price, 126 / 252, pl.vol, 0.04) * 1.02) < 1e-9 && pl.put.breakeven < pl.price, 'put: ATM, 126 days, 2% slip, breakeven below')
ok(pl.spread.short < pl.spread.long && pl.spread.debit > 0 && pl.spread.debit < pl.spread.width && typeof pl.spread.withinCap === 'boolean', 'spread: short strike one expected move lower, debit under width')
ok(Math.abs(dollarVol20(b) - 2e5 * b.slice(-20).reduce((s, x) => s + x.c, 0) / 20) < 1e-3, 'dollar volume over 20 bars')
ok(pl.tradeable === false && pl.why.includes('thin volume'), '~$2M a day is thin volume')
const cheap = bearPlan(mk(100, 2, 1e8))
ok(cheap.tradeable === false && cheap.why[0] === `under $${TRADEABLE.minPrice}`, 'under $3 is not tradeable')
const fine = bearPlan(mk(100, 10, 5e6))
ok(fine.tradeable === true && fine.why.length === 0, '$10 stock, $50M a day → tradeable')
ok(BEAR_RECORD.fresh.put < 0 && BEAR_RECORD.list.short < 0, "recorded results are the tests' (all negative)")
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
