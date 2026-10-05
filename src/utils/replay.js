// Replay (owner, 2026-10-03: "how can the app suggest this trade and signal
// the exit" — NOW +84%). Walks a ticker's history one day at a time, acting
// only on what was known at each close, and trades a LEAPS call the way the
// app would: enter on a buy signal, exit by the exit targets, the sell
// signals, or both. Pure functions; `npm run replay:check` runs
// scripts/check-replay.mjs (which also proves the signals carry no
// look-ahead: each day's flags match a model built on the bars up to that
// day only).
//
// The option is priced, not quoted: Black-Scholes on the stock, a strike at
// the target delta, and the stock's trailing 60-day volatility standing in
// for IV (floored at 15%), with a slippage haircut on every fill. History
// with real option quotes isn't in the app, so these are estimates — they
// show whether the signals line up with the moves, not exact fills.
//
// Hindsight is used only to grade: big moves (a swing low followed by a
// ≥ minGain rise) are found after the fact and checked against the entries
// the replay took live.

import { COMPONENTS, DEFAULT_WINDOW, MIN_SCORE, confluenceFlags, confluenceSeries, swingPoints, etbConvergence } from './confluence.js'
import { tripleEvents } from './signalSuite.js'
import { EXIT_PLAYBOOK } from './afterTax.js'

export const OPTION_MODEL = Object.freeze({
  dte: 730,          // calendar days to expiry at entry (playbook: 18–24+ months)
  delta: 0.75,       // the LDP core sleeve's target delta
  rate: 0.04,
  volBars: 60,       // trailing volatility window (trading days)
  volFloor: 0.15,
  slippage: 0.02,    // 2% of the premium against you on every fill
})

export const ENTRY_RULES = [
  ['confluence', 'Confluence'],
  ['etb', 'E+T+B (1–2 week convergence)'],
  ['zone', 'Buy zone'],
  // The rule as the app presents it (BUY SETUP): the zone turning YES with
  // 2+ confluence signals and the 200-day rising. The pre-registered test
  // (docs/signal-engine/preregistration.md) is about this rule.
  ['setup', 'Buy setup (as shown)'],
  // Triple (owner, 2026-10-05): Bravo + Echo + Tango all bullish within 2
  // bars, no trend gate — logged on Signal record to be measured; its
  // context (drawdown, days the 200-day has risen) rides in replay_trades
  // for the ablation. Not a live rule.
  ['triple', 'Triple ◆'],
  // Confirmed (owner, 2026-10-04: a buy zone YES beside a Bravo bear read as
  // a contradiction): the zone is YES *and* Bravo's regime is bull — the
  // cautious entry, to be measured against the plain zone, not assumed better.
  ['zoneConfirmed', 'Buy zone · momentum up'],
  ['bravo', 'Bravo ◆'],
  // Recovery (owner, 2026-10-04): the universe replay showed the 200-day
  // rule throwing away two-thirds of the +30% rallies (post-crash
  // recoveries — NOW Jun 2026, NVDA 2022). Same 2+ signals, but while the
  // 200-day is still falling and the close is back above the 50-day.
  ['recovery', 'Recovery'],
]
export const EXIT_RULES = [
  ['targets', 'Targets'],
  ['signals', 'Signals'],
  ['both', 'Both'],
  // Swing (owner, 2026-10-05: "identify swing trades, exit at pre-determined
  // high prices"): a stock price target fixed at entry, all out on the first
  // close at or above it, else at a hold cap (a stock stop is a variant).
  // Default = the nearest confirmed pivot high, 126-day cap, no stop. The
  // grid is measured in the pre-registered test (SWING_GRID).
  ['swing', 'Swing (price target)'],
]
// target: 'pivot' = nearest confirmed swing high above entry (≥ SWING_BARS
// bars after it, so known at entry), falling back to +pct when none sits
// within maxPivot; 'pct' = entry × (1 + pct) on the stock; 'opt' = the
// option's mark reaching cost × (1 + pct) (owner, 2026-10-05: with the
// call's leverage a +25–50% option target is met on a 10–15% stock move).
// stopPct: stock stop, null = none. maxHold in trading days.
export const SWING = Object.freeze({ target: 'pivot', pct: 0.15, maxHold: 126, stopPct: null, maxPivot: 0.40, minPivot: 0.02 })
export const SWING_GRID = Object.freeze({
  targets: [['pct', 0.10], ['pct', 0.15], ['pct', 0.20], ['pivot', 0.15], ['opt', 0.25], ['opt', 0.50], ['opt', 0.75]],
  // Hold caps = the owner's window (2026-10-05: "we don't want to hold for
  // more than 2–18 months"): 2, 6, 12 and 18 months in trading days. The
  // 18-month cap coincides with the playbook's time stop on a 2-year call.
  holds: [42, 126, 252, 378], stops: [null, 0.08],
  // Regime gate (owner, 2026-10-05, after the first grids: every version
  // lost in 2022): null = every entry; 'spy200' = only entries signalled
  // while SPY closed above its 200-day average that day.
  gates: [null, 'spy200'],
})
export const SWING_PIVOT_BARS = 10

