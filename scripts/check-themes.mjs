// npm run themes:check — src/utils/themes.js
import { themeOf, returnsByDate, corrByDate, betsOf, THEMES } from '../src/utils/themes.js'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL', name) } }
const day = (i) => new Date(Date.UTC(2026, 0, 2) + i * 86400e3).toISOString().slice(0, 10)
let seed = 7
const R = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5
const walk = (rets) => { let p = 100; return rets.map((r, i) => ({ t: day(i), c: (p *= Math.exp(r)) })) }
const n = 200
const chips = Array.from({ length: n }, () => R() * 0.04)
const oil = Array.from({ length: n }, () => R() * 0.04)
const broadTech = chips.map((r) => r * 0.7 + R() * 0.012)
const funds = new Map([
  ['SMH', returnsByDate(walk(chips))],
  ['XOP', returnsByDate(walk(oil))],
  ['XLK', returnsByDate(walk(broadTech))],
])
const chipStock = walk(chips.map((r) => r + R() * 0.01))
const oilStock = walk(oil.map((r) => r * 1.2 + R() * 0.01))
const loner = walk(Array.from({ length: n }, () => R() * 0.04))
ok('a chip stock is Chips', themeOf('MU', chipStock, funds)?.name === 'Chips & AI')
ok('an oil stock is Oil', themeOf('APA', oilStock, funds)?.name === 'Oil')
ok('a stock moving on its own has no theme', themeOf('BE', loner, funds) === null)
ok('a theme fund names itself', themeOf('XOP', oilStock, funds)?.name === 'Oil')
ok('a broad fund loses to an industry fund within the penalty', themeOf('AMD', walk(chips.map((r) => r * 0.85 + R() * 0.006)), funds)?.etf === 'SMH')
ok('corr null under 40 shared days', corrByDate(returnsByDate(walk(chips.slice(0, 30))), funds.get('SMH')) === null)
ok('every theme has a fund and a name', THEMES.every(([e, nm]) => e && nm))
const bets = betsOf([
  { ticker: 'SNDK', theme: 'Chips' }, { ticker: 'LITE', theme: null }, { ticker: 'MU', theme: 'Chips' },
  { ticker: 'VLO', theme: 'Refiners' }, { ticker: 'BE', theme: 'Solar' }, { ticker: 'PSX', theme: 'Refiners' },
])
ok('bets: shared themes group, singles stand alone', bets.length === 4 && bets[0].name === 'Chips' && bets[0].tickers.join() === 'SNDK,MU')
ok('bets: a lone theme counts as its ticker', bets.some((b) => b.alone && b.name === 'BE'))
console.log(`${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
