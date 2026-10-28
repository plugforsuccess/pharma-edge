// node research/preearnings-runup/check.mjs — the engine's checks on fixtures.
import { RULES, edgarTiming, confirm, sessionsFor, bsDelta, pickExpiry, pickByDelta, liquidityOk, buyPrice, sellPrice, tradeResult, controlLs, bootstrapMean, holm, metrics, grade, grid, isPrimary, weekKey } from './lib.mjs'
let pass = 0, fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m) } }
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

// timing (EDGAR acceptance is UTC; summer = EDT, UTC−4; winter = EST, UTC−5)
ok(edgarTiming('2024-07-24T20:05:22.000Z').timing === 'AMC' && edgarTiming('2024-07-24T20:05:22.000Z').date === '2024-07-24', '20:05Z in July is 4:05 pm EDT, after the close')
ok(edgarTiming('2024-01-24T21:05:00.000Z').timing === 'AMC', '21:05Z in January is 4:05 pm EST')
ok(edgarTiming('2024-01-24T20:05:00.000Z').timing === 'DMH', '20:05Z in January is 3:05 pm EST, during market')
ok(edgarTiming('2024-07-24T11:01:00.000Z').timing === 'BMO', '11:01Z in July is 7:01 am, before the open')
ok(edgarTiming('2024-07-25T02:30:00.000Z').date === '2024-07-24' && edgarTiming('2024-07-25T02:30:00.000Z').timing === 'AMC', 'a 10:30 pm ET filing stays on its Eastern date')
ok(edgarTiming('2024-03-10T06:59:00.000Z').minutes === 1 * 60 + 59 && edgarTiming('2024-03-10T07:00:00.000Z').minutes === 3 * 60, 'spring-forward at 2 am')
ok(edgarTiming('2024-11-03T05:59:00.000Z').minutes === 60 + 59 && edgarTiming('2024-11-03T06:00:00.000Z').minutes === 60, 'fall-back at 2 am')
ok(edgarTiming('2024-07-24T20:00:00.000Z').timing === 'AMC', '4:00 pm counts as after the close')
const e = edgarTiming('2024-07-24T20:05:22.000Z')
ok(confirm(e, { date: '2024-07-24', timing: 'AMC' }).status === 'confirmed', 'two sources agree')
ok(confirm(e, { date: '2024-07-24', timing: 'BMO' }).status === 'timing-mismatch', 'timing disagreement is not used')
ok(confirm(e, { date: '2024-07-25', timing: 'AMC' }).status === 'date-mismatch', 'date disagreement is not used')
ok(confirm(e, null).status === 'one-source', 'one source is not confirmed')
const S = ['2024-07-22', '2024-07-23', '2024-07-24', '2024-07-25', '2024-07-26']
ok(JSON.stringify(sessionsFor(S, '2024-07-24', 'AMC')) === '{"L":2,"after":3}', 'AMC: L is the report day')
ok(JSON.stringify(sessionsFor(S, '2024-07-24', 'BMO')) === '{"L":1,"after":2}', 'BMO: L is the session before')

// contracts
ok(near(bsDelta(100, 100, 0.5, 0.3, 'call') - bsDelta(100, 100, 0.5, 0.3, 'put'), 1, 1e-6), 'put-call delta parity')
ok(pickExpiry(['2024-07-26', '2024-07-19', '2024-08-02'], '2024-07-25') === '2024-07-26', 'first expiry after the release')
ok(pickExpiry(['2024-07-25'], '2024-07-25') === '2024-07-25', 'an expiry on the after session counts')
const chain = [95, 100, 105, 110].map((k) => ({ expiry: '2024-07-26', strike: k, type: 'put', bid: 1, ask: 1.05, iv: 0.5, delta: null, oi: 900, prevVol: 300 }))
const p20 = pickByDelta(chain, { type: 'put', target: 0.20, expiry: '2024-07-26', spot: 105, asOf: '2024-07-24' })
const dels = chain.map((c) => Math.abs(bsDelta(105, c.strike, 2 / 365, 0.5, 'put')))
const want = chain[dels.map((d) => Math.abs(d - 0.2)).reduce((bi, d, i, a) => (d < a[bi] ? i : bi), 0)].strike
ok(p20 && p20.strike === want, `delta pick from Black-Scholes when the vendor has none (${p20?.strike} vs ${want})`)
ok(pickByDelta([{ ...chain[0], delta: -0.21 }, { ...chain[1], delta: -0.19 }], { type: 'put', target: 0.20, expiry: '2024-07-26', spot: 100, asOf: '2024-07-24' }).strike === 100, 'tie goes nearer the money')
const good = { bid: 2.6, ask: 2.74, oi: 800, prevVol: 400 }
ok(liquidityOk(good, 50000) === null, 'liquid contract passes')
ok(liquidityOk({ ...good, ask: 3.0 }, 50000) === 'spread over 10% of mid', 'wide spread fails')
ok(liquidityOk(good, 1000) === 'underlying option volume', 'thin underlying fails')
ok(liquidityOk({ ...good, oi: 100 }, 50000) === 'open interest', 'low OI fails')
ok(liquidityOk({ bid: 0.1, ask: 0.11, oi: 900, prevVol: 900 }, 50000) === 'mid under $0.20', 'penny option fails')