// The swing target for a trade entered at bar e at price S0: the nearest
// confirmed swing high above entry, else the % target. `highs` = indexes
// from swingPoints(bars, SWING_PIVOT_BARS).
export function swingTargetAt(bars, e, S0, highs, swing = SWING) {
  const pctTarget = S0 * (1 + swing.pct)
  if (swing.target === 'opt') return { target: null, optMult: 1 + swing.pct, kind: 'opt' }
  if (swing.target !== 'pivot' || !highs) return { target: pctTarget, kind: 'pct' }
  let best = null
  for (const h of highs) {
    if (h + SWING_PIVOT_BARS > e - 1) break // not confirmed by the signal bar
    const p = bars[h].h
    if (p >= S0 * (1 + swing.minPivot) && p <= S0 * (1 + swing.maxPivot) && (best == null || p < best)) best = p
  }
  return best != null ? { target: best, kind: 'pivot' } : { target: pctTarget, kind: 'pct' }
}
export const MOVE = Object.freeze({ minGain: 0.3, horizon: 126, early: 10 })

// Puts (owner, 2026-10-03: "have we considered puts?" — tested, not
// suggested). A put debit spread on 2+ sell signals, under the app's
// spread rules: ~90 DTE, long put at the money, short put one expected
// move lower (S·σ·√T), debit ≤ 40% of the width or no trade; +100% → sell
// half, +200% → sell another quarter, −50% → out, out at 21 DTE, and out
// when 2+ buy signals say the thesis flipped. Never held to expiry.
export const PUT_MODEL = Object.freeze({ dte: 90, closeDte: 21, maxDebit: 0.4, stop: -0.5, takes: [[1, 0.5], [2, 0.25]] })
export const BEAR_RULES = [
  ['falling', '200-day falling'],
  ['any', 'Any trend'],
]
export const DROP = Object.freeze({ minDrop: 0.2, horizon: 63, early: 10 })

const DAY_MS = 86400000
const dayMs = (t) => Date.parse(`${t}T00:00:00Z`)

// ── Black-Scholes ──────────────────────────────────────────────────

export function normCdf(x) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

// Inverse normal CDF (Acklam).
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lo) return -normInv(1 - p)
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

export function bsCall(S, K, T, vol, r = OPTION_MODEL.rate, q = 0) {
  if (!(S > 0 && K > 0)) return 0
  if (!(T > 0) || !(vol > 0)) return Math.max(0, S - K)
  const sd = vol * Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r - q + vol * vol / 2) * T) / sd
  return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d1 - sd)
}

// The strike whose call delta is `delta`.
// Put via put-call parity.
export function bsPut(S, K, T, vol, r = OPTION_MODEL.rate) {
  if (!(S > 0 && K > 0)) return 0
  if (!(T > 0) || !(vol > 0)) return Math.max(0, K - S)
  return bsCall(S, K, T, vol, r) - S + K * Math.exp(-r * T)
}

export function strikeForDelta(S, T, vol, delta, r = OPTION_MODEL.rate, q = 0) {
  // With a dividend yield the call delta is e^{-qT} N(d1); solve for d1.
  const d1 = normInv(Math.min(0.999, delta * Math.exp(q * T)))
  return S * Math.exp(-(d1 * vol * Math.sqrt(T) - (r - q + vol * vol / 2) * T))
}

