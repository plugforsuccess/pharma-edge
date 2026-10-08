// NIGHTFLOW — Order Flow Intelligence Engine.
//
// One engine per symbol. Feed it quotes, prints (and Level 2 books when a
// source has them) in event order; call snapshot(now) for everything the
// dashboard and the alerting need. The engine is pure JS with no I/O, so
// the browser (replay, synthetic demo), the dxlink-worker (live) and the
// backtest run the same code.
//
// Every output is descriptive: "consistent with", never "is". The engine
// cannot see hidden orders, identify institutions or know future orders.

import { DEFAULT_CONFIG, WINDOWS, ORDER_SIZES, SCORE_BANDS, SOURCES } from './config.js'
import { classifyTrade, quoteQuality } from './classify.js'
import { sessionOf, sessionKey } from './sessions.js'
import { clamp, mean, median, std, slope } from './stats.js'

const BUCKET_MS = 10_000
const RETAIN_MS = 20 * 3_600_000
const QUOTE_RETAIN_MS = 45 * 60_000
const CHART_BUCKETS = 720            // 2 hours of 10-second buckets
const MAX_TRADES = 250_000

// Binary search: first index with arr[i].t > t.
function upper(arr, t) {
  let lo = 0, hi = arr.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) lo = m + 1; else hi = m }
  return lo
}

function aggregate(trades) {
  const a = { n: 0, vol: 0, buy: 0, sell: 0, ind: 0, buyUsd: 0, sellUsd: 0, usd: 0, open: null, close: null, high: null, low: null, excludedVol: 0, methods: { quote: 0, midpoint: 0, tick: 0, none: 0 } }
  for (const r of trades) {
    if (r.cancelled) continue
    a.n++
    a.vol += r.size
    a.usd += r.usd
    if (r.excluded) { a.excludedVol += r.size; a.ind += r.size; continue }
    a.methods[r.method] = (a.methods[r.method] ?? 0) + r.size
    if (r.side > 0) { a.buy += r.size; a.buyUsd += r.usd } else if (r.side < 0) { a.sell += r.size; a.sellUsd += r.usd } else a.ind += r.size
    if (a.open == null) a.open = r.price
    a.close = r.price
    a.high = a.high == null ? r.price : Math.max(a.high, r.price)
    a.low = a.low == null ? r.price : Math.min(a.low, r.price)
  }
  const classified = a.buy + a.sell
  a.delta = a.buy - a.sell
  a.deltaUsd = a.buyUsd - a.sellUsd
  a.deltaRatio = classified > 0 ? a.delta / classified : null
  a.indShare = a.vol > 0 ? a.ind / a.vol : null
  a.ret = a.open && a.close ? Math.log(a.close / a.open) : null
  return a
}

export class OrderFlowEngine {
  constructor({ symbol, source = 'synthetic', config = {}, context = {} } = {}) {
    this.symbol = symbol
    this.source = source
    this.cfg = { ...DEFAULT_CONFIG, ...config, weights: { ...DEFAULT_CONFIG.weights, ...(config.weights ?? {}) } }
    this.context = { refPrice: null, float: null, dilution: null, ...context }
    this.trades = []
    this.byId = new Map()
    this.quotes = []           // raw NBBO updates (for quote-at-time lookup)
    this.qs = []               // liquidity samples, ≤ 4 per second
    this.book = null           // latest Level 2 { t, bids: [[px, size]], asks }
    this.tick = { last: null, dir: 0 }
    this.lastT = 0
    this.failedBreaks = []     // { t, level, volRatio }
    this.withdrawals = []      // { t, dropPct, dropUsd, tradedUsd }
    this.alerts = []
    this.alertState = new Map()
    this.stats = { prints: 0, corrections: 0, cancels: 0, late: 0, excluded: 0, quotes: 0 }
  }

  setContext(patch) { Object.assign(this.context, patch) }

  // ----- inputs ------------------------------------------------------

  onQuote(q) {
    // q: { t, bid, ask, bidSize, askSize }
    if (q.bid == null || q.ask == null) return
    this.stats.quotes++
    const rec = { t: q.t, bid: q.bid, ask: q.ask, bidSize: q.bidSize ?? null, askSize: q.askSize ?? null }
    if (!this.quotes.length || q.t >= this.quotes[this.quotes.length - 1].t) this.quotes.push(rec)
    else this.quotes.splice(upper(this.quotes, q.t), 0, rec)
    const mid = (q.bid + q.ask) / 2
    const s = {
      t: q.t, bid: q.bid, ask: q.ask, bidSize: rec.bidSize, askSize: rec.askSize,
      spreadPct: mid > 0 ? (q.ask - q.bid) / mid : null,
      bidUsd: rec.bidSize != null ? q.bid * rec.bidSize : null,
      askUsd: rec.askSize != null ? q.ask * rec.askSize : null,
    }
    const last = this.qs[this.qs.length - 1]
    if (last && q.t - last.t < 250 && q.t >= last.t) this.qs[this.qs.length - 1] = s
    else if (!last || q.t >= last.t) this.qs.push(s)
    this.lastT = Math.max(this.lastT, q.t)
    this.prune()
  }

  onBook(b) {
    // b: { t, bids: [[price, size], …] best first, asks: […] }
    this.book = b
  }

  quoteAt(t) {
    const i = upper(this.quotes, t) - 1
    return i >= 0 ? this.quotes[i] : null
  }

