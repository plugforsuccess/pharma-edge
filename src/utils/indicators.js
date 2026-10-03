// LEAPS entry model for /charts/entry/:ticker — pure functions.
//
// Indicators on daily bars { t: 'YYYY-MM-DD', o, h, l, c, v }:
//   SMA 50 / 200, the 200's 20-day slope, weekly 50 EMA projected onto
//   days (no look-ahead: each day uses the EMA with its week's close so
//   far), golden / death crosses, % distance from the 200, RSI(14)
//   (Wilder), MACD(12, 26, 9), 20-day historical vol, and IV Rank (252).
// The buy zone needs every condition at once (see entryModel). Backtest:
// one trade per cluster of signal days — a signal counts as a new trade
// when no signal fired in the previous `cooldown` trading days — with
// returns after 63 / 126 / 252 trading days (3 / 6 / 12 months).
// `npm run indicators:check` runs scripts/check-indicators.mjs.

export const DEFAULT_PARAMS = Object.freeze({
  bandPct: 5,        // price within ±band% of the 200-day SMA
  rsiLevel: 40,      // RSI dipped below this…
  lookback: 10,      // …within this many days, and is rising now
  ivRankMax: 35,     // IV Rank below this
  macdWindow: 5,     // MACD bullish cross within this many days = confirmation
  cooldown: 20,      // backtest: a new trade needs this many days with no signal
})
export const HORIZONS = [['3M', 63], ['6M', 126], ['12M', 252]]

export function sma(values, n) {
  const out = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= n) sum -= values[i - n]
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

// EMA seeded with the SMA of the first n values (null before that).
export function ema(values, n) {
  const out = new Array(values.length).fill(null)
  const k = 2 / (n + 1)
  let prev = null
  let start = values.findIndex((v) => v != null)
  if (start < 0) return out
  let sum = 0
  for (let i = start; i < values.length; i++) {
    const v = values[i]
    if (v == null) continue
    if (prev == null) {
      sum += v
      if (i - start + 1 === n) { prev = sum / n; out[i] = prev }
      continue
    }
    prev = v * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

// Wilder's RSI.
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null)
  if (closes.length <= n) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d; else loss -= d
  }
  gain /= n; loss /= n
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    gain = (gain * (n - 1) + Math.max(d, 0)) / n
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast)
  const s = ema(closes, slow)
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null))
  const sig = ema(line, signal)
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null))
  return { line, signal: sig, hist }
}

// Annualised n-day historical volatility of log returns.
export function historicalVol(closes, n = 20) {
  const out = new Array(closes.length).fill(null)
  const r = closes.map((c, i) => (i === 0 ? null : Math.log(c / closes[i - 1])))
  for (let i = n; i < closes.length; i++) {
    const w = r.slice(i - n + 1, i + 1)
    const m = w.reduce((s, x) => s + x, 0) / n
    const v = w.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)
    out[i] = Math.sqrt(v) * Math.sqrt(252)
  }
  return out
}

// Rank of today's value within the last `n` values (0–100). Needs at least
// `min` values in the window.
export function rank(values, n = 252, min = 120) {
  return values.map((v, i) => {
    if (v == null) return null
    const w = values.slice(Math.max(0, i - n + 1), i + 1).filter((x) => x != null)
    if (w.length < min) return null
    const lo = Math.min(...w)
    const hi = Math.max(...w)
    return hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50
  })
}

// ISO week key (Monday-based) for a 'YYYY-MM-DD' date.
function weekKey(t) {
  const d = new Date(`${t}T00:00:00Z`)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

// Weekly n-EMA projected onto days: each day = the EMA of weekly closes
// with the current week's close taken as that day's close (no look-ahead).
export function weeklyEmaOnDays(bars, n = 50) {
  const k = 2 / (n + 1)
  const out = new Array(bars.length).fill(null)
  const finals = []        // closed weeks' closes
  let prevEma = null       // EMA through the last closed week
  let curWeek = null
  let lastClose = null
  for (let i = 0; i < bars.length; i++) {
    const wk = weekKey(bars[i].t)
    if (curWeek != null && wk !== curWeek) {
      // Close out the previous week.
      finals.push(lastClose)
      if (prevEma == null && finals.length === n) prevEma = finals.reduce((s, x) => s + x, 0) / n
      else if (prevEma != null) prevEma = lastClose * k + prevEma * (1 - k)
    }
    curWeek = wk
    lastClose = bars[i].c
    if (prevEma != null) out[i] = lastClose * k + prevEma * (1 - k)
    else if (finals.length === n - 1) out[i] = (finals.reduce((s, x) => s + x, 0) + lastClose) / n
  }
  return out
}

// IV series on the bars' days: real IV where sampled ({ t, iv } points,
// decimal), with `ivToday` on the last day. IV Rank uses real IV only when
// it covers most of the last year; otherwise the 20-day HV stands in.
export function ivSeries(bars, ivPoints = [], ivToday = null) {
  const byDay = new Map(ivPoints.filter((p) => p.iv > 0).map((p) => [p.t, Number(p.iv)]))
  const iv = bars.map((b) => byDay.get(b.t) ?? null)
  if (ivToday > 0 && bars.length) iv[bars.length - 1] = ivToday
  const lastYear = iv.slice(-252).filter((x) => x != null).length
  return { iv, realCoverage: lastYear, useReal: lastYear >= 200 }
}

const crossedAbove = (a, b, i) => a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i]
const crossedBelow = (a, b, i) => a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] >= b[i - 1] && a[i] < b[i]