// Trailing annualised volatility of log returns (null until n returns).
export function trailingVol(closes, n = OPTION_MODEL.volBars) {
  const out = new Array(closes.length).fill(null)
  const lr = closes.map((c, i) => (i > 0 && closes[i - 1] > 0 && c > 0 ? Math.log(c / closes[i - 1]) : null))
  for (let i = n; i < closes.length; i++) {
    const w = lr.slice(i - n + 1, i + 1)
    if (w.some((x) => x == null)) continue
    const m = w.reduce((s, x) => s + x, 0) / n
    const v = w.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)
    out[i] = Math.sqrt(v * 252)
  }
  return out
}

// ── Signals the replay acts on (all known at each bar's close) ─────

// entry[rule][i] — a new buy at bar i; sell[i] — a sell signal at bar i.
//   confluence  the buy score reaching MIN_SCORE (from below), 200-day rising
//   zone        the buy zone turning YES
//   bravo       a Bravo bull diamond, 200-day rising
//   recovery    the buy score reaching MIN_SCORE, 200-day falling, close
//               above the 50-day (the rally the trend rule refuses)
//   sell        the sell score at MIN_SCORE or more (one signal alone isn't
//               a setup, on either side)
export function replaySignals(bars, model, suite, window = DEFAULT_WINDOW) {
  const n = bars.length
  const flags = confluenceFlags(model, suite)
  const buy = confluenceSeries(flags.buy, n, window, COMPONENTS.buy.map(([k]) => k))
  const sellS = confluenceSeries(flags.sell, n, window, COMPONENTS.sell.map(([k]) => k))
  const rising = model.slope200.map((s) => s != null && s > 0)
  const falling = model.slope200.map((s) => s != null && s < 0)
  const zone = model.cond.map((c) => !!c?.all)
  const sellOn = sellS.map((s, i) => s.score >= MIN_SCORE && (i === 0 || sellS[i - 1].score < MIN_SCORE))
  // E+T+B convergence: Echo + Tango + Bravo all fired within 10 trading days (1–2 weeks)
  const etbBuy = etbConvergence(flags.buy, 10)
  const etbFired = etbBuy.map((e) => e.fired && e.spread != null && e.spread < 10)
  return {
    buyScore: buy.map((s) => s.score),
    buyKey: buy.map((s) => s.key),
    sellScore: sellS.map((s) => s.score),
    sellKey: sellS.map((s) => s.key),
    rising, falling,
    // Bear entries: the sell score reaching MIN_SCORE (from below).
    bear: { falling: sellOn.map((x, i) => x && falling[i]), any: sellOn },
    buyOn: buy.map((s) => s.score >= MIN_SCORE),
    entry: {
      confluence: buy.map((s, i) => rising[i] && s.score >= MIN_SCORE && (i === 0 || buy[i - 1].score < MIN_SCORE)),
      etb: etbFired.map((fired, i) => fired && rising[i] && (i === 0 || !etbFired[i - 1])),
      zone: zone.map((z, i) => z && !zone[i - 1]),
      setup: zone.map((z, i) => z && rising[i] && buy[i].score >= MIN_SCORE && !(zone[i - 1] && rising[i - 1] && buy[i - 1].score >= MIN_SCORE)),
      zoneConfirmed: zone.map((z, i) => z && suite.bravo.regime[i] === 1 && !(zone[i - 1] && suite.bravo.regime[i - 1] === 1)),
      triple: tripleEvents(suite, 2).bull,
      bravo: suite.bravo.bullOn.map((x, i) => !!x && rising[i]),
      recovery: buy.map((s, i) => !rising[i] && model.s50[i] != null && model.closes[i] > model.s50[i]
        && s.score >= MIN_SCORE && (i === 0 || buy[i - 1].score < MIN_SCORE)),
    },
    sell: sellS.map((s) => s.score >= MIN_SCORE),
  }
}

// ── The replay ─────────────────────────────────────────────────────