  onTrade(raw) {
    // raw: { t, price, size, id?, type?: 'NEW'|'CORRECTION'|'CANCEL' (dxFeed TimeAndSale type), conds?, bid?, ask?, eth?, valid?, exch? }
    const kind = raw.type ?? 'NEW'
    if (kind === 'CANCEL' || kind === 'CORRECTION') {
      const prev = raw.id != null ? this.byId.get(raw.id) : null
      if (prev) prev.cancelled = true
      if (kind === 'CANCEL') { this.stats.cancels++; return }
      this.stats.corrections++
    }
    if (!(raw.price > 0) || !(raw.size > 0)) return
    this.stats.prints++
    const late = raw.t < this.lastT - 2_000
    if (late) this.stats.late++
    const quote = this.quoteAt(raw.t - (this.cfg.quoteLagMs || 0))
    // A late print can't use the running tick state (it belongs to a
    // different moment): quote rule only, otherwise indeterminate.
    const tickState = late ? { last: null, dir: 0 } : this.tick
    const c = classifyTrade(raw, quote, tickState, this.cfg)
    const rec = {
      id: raw.id ?? `${raw.t}:${this.stats.prints}`,
      t: raw.t, price: raw.price, size: raw.size, usd: raw.price * raw.size,
      side: c.side, method: c.method, conf: c.confidence, excluded: c.excluded ?? null,
      late, exch: raw.exch ?? null, session: sessionOf(raw.t),
    }
    if (rec.excluded) this.stats.excluded++
    if (!this.trades.length || raw.t >= this.trades[this.trades.length - 1].t) this.trades.push(rec)
    else this.trades.splice(upper(this.trades, raw.t), 0, rec)
    this.byId.set(rec.id, rec)
    if (!rec.excluded && !late) {
      const d = this.tick.last == null ? 0 : Math.sign(raw.price - this.tick.last)
      if (d) this.tick.dir = d
      this.tick.last = raw.price
    }
    this.lastT = Math.max(this.lastT, raw.t)
    this.prune()
  }

  prune() {
    const cut = this.lastT - RETAIN_MS
    if (this.trades.length > MAX_TRADES || (this.trades.length && this.trades[0].t < cut)) {
      const i = Math.max(upper(this.trades, cut), this.trades.length - MAX_TRADES)
      for (const r of this.trades.slice(0, i)) this.byId.delete(r.id)
      this.trades.splice(0, i)
    }
    const qcut = this.lastT - QUOTE_RETAIN_MS
    if (this.quotes.length > 2000 && this.quotes[0].t < qcut) this.quotes.splice(0, upper(this.quotes, qcut) - 1)
    if (this.qs.length && this.qs[0].t < qcut) this.qs.splice(0, upper(this.qs, qcut))
  }

  windowTrades(now, ms) {
    return this.trades.slice(upper(this.trades, now - ms), upper(this.trades, now))
  }

  // 10-second buckets with per-session CVD (resets at each session).
  buckets(now) {
    const out = []
    let cur = null, cvd = 0, skey = null, lastClose = null
    for (const r of this.trades) {
      if (r.t > now) break
      if (r.cancelled) continue
      const b = Math.floor(r.t / BUCKET_MS) * BUCKET_MS
      if (!cur || cur.t !== b) {
        const k = sessionKey(b)
        if (k !== skey) { cvd = 0; skey = k }
        cur = { t: b, o: null, h: null, l: null, c: null, v: 0, buy: 0, sell: 0, ind: 0, buyUsd: 0, sellUsd: 0, usd: 0, n: 0, cvd, session: sessionOf(b), skey: k, prevClose: lastClose }
        out.push(cur)
      }
      cur.v += r.size; cur.usd += r.usd; cur.n++
      if (r.excluded) { cur.ind += r.size; continue }
      if (r.side > 0) { cur.buy += r.size; cur.buyUsd += r.usd; cvd += r.size }
      else if (r.side < 0) { cur.sell += r.size; cur.sellUsd += r.usd; cvd -= r.size }
      else cur.ind += r.size
      cur.cvd = cvd
      if (cur.o == null) cur.o = r.price
      cur.c = r.price
      cur.h = cur.h == null ? r.price : Math.max(cur.h, r.price)
      cur.l = cur.l == null ? r.price : Math.min(cur.l, r.price)
      lastClose = r.price
    }
    // Buckets with only excluded prints carry the previous close.
    for (const b of out) if (b.c == null) { b.o = b.h = b.l = b.c = b.prevClose }
    return out.filter((b) => b.c != null)
  }

  // ----- the snapshot ------------------------------------------------

  snapshot(now = this.lastT) {
    const cfg = this.cfg
    const source = SOURCES[this.source] ?? SOURCES.synthetic
    const session = sessionOf(now)
    const base = { symbol: this.symbol, t: now, session, source: this.source, sourceLabel: source.label, mode: source.kind, stats: { ...this.stats } }

    if (session !== 'closed' && source.sessions[session] === false) {
      return { ...base, status: 'disabled', reason: `${source.label} does not cover the ${session} session — analytics disabled rather than estimated.`, alerts: this.alerts.slice(-50) }
    }

    const allBuckets = this.buckets(now)
    const skey = sessionKey(now)
    const sessBuckets = allBuckets.filter((b) => b.skey === skey)
    const chart = allBuckets.slice(-CHART_BUCKETS).map(({ t, o, h, l, c, v, buy, sell, cvd, session: s }) => ({ t, o, h, l, c, v, buy, sell, cvd, session: s }))

    const windows = {}
    for (const [k, ms] of Object.entries(WINDOWS)) windows[k] = aggregate(this.windowTrades(now, ms))
    const sessTrades = this.trades.filter((r) => r.t <= now && sessionKey(r.t) === skey)
    windows.session = aggregate(sessTrades)

    // Quote / liquidity state
    const lastQuote = this.quoteAt(now)
    const qq = quoteQuality(lastQuote, now, cfg, session !== 'regular')
    const w5 = windows['5m']
    const gate = {
      trades: w5.n >= cfg.minTrades5m,
      shares: w5.vol >= cfg.minShares5m,
      dollars: w5.usd >= cfg.minDollars5m,
      classified: w5.indShare != null && w5.indShare <= cfg.maxIndeterminateShare,
      quote: qq.grade === 'good' || qq.grade === 'fair',
    }
    gate.ok = Object.values(gate).every(Boolean)
    gate.reasons = []
    if (!gate.trades) gate.reasons.push(`${w5.n} trades in 5 min (need ${cfg.minTrades5m})`)
    if (!gate.shares) gate.reasons.push(`${Math.round(w5.vol).toLocaleString()} shares in 5 min (need ${cfg.minShares5m.toLocaleString()})`)
    if (!gate.dollars) gate.reasons.push(`$${Math.round(w5.usd).toLocaleString()} traded in 5 min (need $${cfg.minDollars5m.toLocaleString()})`)
    if (!gate.classified) gate.reasons.push(w5.indShare == null ? 'no classified volume' : `${Math.round(w5.indShare * 100)}% of volume unclassified (max ${Math.round(cfg.maxIndeterminateShare * 100)}%)`)
    if (!gate.quote) gate.reasons.push(`quote ${qq.grade}${qq.reason ? ` (${qq.reason})` : qq.stale ? ' (stale)' : qq.crossed ? ' (crossed)' : ''}`)

    // Volatility and the price-impact coefficient from 30 minutes of buckets.
    const recent = allBuckets.filter((b) => b.t > now - 30 * 60_000)
    const rets = [], flows = []
    for (let i = 1; i < recent.length; i++) {
      const r = Math.log(recent[i].c / recent[i - 1].c)
      rets.push(r)
      flows.push(recent[i].buyUsd - recent[i].sellUsd)
    }
    const sigma10 = rets.length >= 10 ? std(rets) : null
    const lambda = rets.length >= cfg.minBaselineBuckets ? slope(flows, rets) : null
    const sigmaFor = (ms) => (sigma10 != null ? sigma10 * Math.sqrt(ms / BUCKET_MS) : null)

    const divergence = this.divergence(windows[cfg.divergenceWindow], sigmaFor(WINDOWS[cfg.divergenceWindow]), gate)
    const liquidity = this.liquidity(now, lastQuote, qq, windows, sigma10, lambda)
    const breakouts = this.failedBreakouts(now, allBuckets, liquidity.spreadBase30m)
    const rejections = this.rejections(now, sessBuckets)
    const absorption = this.absorption(now, windows, lambda, gate, breakouts)
    const distribution = this.distribution(now, windows, sessBuckets, allBuckets, liquidity, rejections, breakouts, sigmaFor)
    const score = this.score({ windows, absorption, liquidity, breakouts, gate })
    const alertsNow = this.evaluateAlerts(now, { windows, divergence, absorption, liquidity, breakouts, distribution, gate, qq, sigmaFor, sessBuckets, allBuckets })

    return {
      ...base,
      status: gate.ok ? 'ok' : 'insufficient',
      gate,
      quote: lastQuote ? { ...lastQuote, ...qq } : null,
      book: this.book && now - this.book.t < 10_000 ? this.book : null,
      windows: Object.fromEntries(Object.entries(windows).map(([k, a]) => [k, { n: a.n, vol: a.vol, buy: a.buy, sell: a.sell, ind: a.ind, delta: a.delta, deltaUsd: a.deltaUsd, deltaRatio: a.deltaRatio, usd: a.usd, ret: a.ret, high: a.high, low: a.low, close: a.close, indShare: a.indShare, methods: a.methods }])),
      sigma10, lambda,
      divergence, absorption, distribution, liquidity, breakouts, rejections, score,
      chart,
      cvdSession: windows.session.delta,
      newAlerts: alertsNow,
      alerts: this.alerts.slice(-50),
    }
  }

