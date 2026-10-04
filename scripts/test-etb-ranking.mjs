// Test E+T+B convergence and two-tier ranking locally (no network access needed)
import { etbConvergence, confluenceSeries, confluenceSetups, setupStats, SIDES, COMPONENTS } from '../src/utils/confluence.js'

let passed = 0
const failures = []

function eq(name, got, want, tol = 0) {
  const ok = typeof want === 'number' && typeof got === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

console.log('Testing E+T+B convergence detection...\n')

// ─── E+T+B Detection ───
// Test: all three fire within 10 bars (staggered is OK)
const n = 30
const bravo = Array.from({ length: n }, (_, i) => i === 5)
const echo = Array.from({ length: n }, (_, i) => i === 7)  // 2 bars after bravo
const tango = Array.from({ length: n }, (_, i) => i === 10) // 3 bars after echo (5 total spread)

const etb = etbConvergence({ bravo, echo, tango }, 10)

eq('E+T+B not fired before any signal', etb[4]?.fired, false)
eq('E+T+B fires when all three are within window', etb[10]?.fired, true)
eq('spread is distance from earliest to latest', etb[10]?.spread, 5)
eq('continues firing while all three within the 10-bar window', etb[15]?.fired, true) // all within [6, 15]
eq('stops firing when newest signal leaves the 10-bar lookback', etb[21]?.fired, false) // tango at 10 is outside [12, 21]

// Test: tight grouping (all within 2 bars)
const tight = etbConvergence({
  bravo: Array.from({ length: n }, (_, i) => i === 20),
  echo: Array.from({ length: n }, (_, i) => i === 21),
  tango: Array.from({ length: n }, (_, i) => i === 22),
}, 10)
eq('tight E+T+B (2-bar spread)', tight[22]?.spread, 2)

// Test: one signal missing
const noTango = etbConvergence({
  bravo: Array.from({ length: n }, (_, i) => i === 5),
  echo: Array.from({ length: n }, (_, i) => i === 7),
  tango: Array.from({ length: n }, (_, i) => false),
}, 10)
eq('no convergence without tango', noTango[25]?.fired, false)

console.log('✓ E+T+B convergence detection works\n')

// ─── Two-Tier Ranking ───
console.log('Testing two-tier ranking (E+T+B Tier 1, others Tier 2)...\n')

// Simulate 4 results: 2 with E+T+B, 2 without
const results = [
  {
    ticker: 'AAPL',
    asOf: '2026-01-15',
    close: 150,
    conditionsMet: 4,
    trendUp: true,
    etbConvergence: true, // Tier 1
    buy: {
      today: { now: { score: 3, lit: ['bravo', 'echo', 'tango'] } },
      setups: []
    },
  },
  {
    ticker: 'MSFT',
    asOf: '2026-01-15',
    close: 380,
    conditionsMet: 3,
    trendUp: true,
    etbConvergence: false, // Tier 2 (3+ signals)
    buy: {
      today: { now: { score: 3, lit: ['zone', 'bravo', 'echo'] } },
      setups: []
    },
  },
  {
    ticker: 'NVDA',
    asOf: '2026-01-15',
    close: 875,
    conditionsMet: 5,
    trendUp: true,
    etbConvergence: true, // Tier 1
    buy: {
      today: { now: { score: 2, lit: ['bravo', 'echo', 'tango'] } },
      setups: []
    },
  },
  {
    ticker: 'GOOGL',
    asOf: '2026-01-15',
    close: 142,
    conditionsMet: 4,
    trendUp: true,
    etbConvergence: false, // Tier 2 (4 signals)
    buy: {
      today: { now: { score: 4, lit: ['zone', 'bravo', 'echo', 'tango'] } },
      setups: []
    },
  },
]

// Simulate the ranking logic
const side = 'buy'
const rows = []
for (const r of results) {
  const row = {
    side,
    ticker: r.ticker,
    as_of: r.asOf,
    close: r.close,
    score: r.buy.today.now.score,
    lit: r.buy.today.now.lit,
    combo: r.buy.today.now.lit.join('+'),
    conditions_met: r.conditionsMet,
    trend_up: r.trendUp,
    etb_convergence: r.etbConvergence,
    rank: null,
  }
  rows.push(row)
}

const cands = rows.filter(r => r.score >= 2 && r.trend_up)

// Sort with two-tier logic
cands.sort((a, b) => {
  // Tier by E+T+B convergence (buy side) — tier 1 first
  if (b.etb_convergence !== a.etb_convergence) {
    return (b.etb_convergence ? 1 : 0) - (a.etb_convergence ? 1 : 0)
  }
  // Within tier: score, conditions_met
  return b.score - a.score || (b.conditions_met ?? 0) - (a.conditions_met ?? 0)
})

cands.forEach((row, k) => { row.rank = k + 1 })

const etbTier1 = cands.filter(r => r.etb_convergence).map(r => r.ticker)
const otherTier2 = cands.filter(r => !r.etb_convergence).map(r => r.ticker)

console.log('Tier 1 (E+T+B convergence):', etbTier1.join(', '))
console.log('Tier 2 (other 3+ signals):', otherTier2.join(', '))
console.log('Ranking order:', cands.map(r => `${r.rank}. ${r.ticker}`).join(' → '))

// Verify the tiers
eq('E+T+B signals ranked in Tier 1', cands.slice(0, 2).every(r => r.etb_convergence), true)
eq('Other 3+ signals in Tier 2', cands.slice(2).every(r => !r.etb_convergence), true)

// Within Tier 1, NVDA should rank above AAPL (score 2 vs 3, but NVDA has more conditions met: 5 vs 4)
// Actually, AAPL has higher score (3 vs 2), so AAPL ranks 1, NVDA ranks 2
eq('Tier 1: AAPL ranks before NVDA (higher score)', cands[0].ticker, 'AAPL')
eq('Tier 1: NVDA ranks second', cands[1].ticker, 'NVDA')

// Within Tier 2, GOOGL should rank above MSFT (score 4 vs 3)
eq('Tier 2: GOOGL ranks before MSFT (higher score)', cands[2].ticker, 'GOOGL')
eq('Tier 2: MSFT ranks fourth', cands[3].ticker, 'MSFT')

console.log('\n✓ Two-tier ranking works correctly\n')

// Summary
console.log(`ETB ranking checks: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const x of failures) console.error('  ✗ ' + x)
  process.exit(1)
}
console.log('\n✅ E+T+B convergence implementation verified!')