// Trades, one at a time: a signal at bar i's close buys at bar i+1's open;
// every later close is checked for exits in this order — time stop (expiry
// within the playbook's rollDays), then targets (sell each target's
// fraction once the call is worth 1 + target × cost), then the runner trail
// (only once every target has hit, as in the app), then the sell signal:
// `signals` sells everything on it; `both` lets it close only what's left
// after target 1 (the targets bank the gain, the signal guards the rest). No hard stop: the playbook cuts on the thesis, which a
// replay can't see. A trade still open on the last bar is marked there.
// Pricing hooks (the pre-registered test, docs/signal-engine/preregistration.md):
//   volAt(i)    vol used to price the entry at signal bar i (default: the
//               trailing realized vol); sticky = true holds that vol through
//               the trade instead of re-marking from trailing realized vol
//   slipAt(i)   slippage per fill for a trade signalled at bar i (default
//               opt.slippage); applied on the entry and on every exit fill
//   yieldAt(i)  continuous dividend yield at bar i (default 0)
//   allowOverlap = true runs every entry as its own trade (controls:
//               SPY-on-the-same-dates, monthly DCA); false = one position at
//               a time, the app's rule
export function oneTrade(bars, closes, sigma, i, { exitRule = 'targets', plan = EXIT_PLAYBOOK, opt = OPTION_MODEL, sell: sellSig = null, volAt = null, sticky = false, slipAt = null, yieldAt = null, swing = SWING, highs = null } = {}) {
  const n = bars.length
  const e = i + 1
  if (e >= n) return null
  const useTargets = exitRule === 'targets' || exitRule === 'both'
  const useSignals = exitRule === 'signals' || exitRule === 'both'
  const useSwing = exitRule === 'swing'
  const S0 = bars[e].o || bars[e].c
  const vIn = volAt ? volAt(i) : sigma[i]
  if (vIn == null) return null
  const v0 = Math.max(opt.volFloor, vIn)
  const q0 = yieldAt ? (yieldAt(i) ?? 0) : 0
  const slip = slipAt ? slipAt(i) : opt.slippage
  const T0 = opt.dte / 365
  const K = strikeForDelta(S0, T0, v0, opt.delta, opt.rate, q0)
  const cost = bsCall(S0, K, T0, v0, opt.rate, q0) * (1 + slip)
  const expiry = dayMs(bars[e].t) + opt.dte * DAY_MS
  const sw = useSwing ? swingTargetAt(bars, e, S0, highs, swing) : null
  let left = 1
  let proceeds = 0
  let stockOut = 0
  let peak = 0
  let maxHigh = bars[e].h
  const hit = plan.targets.map(() => false)
  const exits = []
  const fills = []
  const sell = (j, frac, value, reason) => {
    const f = Math.min(frac, left)
    if (f <= 1e-9) return
    proceeds += f * value * (1 - slip)
    stockOut += f * closes[j]
    left -= f
    exits.push({ i: j, t: bars[j].t, frac: f, value, mult: value / cost, reason })
    fills.push(f * value * slip)
  }
  const markVol = (j) => (sticky ? v0 : Math.max(opt.volFloor, sigma[j] ?? v0))
  const markQ = (j) => (yieldAt ? (yieldAt(j) ?? q0) : 0)
  let j = e
  for (; j < n && left > 1e-9; j++) {
    maxHigh = Math.max(maxHigh, bars[j].h)
    const daysLeft = (expiry - dayMs(bars[j].t)) / DAY_MS
    const v = bsCall(closes[j], K, daysLeft / 365, markVol(j), opt.rate, markQ(j))
    peak = Math.max(peak, v)
    if (daysLeft < plan.rollDays) { sell(j, left, v, 'time'); break }
    if (useSwing) {
      if (sw.kind === 'opt' ? v >= cost * sw.optMult : closes[j] >= sw.target) { sell(j, left, v, 'target'); break }
      if (swing.stopPct != null && closes[j] <= S0 * (1 - swing.stopPct)) { sell(j, left, v, 'stop'); break }
      if (j - e >= swing.maxHold) { sell(j, left, v, 'cap'); break }
      continue
    }
    if (useTargets) {
      plan.targets.forEach((t, k) => {
        if (!hit[k] && v >= cost * (1 + t)) { hit[k] = true; sell(j, plan.fractions[k], v, `t${k + 1}`) }
      })
      if (hit.every(Boolean) && left > 1e-9 && v <= peak * (1 - plan.runnerTrailPct)) { sell(j, left, v, 'trail'); break }
    }
    if (useSignals && j > e && sellSig?.[j] && left > 1e-9 && (exitRule === 'signals' || hit[0])) { sell(j, left, v, 'signal'); break }
  }
  const last = Math.min(j, n - 1)
  let open = false
  if (left > 1e-9) {
    // Still open on the last bar: mark it there (no slippage on a mark).
    const daysLeft = (expiry - dayMs(bars[n - 1].t)) / DAY_MS
    const v = bsCall(closes[n - 1], K, daysLeft / 365, markVol(n - 1), opt.rate, markQ(n - 1))
    proceeds += left * v
    stockOut += left * closes[n - 1]
    open = true
  }
  const end = open ? n - 1 : exits[exits.length - 1].i
  return {
    signalI: i, signalT: bars[i].t, i: e, t: bars[e].t, stock: S0, strike: K, cost, vol: v0, slip, q: q0,
    exits, open, endI: end, endT: bars[end].t,
    ...(sw ? { target: sw.kind === 'opt' ? cost * sw.optMult : sw.target, targetKind: sw.kind, hit: exits.some((x) => x.reason === 'target') } : {}),
    optionReturn: proceeds / cost - 1,
    stockReturn: stockOut / S0 - 1,
    bestStock: maxHigh / S0 - 1,
    days: Math.round((dayMs(bars[end].t) - dayMs(bars[e].t)) / DAY_MS),
    lastI: last,
  }
}