  // A–E price / CVD divergence on one window.
  divergence(w, sigma, gate) {
    const cfg = this.cfg
    if (!gate.ok || w.ret == null || w.deltaRatio == null) return { key: 'insufficient', label: 'Insufficient data', reasons: gate.reasons }
    const flatBand = Math.max(sigma != null ? cfg.flatSigma * sigma : 0, cfg.minFlatPct)
    const dir = w.ret > flatBand ? 'rising' : w.ret < -flatBand ? 'falling' : 'flat'
    const d = w.deltaRatio
    const pct = (x) => `${(x * 100).toFixed(2)}%`
    const ev = [`price ${dir} (${pct(Math.exp(w.ret) - 1)}, flat band ±${pct(flatBand)})`, `delta ${Math.round(d * 100)}% of classified volume`]
    if (dir === 'rising' && d >= cfg.mildDeltaRatio) return { key: 'A', label: 'Price ↑ CVD ↑ — buying aggression may be confirming the move', tone: 'bull', evidence: ev }
    if (dir === 'rising' && d <= -cfg.mildDeltaRatio) return { key: 'B', label: 'Price ↑ CVD ↓ — underlying demand may be weakening', tone: 'warn', evidence: ev }
    if (dir === 'flat' && d >= cfg.strongDeltaRatio) return { key: 'C', label: 'Price flat, CVD strongly positive — possible sell-side absorption', tone: 'warn', evidence: ev }
    if (dir === 'flat' && d <= -cfg.strongDeltaRatio) return { key: 'D', label: 'Price flat, CVD strongly negative — possible buy-side absorption', tone: 'bull', evidence: ev }
    if (dir === 'falling' && d <= -cfg.strongDeltaRatio) return { key: 'E', label: 'Price ↓ CVD ↓ — aggressive selling confirmation', tone: 'bear', evidence: ev }
    return { key: 'neutral', label: 'No clear divergence', tone: 'neutral', evidence: ev }
  }

