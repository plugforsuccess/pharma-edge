// Cross-sectional momentum entries for the replay (owner, 2026-10-05:
// "Word" — measure the one entry family with out-of-sample support against
// the same controls as the chart signals). Pure; `npm run momentum:check`.
//
// The rule, fixed before any result exists:
//   at each completed month end, every ticker with 12 months of history
//   gets a score = its return over the 12 months ending one month ago
//   (the classic 12-1: skip the latest month, which tends to reverse);
//   eligible = close above its own 200-day average; the top decile of the
//   eligible names (at least MOMENTUM.minNames scored that month) are the
//   entries at that bar — the replay buys the next open and runs the same
//   exit playbook as every other rule. A name already held is not re-bought
//   (the replay's one-trade-at-a-time rule). No look-ahead: a month end is
//   known only once the next month's first bar exists, and the score uses
//   closes up to that bar.
//
// This is a universe-level rule (it needs every ticker's score for the
// month), so it runs in the universe job, not on the entry chart.

export const MOMENTUM = Object.freeze({ lookback: 252, skip: 21, topFrac: 0.10, minNames: 30 })

const monthOf = (t) => String(t).slice(0, 7)

// Indexes of the last bar of each completed month (the bar before a month
// change). The final bar is left out: its month may not be over.
export function monthEndIndexes(bars) {
  const out = []
  for (let i = 0; i + 1 < bars.length; i++) if (monthOf(bars[i].t) !== monthOf(bars[i + 1].t)) out.push(i)
  return out
}

// 12-1 return at bar i, or null without enough history.
export function momentumScore(closes, i, p = MOMENTUM) {
  const a = closes[i - p.lookback]
  const b = closes[i - p.skip]
  return i >= p.lookback && a > 0 && b > 0 ? b / a - 1 : null
}

// items: [{ ticker, bars, s200 }] → { entries: Map(ticker → boolean[]),
// months: [{ month, names, picked }] }
export function crossSectionalEntries(items, p = MOMENTUM) {
  const byMonth = new Map()
  for (const it of items) {
    const closes = it.bars.map((b) => b.c)
    for (const i of monthEndIndexes(it.bars)) {
      const score = momentumScore(closes, i, p)
      const s200 = it.s200?.[i]
      if (score == null || s200 == null || !(closes[i] > s200)) continue
      const m = monthOf(it.bars[i].t)
      if (!byMonth.has(m)) byMonth.set(m, [])
      byMonth.get(m).push({ ticker: it.ticker, i, score })
    }
  }
  const entries = new Map(items.map((it) => [it.ticker, new Array(it.bars.length).fill(false)]))
  const months = []
  for (const m of [...byMonth.keys()].sort()) {
    const list = byMonth.get(m)
    if (list.length < p.minNames) { months.push({ month: m, names: list.length, picked: 0 }); continue }
    list.sort((a, b) => b.score - a.score)
    const k = Math.max(1, Math.floor(list.length * p.topFrac))
    for (const x of list.slice(0, k)) entries.get(x.ticker)[x.i] = true
    months.push({ month: m, names: list.length, picked: k })
  }
  return { entries, months }
}