// Trades from a boolean entries array (entries[i] = a signal at bar i's
// close; the trade buys at bar i+1's open). One position at a time unless
// allowOverlap.
export function replayFromEntries(bars, entries, { allowOverlap = false, vol = null, opt = OPTION_MODEL, ...rest } = {}) {
  const n = bars.length
  const closes = bars.map((b) => b.c)
  const sigma = vol ?? trailingVol(closes, opt.volBars)
  const trades = []
  let i = 0
  while (i < n - 1) {
    if (!entries[i]) { i++; continue }
    const tr = oneTrade(bars, closes, sigma, i, { opt, ...rest })
    if (!tr) { i++; continue }
    const { lastI, ...t } = tr
    trades.push(t)
    i = allowOverlap ? i + 1 : Math.max(lastI, i + 1) + 1
  }
  return trades
}

// Trades, one at a time: a signal at bar i's close buys at bar i+1's open;
// every later close is checked for exits in this order — time stop (expiry
// within the playbook's rollDays), then targets (sell each target's
// fraction once the call is worth 1 + target × cost), then the runner trail
// (only once every target has hit, as in the app), then the sell signal:
// `signals` sells everything on it; `both` lets it close only what's left
// after target 1 (the targets bank the gain, the signal guards the rest). No hard stop: the playbook cuts on the thesis, which a
// replay can't see. A trade still open on the last bar is marked there.
export function replayTrades(bars, sig, { entryRule = 'confluence', exitRule = 'targets', plan = EXIT_PLAYBOOK, opt = OPTION_MODEL, vol = null, ...pricing } = {}) {
  const highs = exitRule === 'swing' && !pricing.highs ? swingPoints(bars, SWING_PIVOT_BARS).highs : pricing.highs
  const trades = replayFromEntries(bars, sig.entry[entryRule], { exitRule, plan, opt, vol, sell: sig.sell, ...pricing, highs })
  for (const t of trades) t.key = sig.buyKey?.[t.signalI] ?? null
  return trades
}