  liquidity(now, q, qq, windows, sigma10, lambda) {
    const cfg = this.cfg
    const samples = (ms) => this.qs.filter((s) => s.t > now - ms && s.t <= now)
    const s30 = samples(30 * 60_000), s5 = samples(5 * 60_000), s15 = samples(15 * 60_000)
    const spreadBase = median(s30.map((s) => s.spreadPct).filter((x) => x != null))
    const spreadNow = median(samples(60_000).map((s) => s.spreadPct).filter((x) => x != null)) ?? qq.spreadPct ?? null
    const bidNow = q?.bidSize != null ? q.bid * q.bidSize : null
    const askNow = q?.askSize != null ? q.ask * q.askSize : null
    const bid5 = median(s5.map((s) => s.bidUsd).filter((x) => x != null))
    const bid15 = median(s15.map((s) => s.bidUsd).filter((x) => x != null))
    const bidRecent = median(samples(60_000).map((s) => s.bidUsd).filter((x) => x != null))
    const imbalanceTop = q?.bidSize != null && q?.askSize != null && q.bidSize + q.askSize > 0 ? (q.bidSize - q.askSize) / (q.bidSize + q.askSize) : null

    // Level 2 depth within 1% of mid, when the source has a book.
    let depth = null
    const book = this.book && now - this.book.t < 10_000 ? this.book : null
    if (book && qq.mid) {
      const within = (levels, ok) => levels.filter(([p]) => ok(p)).reduce((s, [p, z]) => s + p * z, 0)
      const bidD = within(book.bids, (p) => p >= qq.mid * 0.99)
      const askD = within(book.asks, (p) => p <= qq.mid * 1.01)
      depth = { bidUsd1pct: bidD, askUsd1pct: askD, imbalance: bidD + askD > 0 ? (bidD - askD) / (bidD + askD) : null, levels: { bids: book.bids.slice(0, 10), asks: book.asks.slice(0, 10) } }
    }

    // Liquidity withdrawal: displayed bid $ collapses within 30 s and the
    // trades at the bid don't explain the drop (orders pulled, not filled).
    let withdrawal = null
    if (bid5 != null && bidNow != null && bid5 > 0) {
      const dropUsd = bid5 - bidNow
      const dropPct = dropUsd / bid5
      const recentS = samples(cfg.withdrawalMs)
      const lastHigh = [...recentS].reverse().find((s) => s.bidUsd != null && s.bidUsd >= bid5 * 0.8)
      if (dropPct >= cfg.withdrawalDrop && lastHigh) {
        // Only selling since the bid was last full can explain the drop.
        const tradedUsd = this.trades.slice(upper(this.trades, lastHigh.t), upper(this.trades, now)).filter((r) => !r.cancelled && r.side < 0).reduce((s, r) => s + r.usd, 0)
        if (tradedUsd < cfg.withdrawalTradedShare * dropUsd) {
          withdrawal = { t: now, dropPct, dropUsd, tradedUsd }
          const last = this.withdrawals[this.withdrawals.length - 1]
          if (!last || now - last.t > 60_000) this.withdrawals.push(withdrawal)
        }
      }
    }
    this.withdrawals = this.withdrawals.filter((w) => w.t > now - 30 * 60_000)

    const sessUsd = windows.session.usd
    const dayUsd = Math.max(sessUsd, windows['15m'].usd * 26)
    const impact = this.impactTable(q, qq, book, sigma10, dayUsd)
    // Fitted impact: bps of price move per $10k of net aggressive flow.
    const lambdaBpsPer10k = lambda != null ? lambda * 10_000 * 1e4 : null

    return {
      spreadPct: qq.spreadPct ?? null,
      spreadMedian1m: spreadNow, spreadBase30m: spreadBase,
      spreadRatio: spreadNow != null && spreadBase ? spreadNow / spreadBase : null,
      bidUsd: bidNow, askUsd: askNow, bidUsd5m: bid5, bidUsd15m: bid15, bidUsd1m: bidRecent,
      bidRatio: bidRecent != null && bid15 ? bidRecent / bid15 : null,
      imbalanceTop, depth,
      withdrawal, withdrawals: this.withdrawals.slice(-10),
      impact, lambdaBpsPer10k,
      displayedOnly: !book,
      notes: book
        ? ['Level 2 depth from the source. Displayed orders can be cancelled before an order reaches them.']
        : ['Top of book only (NBBO size) — the source has no Level 2. Depth beyond the best bid/ask is estimated with a square-root impact model, not observed.', 'Displayed size is not guaranteed: quotes can be cancelled or refreshed before an order arrives.'],
    }
  }

  // Hypothetical order fills. Displayed = what the book shows now;
  // executable = displayed with a haircut beyond the first level; model =
  // square-root impact for the whole order (labelled as a model).
  impactTable(q, qq, book, sigma10, dayUsd) {
    if (!q || !qq.mid) return null
    const cfg = this.cfg
    const mid = qq.mid
    const sigmaDay = sigma10 != null ? sigma10 * Math.sqrt(23_400 / 10) : null
    const sideRows = (side) => {
      const levels = book ? (side === 'buy' ? book.asks : book.bids) : [[side === 'buy' ? q.ask : q.bid, side === 'buy' ? q.askSize : q.bidSize]]
      return ORDER_SIZES.map((usd) => {
        let rem = usd, shares = 0, cost = 0, exec = 0
        levels.forEach(([px, size], i) => {
          if (rem <= 0 || !(size > 0)) return
          const take = Math.min(rem / px, size)
          shares += take; cost += take * px; rem -= take * px
          exec += take * px * (i === 0 ? 1 : cfg.displayedHaircut)
        })
        const filled = usd - Math.max(rem, 0)
        const avg = shares > 0 ? cost / shares : null
        const slipBps = avg != null ? (side === 'buy' ? avg / mid - 1 : 1 - avg / mid) * 1e4 : null
        const halfSpreadBps = ((q.ask - q.bid) / 2 / mid) * 1e4
        const modelBps = sigmaDay != null && dayUsd > 0 ? halfSpreadBps + cfg.impactY * sigmaDay * Math.sqrt(usd / dayUsd) * 1e4 : null
        const displayedPct = filled / usd
        return {
          usd, displayedPct, executablePct: exec / usd, avgPrice: avg, slipBps, modelBps,
          quality: displayedPct >= 0.999 && slipBps != null && slipBps < 50 ? 'good' : displayedPct >= 0.999 ? 'costly' : displayedPct > 0.25 ? 'partial' : 'thin',
        }
      })
    }
    return { buy: sideRows('buy'), sell: sideRows('sell'), basis: book ? 'Level 2' : 'top of book + model' }
  }

  // Failed breakouts: price trades above the prior 30-minute high and
  // closes back below it within 5 minutes.
  failedBreakouts(now, buckets, spreadBase) {
    const cfg = this.cfg
    const prior = buckets.filter((b) => b.t <= now - cfg.failedBreakMs && b.t > now - cfg.failedBreakMs - cfg.resistanceLookbackMs)
    const win = buckets.filter((b) => b.t > now - cfg.failedBreakMs && b.t <= now)
    if (prior.length >= 10 && win.length >= 3) {
      const R = Math.max(...prior.map((b) => b.h))
      const peak = Math.max(...win.map((b) => b.h))
      // Judge the failure on the current bid, not the last print, so the
      // bid/ask bounce of trade prices can't fake one.
      const q = this.quoteAt(now)
      const last = q ? Math.min(q.bid, win[win.length - 1].c) : win[win.length - 1].c
      // A resistance is a level tested at least twice (separate touches).
      // (or held for a minute or more).
      let touches = 0, touching = false, nearCount = 0
      for (const b of prior) {
        const near = b.h >= R * (1 - 0.003)
        if (near && !touching) touches++
        if (near) nearCount++
        touching = near
      }
      const tested = touches >= 2 || nearCount >= 6
      // A real break (≥ 0.2% over), brief (under half the window above R)
      // and a close clearly back under it (≥ 0.2% below).
      const above = win.filter((b) => b.c > R).length
      // The break must clear R by at least one typical spread.
      const m = Math.max(cfg.breakMarginPct, spreadBase ?? 0)
      if (tested && peak > R * (1 + m) && last < R * (1 - cfg.breakMarginPct) && above <= win.length / 2) {
        const vol = win.reduce((s, b) => s + b.v, 0)
        // Prior pace per failed-break window, over the history actually there.
        const span = Math.max(prior[prior.length - 1].t - prior[0].t + BUCKET_MS, BUCKET_MS)
        const base = prior.reduce((s, b) => s + b.v, 0) / (span / cfg.failedBreakMs)
        const dup = this.failedBreaks.some((f) => Math.abs(f.level / R - 1) < 0.002 && now - f.t < cfg.resistanceLookbackMs)
        if (!dup) this.failedBreaks.push({ t: now, level: R, peak, volRatio: base > 0 ? vol / base : null })
      }
    }
    this.failedBreaks = this.failedBreaks.filter((f) => f.t > now - 30 * 60_000)
    return { recent: this.failedBreaks.slice(), count30m: this.failedBreaks.length }
  }