// Everything the entry chart draws: series, crosses, per-day conditions,
// buy signals, MACD confirmations, today's status and the backtest.
export function entryModel(bars, { ivPoints = [], ivToday = null, params = DEFAULT_PARAMS } = {}) {
  const p = { ...DEFAULT_PARAMS, ...params }
  const closes = bars.map((b) => b.c)
  const s50 = sma(closes, 50)
  const s200 = sma(closes, 200)
  const slope200 = s200.map((v, i) => (v != null && s200[i - 20] != null ? v - s200[i - 20] : null))
  const wema = weeklyEmaOnDays(bars, 50)
  const dist = closes.map((c, i) => (s200[i] ? (c / s200[i] - 1) * 100 : null))
  const r = rsi(closes, 14)
  const m = macd(closes)
  const hv = historicalVol(closes, 20)
  const ivs = ivSeries(bars, ivPoints, ivToday)
  const ivRank = rank(ivs.useReal ? ivs.iv : hv, 252)

  const golden = []
  const death = []
  const macdUp = []
  for (let i = 1; i < bars.length; i++) {
    if (crossedAbove(s50, s200, i)) golden.push(i)
    if (crossedBelow(s50, s200, i)) death.push(i)
    if (crossedAbove(m.line, m.signal, i)) macdUp.push(i)
  }

  const cond = bars.map((_, i) => {
    const dipped = r.slice(Math.max(0, i - p.lookback + 1), i + 1).some((x) => x != null && x < p.rsiLevel)
    const c = {
      band: dist[i] != null && Math.abs(dist[i]) <= p.bandPct,
      rising: slope200[i] != null && slope200[i] > 0,
      trend: s50[i] != null && s200[i] != null && s50[i] > s200[i],
      rsi: dipped && r[i] != null && r[i - 1] != null && r[i] > r[i - 1],
      iv: ivRank[i] != null && ivRank[i] < p.ivRankMax,
    }
    return { ...c, all: c.band && c.rising && c.trend && c.rsi && c.iv }
  })
  const signals = cond.map((c, i) => (c.all ? i : -1)).filter((i) => i >= 0)
  const signalSet = new Set(signals)
  // A MACD bullish cross within macdWindow days of a signal.
  const confirms = macdUp.filter((i) => signals.some((s) => Math.abs(s - i) <= p.macdWindow))

  // Backtest: one trade per cluster (no signal in the previous cooldown days).
  const entries = signals.filter((i, k) => k === 0 || i - signals[k - 1] > p.cooldown)
  const trades = entries.map((i) => ({
    i, t: bars[i].t, price: closes[i],
    confirmed: macdUp.some((x) => Math.abs(x - i) <= p.macdWindow),
    returns: HORIZONS.map(([, n]) => (i + n < bars.length ? closes[i + n] / closes[i] - 1 : null)),
  }))
  const stats = HORIZONS.map(([label], h) => {
    const done = trades.map((tr) => tr.returns[h]).filter((x) => x != null)
    return {
      label, n: done.length,
      winRate: done.length ? done.filter((x) => x > 0).length / done.length : null,
      avg: done.length ? done.reduce((s, x) => s + x, 0) / done.length : null,
    }
  })

  const last = bars.length - 1
  const status = last < 0 ? null : {
    t: bars[last].t,
    close: closes[last],
    dist: dist[last], sma200: s200[last], slope200: slope200[last], sma50: s50[last],
    rsi: r[last], rsiPrev: r[last - 1], rsiMinLookback: Math.min(...r.slice(Math.max(0, last - p.lookback + 1)).filter((x) => x != null)),
    ivRank: ivRank[last], iv: ivs.iv[last], hv: hv[last],
    cond: cond[last],
  }

  return {
    params: p, closes, s50, s200, slope200, wema, dist, rsi: r, macd: m, hv, iv: ivs.iv, ivRank,
    ivSource: ivs.useReal ? 'iv' : 'hv', ivCoverage: ivs.realCoverage,
    golden, death, macdUp, cond, signals, confirms, trades, stats, status,
  }
}