// Put debit spreads on the bear entries (see PUT_MODEL). One at a time; a
// signal at bar i's close opens at bar i+1's open. Each later close:
// stop (−50% of the debit) → take-profits (+100% sell half, +200% sell a
// quarter) → thesis flip (2+ buy signals) → 21 DTE: whatever is left goes.
export function replayPutSpreads(bars, sig, { rule = 'falling', pm = PUT_MODEL, opt = OPTION_MODEL, vol = null } = {}) {
  const n = bars.length
  const closes = bars.map((b) => b.c)
  const sigma = vol ?? trailingVol(closes, opt.volBars)
  const entries = sig.bear[rule]
  const trades = []
  let skipped = 0
  let i = 0
  while (i < n - 1) {
    if (!entries[i] || sigma[i] == null) { i++; continue }
    const e = i + 1
    const S0 = bars[e].o || bars[e].c
    const v0 = Math.max(opt.volFloor, sigma[i])
    const T0 = pm.dte / 365
    const K1 = S0
    const K2 = S0 * (1 - v0 * Math.sqrt(T0))
    const width = K1 - K2
    const price = (S, T, v) => Math.max(0, bsPut(S, K1, T, v, opt.rate) - bsPut(S, K2, T, v, opt.rate))
    const cost = price(S0, T0, v0) * (1 + opt.slippage)
    // The spread rule: pay at most 40% of the width.
    if (!(width > 0) || cost > pm.maxDebit * width) { skipped++; i = e; continue }
    const expiry = dayMs(bars[e].t) + pm.dte * DAY_MS
    let left = 1
    let proceeds = 0
    let stockOut = 0
    let minLow = bars[e].l
    const took = pm.takes.map(() => false)
    const exits = []
    const sell = (j, frac, value, reason) => {
      const f = Math.min(frac, left)
      if (f <= 1e-9) return
      proceeds += f * value * (1 - opt.slippage)
      stockOut += f * closes[j]
      left -= f
      exits.push({ i: j, t: bars[j].t, frac: f, value, mult: value / cost, reason })
    }
    let j = e
    for (; j < n && left > 1e-9; j++) {
      minLow = Math.min(minLow, bars[j].l)
      const daysLeft = (expiry - dayMs(bars[j].t)) / DAY_MS
      const v = price(closes[j], Math.max(0, daysLeft) / 365, Math.max(opt.volFloor, sigma[j] ?? v0))
      if (j > e && v <= cost * (1 + pm.stop)) { sell(j, left, v, 'stop'); break }
      pm.takes.forEach(([gain, frac], k) => {
        if (!took[k] && v >= cost * (1 + gain)) { took[k] = true; sell(j, frac, v, `t${k + 1}`) }
      })
      if (left <= 1e-9) break
      if (j > e && sig.buyOn[j]) { sell(j, left, v, 'flip'); break }
      if (daysLeft <= pm.closeDte) { sell(j, left, v, 'time'); break }
    }
    let open = false
    if (left > 1e-9) {
      const daysLeft = (expiry - dayMs(bars[n - 1].t)) / DAY_MS
      const v = price(closes[n - 1], Math.max(0, daysLeft) / 365, Math.max(opt.volFloor, sigma[n - 1] ?? v0))
      proceeds += left * v
      stockOut += left * closes[n - 1]
      open = true
    }
    const end = open ? n - 1 : exits[exits.length - 1].i
    trades.push({
      signalI: i, signalT: bars[i].t, i: e, t: bars[e].t, stock: S0, long: K1, short: K2, width, cost, vol: v0,
      exits, open, endI: end, endT: bars[end].t,
      optionReturn: proceeds / cost - 1,
      stockReturn: stockOut / S0 - 1,
      bestStock: minLow / S0 - 1,
      days: Math.round((dayMs(bars[end].t) - dayMs(bars[e].t)) / DAY_MS),
      key: sig.sellKey?.[i] ?? null,
    })
    i = Math.max(Math.min(j, n - 1), e) + 1
  }
  trades.skipped = skipped
  return trades
}

// Big drops: a swing high followed by a fall of at least minDrop within
// `horizon` bars (to the lowest low in that span). Drops don't overlap.
export function bigDrops(bars, { minDrop = DROP.minDrop, horizon = DROP.horizon, swing = 10 } = {}) {
  const { highs } = swingPoints(bars, swing)
  const drops = []
  let after = -1
  for (const H of highs) {
    if (H <= after) continue
    let p = H
    for (let k = H + 1; k <= Math.min(bars.length - 1, H + horizon); k++) if (bars[k].l < bars[p].l) p = k
    const drop = 1 - bars[p].l / bars[H].h
    if (drop < minDrop) continue
    let half = p
    for (let k = H + 1; k <= p; k++) if (bars[k].l <= bars[H].h * (1 - drop / 2)) { half = k; break }
    drops.push({ highI: H, highT: bars[H].t, high: bars[H].h, lowI: p, lowT: bars[p].t, low: bars[p].l, drop, halfI: half, halfT: bars[half].t })
    after = p
  }
  return drops
}