  // Repeated rejection at the session high in the last 30 minutes.
  rejections(now, sessBuckets) {
    const cfg = this.cfg
    if (sessBuckets.length < 20) return { count: 0, high: null }
    const H = Math.max(...sessBuckets.map((b) => b.h))
    const win = sessBuckets.filter((b) => b.t > now - 30 * 60_000)
    let count = 0, inTouch = false, touchHigh = 0
    for (const b of win) {
      const touching = b.h >= H * (1 - cfg.rejectionNearPct)
      if (touching) { if (!inTouch) { inTouch = true; touchHigh = b.h } else touchHigh = Math.max(touchHigh, b.h) }
      else if (inTouch && b.c <= touchHigh * (1 - cfg.rejectionPullback)) { count++; inTouch = false }
    }
    return { count, high: H }
  }

  // Sell-side absorption: aggressive buying that fails to lift price.
  absorption(now, windows, lambda, gate, breakouts) {
    const cfg = this.cfg
    const w5 = windows['5m']
    const conds = []
    const c1 = w5.deltaRatio != null && w5.deltaRatio >= cfg.strongDeltaRatio && w5.buy >= cfg.minShares5m * 0.6
    conds.push({ key: 'aggressive_buying', met: c1, label: 'Aggressive buying', detail: w5.deltaRatio == null ? 'no classified volume' : `${Math.round(w5.deltaRatio * 100)}% net buyer-initiated, ${Math.round(w5.buy).toLocaleString()} sh bought (5 min)` })

    let c2 = null, c2d = 'impact model not ready (needs 30 min of buckets with a positive fitted impact)'
    if (lambda != null && lambda > 0 && w5.ret != null) {
      const expected = lambda * w5.deltaUsd
      if (expected > 0) {
        c2 = w5.ret < cfg.lowImpactFraction * expected
        c2d = `moved ${(w5.ret * 100).toFixed(2)}% vs ${(expected * 100).toFixed(2)}% the 30-min impact fit expects for $${Math.round(w5.deltaUsd).toLocaleString()} net buying`
      } else c2d = 'net flow not positive'
    }
    conds.push({ key: 'low_impact', met: !!c2, label: 'Price impact below normal', detail: c2d, available: c2 != null })

    const buys = this.windowTrades(now, WINDOWS['5m']).filter((r) => !r.cancelled && r.side > 0)
    const byPx = new Map()
    for (const r of buys) byPx.set(r.price, (byPx.get(r.price) ?? 0) + r.size)
    let topPx = null, topVol = 0
    for (const [p, v] of byPx) if (v > topVol) { topVol = v; topPx = p }
    const share = w5.buy > 0 ? topVol / w5.buy : 0
    const c3 = topPx != null && share >= cfg.levelConcentration && w5.high != null && topPx >= w5.high * (1 - cfg.nearHighPct)
    conds.push({ key: 'level_concentration', met: c3, label: 'Buying stuck at one level near the high', detail: topPx == null ? 'no buy volume' : `${Math.round(share * 100)}% of buy volume at $${topPx}, 5-min high $${w5.high}` })

    // Replenishment: more traded at an ask price than was ever displayed there.
    const since = now - WINDOWS['5m']
    const quoted = this.quotes.filter((q) => q.t > since - 5_000 && q.t <= now && q.askSize != null)
    let best = null
    for (const [p, v] of byPx) {
      // Only a level that caps the move counts: near the 5-min high, a
      // real share of the buying, with net buying overall.
      if (!(w5.deltaRatio > 0) || v < 0.2 * w5.buy || (w5.high != null && p < w5.high * (1 - cfg.nearHighPct))) continue
      const shown = quoted.filter((q) => Math.abs(q.ask - p) < 1e-9).map((q) => q.askSize)
      if (!shown.length) continue
      const ratio = v / Math.max(...shown)
      if (!best || ratio > best.ratio) best = { price: p, traded: v, displayed: Math.max(...shown), ratio, refreshes: shown.length }
    }
    const c4 = !!best && best.ratio >= cfg.replenishRatio
    conds.push({ key: 'replenishment', met: c4, label: 'Ask size keeps refilling', detail: best ? `${Math.round(best.traded).toLocaleString()} sh bought at $${best.price} vs ≤ ${Math.round(best.displayed).toLocaleString()} ever displayed (${best.ratio.toFixed(1)}×)` : 'no buying at a displayed ask', available: quoted.length > 0 })

    const fb = breakouts.recent.filter((f) => f.t > now - cfg.failedBreakMs)
    const c5 = fb.length > 0
    conds.push({ key: 'failed_break', met: c5, label: 'Failed resistance break', detail: c5 ? `broke $${fb[0].level} (peak $${fb[0].peak}) and closed back below` : 'none in the last 5 min' })

    const met = conds.filter((c) => c.met).length
    const active = gate.ok && c1 && met >= cfg.absorptionMinConditions
    return { active, met, of: conds.length, conditions: conds, replenish: best, gated: !gate.ok }
  }