// fills and returns
const q = { bid: 2.6, ask: 2.74 }
ok(near(buyPrice(q), 2.705) && near(sellPrice(q), 2.635), 'realistic fills: 25% of the spread inside')
ok(buyPrice(q, 'worst') === 2.74 && sellPrice(q, 'worst') === 2.6, 'worst fills: ask in, bid out')
const owner = tradeResult([{ entry: { bid: 2.62, ask: 2.72 }, exit: { bid: 3.83, ask: 3.93 } }])
// buy 2.695 → 3 contracts of $270.20; sell 3.855
ok(owner.contracts === 3 && near(owner.cost, 3 * 270.2) && near(owner.proceeds, 3 * (385.5 - 0.7)), 'owner-like trade sized at $1,000')
ok(near(owner.ret, (3 * 384.8) / (3 * 270.2) - 1), `return after fees (${(owner.ret * 100).toFixed(1)}%)`)
ok(tradeResult([{ entry: { bid: 11, ask: 11.2 }, exit: q }]).skip === 'one contract over the budget', 'skip when one contract is over $1,000')
const strad = tradeResult([{ entry: { bid: 1, ask: 1.1 }, exit: { bid: 0, ask: 0.05 } }, { entry: { bid: 1, ask: 1.1 }, exit: { bid: 2.5, ask: 2.6 } }])
ok(strad.contracts === 4 && strad.ret > 0, 'straddle sized on both legs, worthless leg sells at bid + 25%')

// controls
const sess = Array.from({ length: 400 }, (_, i) => new Date(Date.UTC(2023, 0, 2) + Math.floor(i / 5) * 7 * 86400e3 + (i % 5) * 86400e3).toISOString().slice(0, 10))
const reals = [60, 125, 190, 255, 320]
const c1 = controlLs(sess, reals, 125), c2 = controlLs(sess, reals, 125)
ok(c1.length === 3 && JSON.stringify(c1) === JSON.stringify(c2), 'controls are deterministic')
ok(c1.every((i) => reals.every((r) => Math.abs(i - r) >= 15)), 'controls sit ≥ 15 sessions from every real report')
ok(c1.every((i) => new Date(`${sess[i]}T12:00:00Z`).getUTCDay() === new Date(`${sess[125]}T12:00:00Z`).getUTCDay()), 'controls keep the weekday')

// statistics
ok(weekKey('2024-07-24') === '2024-W30' && weekKey('2024-12-30') === '2025-W01', 'ISO weeks')
const pos = Array.from({ length: 200 }, (_, i) => ({ cluster: `w${i % 40}`, x: 0.05 + (i % 7 - 3) * 0.01 }))
const bp = bootstrapMean(pos, { reps: 2000 })
ok(bp.lo > 0 && bp.p === 0, 'clearly positive mean has a positive lower bound')
const zero = Array.from({ length: 200 }, (_, i) => ({ cluster: `w${i % 40}`, x: (i % 2 ? 1 : -1) * 0.2 }))
const bz = bootstrapMean(zero, { reps: 2000 })
ok(bz.lo < 0 && bz.hi > 0, 'zero mean straddles zero')
const H = holm({ a: 0.001, b: 0.03, c: 0.04 })
ok(H.has('a') && !H.has('b') && !H.has('c'), 'Holm: 0.03 > 0.05/2 stops the chain')
ok(holm({ a: 0.01, b: 0.02 }).size === 2, 'Holm: both survive')
const tr = (rets) => rets.map((r, i) => ({ date: `2025-0${1 + (i % 9)}-1${i % 10}`, ret: r, pnl: r * 1000, tk: 'X' }))
const mt = metrics(tr([0.5, -0.2, 0.1, -0.4, 0.3, 2, -0.1]))
ok(mt.n === 7 && near(mt.win, 4 / 7) && mt.worst5[0].ret === -0.4 && mt.maxDrawdown < 0, 'metrics')
ok(near(mt.withoutTop5, (-0.2 + -0.4) / 2), 'top-5 removal')
const lucky = tr([...Array(120).fill(-0.05), 5, 5, 5, 5, 5])
ok(grade(lucky, tr(Array(300).fill(-0.1))).checks.outliers === false, 'five outliers carrying it fail the outlier check')
const real = tr(Array.from({ length: 150 }, (_, i) => 0.08 + ((i % 5) - 2) * 0.02))
const g = grade(real, tr(Array.from({ length: 300 }, (_, i) => ((i % 5) - 2) * 0.02)))
ok(g.verdict === 'pass', `a steady edge passes (${JSON.stringify(g.checks)})`)
ok(grade(tr(Array(50).fill(0.1)), []).verdict === 'inconclusive', 'under 100 is inconclusive')
ok(grade(real, tr(Array(300).fill(0.2))).checks.control === false, 'losing to the control fails')

// grid
const G = grid()
ok(G.length === 100, `100 cells (${G.length})`)
ok(G.filter(isPrimary).length === 1 && G.find(isPrimary).key === 'put|0.2|same-day|pre-release', 'one primary: the owner trade')
ok(G.filter((v) => v.amcOnly).length === 20, 'same-day cells are AMC only')
ok(RULES.oosFrom === '2025-05-01', 'held-out period fixed')
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