// Each drop: caught when a bear entry fired from `early` bars before the
// high up to the bar half the drop was done; else why not.
export function gradeDrops(drops, trades, sig, { early = DROP.early } = {}) {
  return drops.map((d) => {
    const tr = trades.find((t) => t.signalI >= d.highI - early && t.signalI <= d.halfI)
    if (tr) {
      const range = d.high - d.low
      const exitStock = tr.stock * (1 + tr.stockReturn)
      return { ...d, caught: true, trade: tr, kept: range > 0 ? (tr.stock - exitStock) / range : null }
    }
    let best = 0
    let falling = false
    for (let k = Math.max(0, d.highI - early); k <= d.halfI; k++) {
      if (sig.sellScore[k] > best) best = sig.sellScore[k]
      if (sig.falling[k]) falling = true
    }
    const held = trades.some((t) => t.i <= d.highI && t.endI >= d.halfI)
    const why = held ? 'already in a trade' : best < MIN_SCORE ? (best ? `only ${best} signal` : 'no sell signals') : !falling ? '200-day rising' : 'signals came late'
    return { ...d, caught: false, held, bestScore: best, why }
  })
}

export function dropStats(graded) {
  const open = graded.filter((g) => !g.held)
  const caught = open.filter((g) => g.caught)
  const kept = caught.map((g) => g.kept).filter((x) => x != null)
  return {
    drops: graded.length, held: graded.length - open.length, caught: caught.length,
    catchRate: open.length ? caught.length / open.length : null,
    avgKept: kept.length ? kept.reduce((s, x) => s + x, 0) / kept.length : null,
  }
}

// Every trade counts — an open one at its mark on the last bar (owner,
// 2026-10-05: closed-only stats showed 2026 at a 100% win rate, because
// winners close at target 1 within months while losers sit open until the
// time stop ~18 months later; the open book was the losers). Days held and
// capture still describe closed trades only.
export function tradeStats(trades, { bear = false } = {}) {
  const done = trades.filter((t) => !t.open)
  const marked = trades.filter((t) => t.optionReturn != null)
  const r = marked.map((t) => t.optionReturn).sort((a, b) => a - b)
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
  return {
    n: trades.length, closed: done.length, open: trades.length - done.length,
    winRate: r.length ? r.filter((x) => x > 0).length / r.length : null,
    avg: avg(r),
    median: r.length ? (r.length % 2 ? r[(r.length - 1) / 2] : (r[r.length / 2 - 1] + r[r.length / 2]) / 2) : null,
    bigLoss: r.length ? r.filter((x) => x <= -0.5).length / r.length : null,
    avgStock: avg(marked.map((t) => t.stockReturn)),
    avgDays: avg(done.map((t) => t.days)),
    // Swing exit: how often the price target was reached, how fast, and
    // what hits / misses returned on the option.
    hitRate: trades.length && trades.some((t) => t.target != null) ? trades.filter((t) => t.hit).length / trades.length : null,
    medDaysHit: (() => { const d = trades.filter((t) => t.hit).map((t) => t.days).sort((a, b) => a - b); return d.length ? d[Math.floor(d.length / 2)] : null })(),
    hitAvg: avg(trades.filter((t) => t.hit && t.optionReturn != null).map((t) => t.optionReturn)),
    missAvg: avg(trades.filter((t) => t.target != null && !t.hit && t.optionReturn != null).map((t) => t.optionReturn)),
    // How much of the best stock move inside each trade the exit kept.
    capture: bear
      ? avg(done.filter((t) => t.bestStock < -0.05).map((t) => Math.max(-1, Math.min(1, t.stockReturn / t.bestStock))))
      : avg(done.filter((t) => t.bestStock > 0.05).map((t) => Math.max(-1, Math.min(1, t.stockReturn / t.bestStock)))),
  }
}

// ── Grading against hindsight ──────────────────────────────────────