  distribution(now, windows, sessBuckets, allBuckets, liq, rejections, breakouts, sigmaFor) {
    const cfg = this.cfg
    const f = []
    const add = (key, label, value, detail, available = true) => f.push({ key, label, value: available ? clamp(value) : null, detail, available })
    const price = windows['1m'].close ?? windows.session.close
    const ref = this.context.refPrice ?? (sessBuckets[0]?.o ?? null)
    add('appreciation', 'Recent appreciation', ref && price ? (price / ref - 1) / cfg.appreciationFull : 0,
      ref && price ? `${((price / ref - 1) * 100).toFixed(1)}% vs ${this.context.refPrice ? 'prior close' : 'session open'} $${ref}` : 'no reference price', !!(ref && price))

    const v15 = windows['15m'].vol
    const sessMin = sessBuckets.length ? (now - sessBuckets[0].t) / 60_000 : 0
    const perMin = sessMin >= 30 ? windows.session.vol / sessMin : null
    const rvol = perMin ? v15 / 15 / perMin : null
    add('abnormal_volume', 'Abnormal volume', rvol != null ? (rvol - 1) / 2 : 0, rvol != null ? `last 15 min at ${rvol.toFixed(1)}× the session's average pace` : 'needs 30 min of session', rvol != null)

    const prev = this.windowTrades(now - WINDOWS['15m'], WINDOWS['15m'])
    const prevAgg = aggregate(prev)
    const d15 = windows['15m'].deltaRatio
    const det = d15 != null && prevAgg.deltaRatio != null ? prevAgg.deltaRatio - d15 : null
    add('cvd_deterioration', 'Deteriorating CVD', det != null ? Math.max(det, 0) / 0.5 + Math.max(-(d15 ?? 0), 0) / 0.5 : 0,
      det != null ? `delta ${Math.round(prevAgg.deltaRatio * 100)}% → ${Math.round(d15 * 100)}% (prior vs last 15 min)` : 'needs 30 min of classified flow', det != null)

    add('rejections', 'Repeated rejection at highs', rejections.count / 3, `${rejections.count} rejection${rejections.count === 1 ? '' : 's'} near the session high ($${rejections.high ?? '—'}) in 30 min`)

    // Breakout efficiency: price gain per net $ bought, last 15 vs prior 15 min.
    const eff = (a) => (a.deltaUsd > 0 && a.ret != null ? a.ret / a.deltaUsd : null)
    const eNow = eff(windows['15m']), ePrev = eff(prevAgg)
    const effRatio = eNow != null && ePrev != null && ePrev > 0 ? eNow / ePrev : null
    add('breakout_efficiency', 'Declining breakout efficiency', effRatio != null ? 1 - effRatio : 0, effRatio != null ? `price gain per $ of net buying at ${(effRatio * 100).toFixed(0)}% of the prior 15 min` : 'needs net buying in both windows', effRatio != null)

    add('bid_liquidity', 'Bid-side liquidity reduction', liq.bidRatio != null ? 1 - liq.bidRatio : 0, liq.bidRatio != null ? `displayed bid $ at ${(liq.bidRatio * 100).toFixed(0)}% of its 15-min median` : 'no bid sizes', liq.bidRatio != null)
    add('spread', 'Widening spread', liq.spreadRatio != null ? (liq.spreadRatio - 1) / 1.5 : 0, liq.spreadRatio != null ? `spread ${(liq.spreadMedian1m * 100).toFixed(2)}% vs ${(liq.spreadBase30m * 100).toFixed(2)}% 30-min median` : 'no spread history', liq.spreadRatio != null)

    const r5 = windows['5m'].ret, r15 = windows['15m'].ret
    const s5 = sigmaFor(WINDOWS['5m'])
    add('momentum', 'Falling short-term momentum', r5 != null && s5 ? Math.max(-r5, 0) / (2 * s5) + (r15 > 0 && r5 < 0 ? 0.3 : 0) : 0, r5 != null ? `5 min ${(r5 * 100).toFixed(2)}%, 15 min ${((r15 ?? 0) * 100).toFixed(2)}%` : 'no price', r5 != null && !!s5)

    const dil = this.context.dilution
    add('dilution', 'SEC filing / dilution risk', dil?.score ?? 0, dil ? dil.summary : 'filings not checked', !!dil && dil.score != null)

    const avail = f.filter((x) => x.available)
    const hot = avail.filter((x) => x.value >= 0.5)
    const level = avail.length < 5 ? 'insufficient' : hot.length >= 5 ? 'hazardous' : hot.length >= 3 ? 'possible' : hot.length >= 2 ? 'watch' : 'none'

    // Profit-taking vs sustained distribution — only when the data says so.
    let character = 'uncertain'
    const v = (k) => f.find((x) => x.key === k)
    if (level === 'possible' || level === 'hazardous') {
      const sustained = (v('cvd_deterioration').value ?? 0) >= 0.5 && (v('bid_liquidity').value ?? 0) >= 0.4 && rejections.count >= 2
      const profitTaking = (v('bid_liquidity').value ?? 1) < 0.2 && (v('spread').value ?? 1) < 0.2 && rejections.count <= 1
      character = sustained ? 'sustained distribution' : profitTaking ? 'profit-taking' : 'uncertain'
    }
    return { level, character, factors: f, hot: hot.map((x) => x.key) }
  }

  score({ windows, absorption, liquidity, breakouts, gate }) {
    const W = this.cfg.weights
    const comps = []
    const add = (key, label, value, reason, available = true) => comps.push({ key, label, weight: W[key], value: available ? clamp(value) : null, reason, available })
    const d15 = windows['15m'].deltaRatio, d5 = windows['5m'].deltaRatio
    add('cvd', 'CVD deterioration', d15 != null ? Math.max(-d15, 0) / 0.5 + (d5 != null && d5 < d15 ? (d15 - d5) / 0.5 : 0) : 0,
      d15 != null ? `net flow ${Math.round(d15 * 100)}% (15 min), ${Math.round((d5 ?? 0) * 100)}% (5 min)` : 'no classified flow', d15 != null && gate.ok)
    add('absorption', 'Sell-side absorption', absorption.conditions[0].met ? absorption.met / absorption.of : 0,
      `${absorption.met} of ${absorption.of} absorption conditions${absorption.conditions[0].met ? '' : ' (aggressive buying not present)'}`, gate.ok)
    add('bid', 'Bid liquidity deterioration', liquidity.bidRatio != null ? 1 - liquidity.bidRatio : 0,
      liquidity.bidRatio != null ? `displayed bid $ at ${Math.round(liquidity.bidRatio * 100)}% of 15-min median${liquidity.withdrawal ? ' · withdrawal just now' : ''}` : 'no bid sizes', liquidity.bidRatio != null)
    add('breakouts', 'Failed breakouts', breakouts.count30m / 2, `${breakouts.count30m} failed break${breakouts.count30m === 1 ? '' : 's'} in 30 min`)
    add('spread', 'Spread expansion', liquidity.spreadRatio != null ? (liquidity.spreadRatio - 1) / 1.5 : 0,
      liquidity.spreadRatio != null ? `spread ${liquidity.spreadRatio.toFixed(2)}× its 30-min median` : 'no spread history', liquidity.spreadRatio != null)
    const dil = this.context.dilution
    add('dilution', 'Dilution / financing risk', dil?.score ?? 0, dil ? dil.summary : 'filings not checked', !!dil && dil.score != null)

    const totalW = comps.reduce((s, c) => s + c.weight, 0)
    const availW = comps.filter((c) => c.available).reduce((s, c) => s + c.weight, 0)
    const coverage = totalW ? availW / totalW : 0
    if (!gate.ok || coverage < this.cfg.minScoreCoverage) {
      return { status: 'insufficient', value: null, coverage, components: comps, reasons: gate.ok ? [`only ${Math.round(coverage * 100)}% of the score's weight is computable`] : gate.reasons }
    }
    const value = Math.round((comps.filter((c) => c.available).reduce((s, c) => s + c.weight * c.value, 0) / availW) * 100)
    const band = SCORE_BANDS.find((b) => value >= b.min)
    return { status: 'ok', value, band: band.key, label: band.label, coverage, components: comps, note: 'Weights are initial hypotheses, not validated probabilities.' }
  }

  // ----- alerts ------------------------------------------------------