// Big moves: a swing low followed by a rise of at least minGain within
// `horizon` bars (to the highest high in that span). Moves don't overlap.
export function bigMoves(bars, { minGain = MOVE.minGain, horizon = MOVE.horizon, swing = 10 } = {}) {
  const { lows } = swingPoints(bars, swing)
  const moves = []
  let after = -1
  for (const L of lows) {
    if (L <= after) continue
    let p = L
    for (let k = L + 1; k <= Math.min(bars.length - 1, L + horizon); k++) if (bars[k].h > bars[p].h) p = k
    const gain = bars[p].h / bars[L].l - 1
    if (gain < minGain) continue
    let half = p
    for (let k = L + 1; k <= p; k++) if (bars[k].h >= bars[L].l * (1 + gain / 2)) { half = k; break }
    moves.push({ lowI: L, lowT: bars[L].t, low: bars[L].l, peakI: p, peakT: bars[p].t, peak: bars[p].h, gain, halfI: half, halfT: bars[half].t })
    after = p
  }
  return moves
}

// Each move: caught when an entry signal fired from `early` bars before the
// low up to the bar half the move was done; the first such trade, how much
// of the move it kept, and — when missed — what the signals looked like.
export function gradeMoves(moves, trades, sig, bars, { early = MOVE.early } = {}) {
  return moves.map((m) => {
    const tr = trades.find((t) => t.signalI >= m.lowI - early && t.signalI <= m.halfI)
    if (tr) {
      const range = m.peak - m.low
      const exitStock = tr.stock * (1 + tr.stockReturn)
      return { ...m, caught: true, trade: tr, entryLag: tr.signalI - m.lowI, kept: range > 0 ? (exitStock - tr.stock) / range : null }
    }
    let best = 0
    let bestKey = ''
    let rising = false
    for (let k = Math.max(0, m.lowI - early); k <= m.halfI; k++) {
      if (sig.buyScore[k] > best) { best = sig.buyScore[k]; bestKey = sig.buyKey[k] }
      if (sig.rising[k]) rising = true
    }
    // A trade already open through the move counts as held, not missed.
    const held = trades.some((t) => t.i <= m.lowI && t.endI >= m.halfI)
    const why = held ? 'already holding'
      : !rising ? '200-day falling'
      : best < MIN_SCORE ? (best ? `only ${best} signal` : 'no buy signals')
      : 'signals came late'
    return { ...m, caught: false, held, bestScore: best, bestKey, why, lowClose: bars[m.lowI].c }
  })
}

export function moveStats(graded) {
  const open = graded.filter((g) => !g.held)
  const caught = open.filter((g) => g.caught)
  const kept = caught.map((g) => g.kept).filter((x) => x != null)
  return {
    moves: graded.length, held: graded.length - open.length, caught: caught.length,
    catchRate: open.length ? caught.length / open.length : null,
    avgKept: kept.length ? kept.reduce((s, x) => s + x, 0) / kept.length : null,
    avgGain: graded.length ? graded.reduce((s, g) => s + g.gain, 0) / graded.length : null,
  }
}

// One ticker, every entry × exit rule: trades, stats, and the move grading.
export function replayModel({ bars, model, suite, opt = OPTION_MODEL, plan = EXIT_PLAYBOOK }) {
  const sig = replaySignals(bars, model, suite)
  const vol = trailingVol(bars.map((b) => b.c), opt.volBars)
  const moves = bigMoves(bars)
  const runs = {}
  for (const [entryRule] of ENTRY_RULES) {
    for (const [exitRule] of EXIT_RULES) {
      const trades = replayTrades(bars, sig, { entryRule, exitRule, plan, opt, vol })
      runs[`${entryRule}:${exitRule}`] = { entryRule, exitRule, trades, stats: tradeStats(trades) }
    }
  }
  // Moves are graded on entries, which don't depend on the exit — except
  // "already holding"; grade with the targets exit (the app's default).
  const graded = Object.fromEntries(ENTRY_RULES.map(([entryRule]) => {
    const g = gradeMoves(moves, runs[`${entryRule}:targets`].trades, sig, bars)
    return [entryRule, { graded: g, stats: moveStats(g) }]
  }))
  // Puts: put debit spreads on the sell side, per bear rule.
  const drops = bigDrops(bars)
  const puts = Object.fromEntries(BEAR_RULES.map(([rule]) => {
    const trades = replayPutSpreads(bars, sig, { rule, opt, vol })
    const g = gradeDrops(drops, trades, sig)
    return [rule, { rule, trades, skipped: trades.skipped, stats: tradeStats(trades, { bear: true }), graded: g, dropStats: dropStats(g) }]
  }))
  return { sig, moves, runs, graded, drops, puts }
}