  evaluateAlerts(now, x) {
    const cfg = this.cfg
    const { windows, divergence, absorption, liquidity, breakouts, distribution, gate, qq, sigmaFor } = x
    const w1 = windows['1m'], w5 = windows['5m'], w15 = windows['15m']
    const conds = []
    const pct = (v) => `${(v * 100).toFixed(2)}%`
    const depthNote = liquidity.displayedOnly ? 'top of book only — no Level 2' : 'Level 2 depth'

    // Aggressive selling acceleration
    const sellRate1 = w1.sell, sellRate15 = w15.sell / 15
    if (gate.ok && w1.n >= 5 && sellRate15 > 0 && sellRate1 >= cfg.sellAccelMultiple * sellRate15 && (w1.deltaRatio ?? 0) <= -0.5 && (w1.ret ?? 0) < 0) {
      const sev = sellRate1 >= 2 * cfg.sellAccelMultiple * sellRate15 ? 3 : 2
      conds.push({ type: 'selling_acceleration', severity: sev, title: 'Aggressive selling accelerating', evidence: [`${Math.round(sellRate1).toLocaleString()} sh sold aggressively in 1 min vs ${Math.round(sellRate15).toLocaleString()}/min over 15 min (${(sellRate1 / sellRate15).toFixed(1)}×)`, `1-min net flow ${Math.round(w1.deltaRatio * 100)}%, price ${pct(Math.exp(w1.ret) - 1)}`] })
    }
    // Positive CVD, stalled price
    if (divergence.key === 'C') conds.push({ type: 'positive_cvd_stall', severity: absorption.active ? 2 : 1, title: 'Positive CVD but price stalled', evidence: divergence.evidence })
    // Sell-side absorption (multi-condition)
    if (absorption.active) conds.push({ type: 'sell_absorption', severity: absorption.met >= 4 ? 3 : 2, title: 'POTENTIAL SELL-SIDE ABSORPTION', evidence: absorption.conditions.filter((c) => c.met).map((c) => `${c.label}: ${c.detail}`) })
    // Bid liquidity disappearance
    if (liquidity.withdrawal && qq.ok) conds.push({ type: 'bid_withdrawal', severity: liquidity.withdrawal.dropPct >= 0.8 ? 3 : 2, title: 'Bid liquidity disappeared', evidence: [`displayed bid $ down ${Math.round(liquidity.withdrawal.dropPct * 100)}% vs 5-min median within ${cfg.withdrawalMs / 1000} s`, `only $${Math.round(liquidity.withdrawal.tradedUsd).toLocaleString()} sold into the bid — orders were pulled, not filled`] })
    // Failed breakout with elevated volume
    const fbHot = breakouts.recent.filter((f) => f.t > now - cfg.failedBreakMs && (f.volRatio ?? 0) >= 2)
    if (fbHot.length) conds.push({ type: 'failed_breakout', severity: fbHot[0].volRatio >= 4 ? 3 : 2, title: 'Failed breakout on heavy volume', evidence: [`broke $${fbHot[0].level}, peaked $${fbHot[0].peak}, closed back below`, `volume ${fbHot[0].volRatio.toFixed(1)}× the prior 30-min pace`] })
    // Spread widening
    if (qq.ok && liquidity.spreadRatio != null && liquidity.spreadRatio >= cfg.spreadWidenMultiple && liquidity.spreadMedian1m >= cfg.minSpreadWidenPct) conds.push({ type: 'spread_widening', severity: liquidity.spreadRatio >= 2 * cfg.spreadWidenMultiple ? 3 : 2, title: 'Spread widened materially', evidence: [`1-min median spread ${pct(liquidity.spreadMedian1m)} vs ${pct(liquidity.spreadBase30m)} 30-min median (${liquidity.spreadRatio.toFixed(1)}×)`] })
    // Repeated sell-side replenishment
    if (gate.ok && absorption.replenish && absorption.replenish.ratio >= cfg.replenishRatio) conds.push({ type: 'sell_replenishment', severity: absorption.replenish.ratio >= 2 * cfg.replenishRatio ? 2 : 1, title: 'Sell-side orders keep replenishing', evidence: [`${Math.round(absorption.replenish.traded).toLocaleString()} sh bought at $${absorption.replenish.price}, never more than ${Math.round(absorption.replenish.displayed).toLocaleString()} shown (${absorption.replenish.ratio.toFixed(1)}×)`, 'consistent with a refilling or hidden seller — the feed cannot identify who'] })
    // Momentum exhaustion
    const prev10 = aggregate(this.windowTrades(now - WINDOWS['5m'], 10 * 60_000))
    const s15 = sigmaFor(WINDOWS['15m'])
    if (gate.ok && s15 && w15.ret != null && w15.ret >= 2 * s15 && (w5.ret ?? 0) <= 0 && prev10.deltaRatio != null && w5.deltaRatio != null && prev10.deltaRatio - w5.deltaRatio >= 0.2 && w5.vol / 5 < prev10.vol / 10) {
      conds.push({ type: 'momentum_exhaustion', severity: 1, title: 'Momentum exhaustion', evidence: [`15-min gain ${pct(Math.exp(w15.ret) - 1)} (${(w15.ret / s15).toFixed(1)}σ) but flat-to-down last 5 min`, `net flow ${Math.round(prev10.deltaRatio * 100)}% → ${Math.round(w5.deltaRatio * 100)}%, volume pace falling`] })
    }
    // Possible bullish accumulation
    const lowsNow = this.windowTrades(now, WINDOWS['5m']).filter((r) => !r.excluded && !r.cancelled).map((r) => r.price)
    const lowsPrev = this.windowTrades(now - WINDOWS['5m'], 10 * 60_000).filter((r) => !r.excluded && !r.cancelled).map((r) => r.price)
    const higherLows = lowsNow.length && lowsPrev.length && Math.min(...lowsNow) > Math.min(...lowsPrev)
    const sellerPresent = absorption.active || (absorption.replenish?.ratio ?? 0) >= cfg.replenishRatio
    const healthy = !sellerPresent && (liquidity.bidRatio ?? 0) >= 0.9 && (liquidity.spreadRatio ?? 9) <= 1.3 && breakouts.count30m === 0
    if (gate.ok && healthy && higherLows && ((divergence.key === 'A' && (w15.deltaRatio ?? 0) >= cfg.mildDeltaRatio) || divergence.key === 'D')) {
      conds.push({ type: 'bullish_accumulation', severity: 1, title: divergence.key === 'D' ? 'Possible accumulation — selling absorbed by buyers' : 'Possible bullish accumulation', evidence: [...divergence.evidence, 'higher lows vs the prior 10 min', `bid $ ${Math.round((liquidity.bidRatio ?? 0) * 100)}% of median, spread ${(liquidity.spreadRatio ?? 0).toFixed(2)}× normal`] })
    }
    // Distribution (aggregate)
    if (distribution.level === 'hazardous' || distribution.level === 'possible') conds.push({ type: 'distribution', severity: distribution.level === 'hazardous' ? 3 : 2, title: `Distribution risk — ${distribution.character}`, evidence: distribution.factors.filter((f) => distribution.hot.includes(f.key)).map((f) => `${f.label}: ${f.detail}`) })

    const LIMITS = {
      common: ['Trade direction is inferred from quotes (Lee–Ready) — not observed. Hidden orders, dark-pool intent and future orders are not visible.'],
      selling_acceleration: ['Sellers lifting volume can be stop-losses or one holder; the feed cannot say who.'],
      positive_cvd_stall: ['A stall with positive CVD can also be passive sellers who stop soon — not proof of a large seller.'],
      sell_absorption: ['Absorption is inferred from prints vs quotes; refills can be several sellers, not one.'],
      bid_withdrawal: ['Displayed size only; cancels can be routine re-quoting by market makers.'],
      failed_breakout: ['Breaks are judged on 10-second buckets; a re-break can follow.'],
      spread_widening: ['Spreads widen naturally near the open, close, halts and in extended hours.'],
      sell_replenishment: ['Consistent with an iceberg or several sellers — the feed has no order IDs.'],
      momentum_exhaustion: ['Pauses after strong moves are common and often resume.'],
      bullish_accumulation: ['Buying can stop at any time; accumulation is inferred, not observed.'],
      distribution: ['Combines unvalidated factors; profit-taking and distribution look alike in prints.'],
    }

    const emitted = []
    const activeTypes = new Set(conds.map((c) => c.type))
    for (const [type, st] of this.alertState) if (!activeTypes.has(type)) st.active = false
    for (const c of conds) {
      const st = this.alertState.get(c.type)
      const escalated = st && c.severity > st.severity
      const fresh = !st || (!st.active && now - st.lastEmit >= cfg.alertCooldownMs)
      if (st) { st.active = true; if (!escalated && !fresh) { st.severity = Math.max(st.severity, c.severity); continue } }
      const alert = {
        id: `${this.symbol}:${c.type}:${now}`,
        t: now, symbol: this.symbol, type: c.type, severity: c.severity, title: c.title,
        evidence: c.evidence,
        quoteQuality: qq.grade, session: sessionOf(now),
        source: this.source, sourceLabel: (SOURCES[this.source] ?? SOURCES.synthetic).label,
        limitations: [...LIMITS.common, ...(LIMITS[c.type] ?? []), depthNote === 'top of book only — no Level 2' ? 'Liquidity read from the NBBO only (no Level 2).' : 'Level 2 is displayed liquidity; it can be cancelled.'],
        escalation: !!escalated,
      }
      this.alertState.set(c.type, { active: true, severity: c.severity, lastEmit: now })
      this.alerts.push(alert)
      emitted.push(alert)
    }
    if (this.alerts.length > 500) this.alerts.splice(0, this.alerts.length - 500)
    return emitted
  }
}

// Run a time-ordered event stream through an engine, snapshotting every
// `stepMs`. Events: { kind: 'quote'|'trade'|'book', t, … }. Returns the
// alerts and, optionally, the snapshots (for replay scrubbing).
export function runStream(events, { symbol, source = 'replay', config, context, stepMs = 5_000, keepSnapshots = false, onSnapshot } = {}) {
  const eng = new OrderFlowEngine({ symbol, source, config, context })
  const snaps = []
  let next = null
  for (const ev of events) {
    if (next == null) next = ev.t + stepMs
    while (ev.t >= next) {
      const s = eng.snapshot(next)
      if (keepSnapshots) snaps.push(s)
      onSnapshot?.(s, eng)
      next += stepMs
    }
    if (ev.kind === 'quote') eng.onQuote(ev)
    else if (ev.kind === 'book') eng.onBook(ev)
    else eng.onTrade(ev)
  }
  const last = events.length ? eng.snapshot(events[events.length - 1].t) : null
  if (last) { if (keepSnapshots) snaps.push(last); onSnapshot?.(last, eng) }
  return { engine: eng, alerts: eng.alerts.slice(), snapshots: snaps, last }
}

export { aggregate }
