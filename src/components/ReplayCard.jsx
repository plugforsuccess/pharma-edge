import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { replayModel, ENTRY_RULES, EXIT_RULES, MOVE } from '../utils/replay'
import { EXIT_PLAYBOOK } from '../utils/afterTax'

// Entry chart → Replay (owner, 2026-10-03: NOW +84% — "how can the app
// suggest this trade and signal the exit?"). This ticker's history walked
// day by day with only what was known at each close: buy a ~2-year,
// 0.75-delta call on the chosen signal, exit by the chosen rule. Option
// prices are Black-Scholes estimates (no option history in the app). Big
// moves are found after the fact, only to grade the entries.
const RULES_KEY = 'cm:replay-rules'
const pctS = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`)
const share = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const day = (t) => new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' }).replace(/, (\d\d)$/, ', ’$1')
const money = (x) => `$${x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2)}`
const p = EXIT_PLAYBOOK
const EXIT_TEXT = {
  targets: `Exit targets: sell ${share(p.fractions[0])} at +${share(p.targets[0])}, ${share(p.fractions[1])} at +${share(p.targets[1])}, the rest on a ${share(p.runnerTrailPct)} give-back from its peak.`,
  signals: 'Sell everything when 2+ sell signals agree (5-day window).',
  both: `Exit targets first; after +${share(p.targets[0])}, 2+ sell signals close the rest.`,
}
const ENTRY_TEXT = {
  confluence: '2+ buy signals agree (5-day window) with the 200-day rising.',
  zone: 'The buy zone turns YES.',
  bravo: 'A Bravo bull diamond with the 200-day rising.',
}
const REASON = { t1: 'T1', t2: 'T2', trail: 'Trail', signal: 'Signal', time: 'Time stop' }

function loadRules() {
  try {
    const v = JSON.parse(localStorage.getItem(RULES_KEY) ?? 'null')
    if (v && ENTRY_RULES.some(([k]) => k === v.entry) && EXIT_RULES.some(([k]) => k === v.exit)) return v
  } catch { /* storage unavailable */ }
  return { entry: 'confluence', exit: 'targets' }
}

export default function ReplayCard({ ticker, bars, model, suite, onJumpDay }) {
  const [rules, setRules] = useState(loadRules)
  const [all, setAll] = useState(false)
  const setRule = (k, v) => {
    const next = { ...rules, [k]: v }
    setRules(next)
    try { localStorage.setItem(RULES_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }
  const rp = useMemo(() => (bars?.length >= 300 && model && suite ? replayModel({ bars, model, suite }) : null), [bars, model, suite])
  if (!rp) return null
  const run = rp.runs[`${rules.entry}:${rules.exit}`]
  const st = run.stats
  const graded = rp.graded[rules.entry]
  const trades = [...run.trades].reverse()
  const shown = all ? trades : trades.slice(0, 8)
  const missed = graded.graded.filter((g) => !g.caught && !g.held)
  const row = (i) => ({
    role: 'button', tabIndex: 0, onClick: () => onJumpDay?.(i), onKeyDown: (e) => { if (e.key === 'Enter') onJumpDay?.(i) },
    className: 'px-5 py-3 flex items-center gap-3 cursor-pointer hover:bg-card-hover/40 transition',
  })

  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-sm font-semibold">Replay · {ticker} LEAPS</h2>
        <p className="mt-1 text-xs text-muted">
          Day by day, using only what was known at each close: a ~2-year, 0.75-delta call bought the day after the signal.
        </p>
        <Segmented label="Buy on" items={ENTRY_RULES} value={rules.entry} onChange={(v) => setRule('entry', v)} />
        <p className="mt-1.5 text-xs text-subtle">{ENTRY_TEXT[rules.entry]}</p>
        <Segmented label="Sell by" items={EXIT_RULES} value={rules.exit} onChange={(v) => setRule('exit', v)} />
        <p className="mt-1.5 text-xs text-subtle">{EXIT_TEXT[rules.exit]} Out with 6 months left either way.</p>
      </div>

      <div className="px-5 pb-4 grid grid-cols-2 gap-2">
        <Tile label="Trades" value={String(st.n)} sub={st.n > st.closed ? `${st.n - st.closed} open` : 'closed'} />
        <Tile label="Win rate" value={share(st.winRate)} sub={`${st.closed} closed`} />
        <Tile label="Avg" value={pctS(st.avg)} tone={st.avg} sub="option" />
        <Tile label="Median" value={pctS(st.median)} tone={st.median} sub="option" />
      </div>

      <div className="mx-5 mb-4 rounded-xl bg-bg-elev px-4 py-3 text-xs">
        <div className="text-fg font-semibold">
          Big moves (+{share(MOVE.minGain)} within 6 months of a low): caught {graded.stats.caught} of {graded.stats.moves - graded.stats.held}
          {graded.stats.held ? <span className="text-muted font-normal"> · {graded.stats.held} while already holding</span> : null}
        </div>
        <div className="mt-1 text-muted">
          A catch = a signal from {MOVE.early} days before the low until half the move was done.
          {graded.stats.avgKept != null && <> The trades kept {share(graded.stats.avgKept)} of those moves.</>}
        </div>
      </div>

      {trades.length > 0 ? (
        <ul className="border-t border-hairline divide-y divide-hairline">
          {shown.map((t) => (
            <li key={t.i} {...row(t.i)}>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-fg font-mono-tab">{day(t.t)} → {t.open ? 'open' : day(t.endT)}</span>
                <span className="block text-xs text-muted font-mono-tab">
                  {money(t.strike)} call · cost {money(t.cost * 100)} · {t.exits.map((x) => `${REASON[x.reason]} ${x.mult.toFixed(1)}x`).join(' · ') || 'no exit yet'}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className={clsx('block text-sm font-semibold font-mono-tab', t.optionReturn < 0 ? 'text-rose-300' : 'text-green-400')}>{pctS(t.optionReturn)}</span>
                <span className="block text-[11px] text-muted font-mono-tab">stock {pctS(t.stockReturn)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 pb-4 text-sm text-subtle">No entries on this rule in this history.</p>
      )}
      {trades.length > 8 && (
        <button type="button" onClick={() => setAll(!all)} className="w-full min-h-[44px] border-t border-hairline text-xs font-semibold text-subtle hover:text-fg">
          {all ? 'Show fewer' : `Show all ${trades.length}`}
        </button>
      )}

      {missed.length > 0 && (
        <>
          <div className="px-5 pt-4 pb-1 border-t border-hairline text-[11px] uppercase tracking-wider text-muted">Missed moves</div>
          <ul className="divide-y divide-hairline">
            {missed.slice().reverse().map((m) => (
              <li key={m.lowI} {...row(m.lowI)}>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-fg font-mono-tab">{day(m.lowT)} → {day(m.peakT)}</span>
                  <span className="block text-xs text-muted">{m.why}{m.bestScore ? ` · best ${m.bestScore}/5` : ''}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold font-mono-tab text-green-400">{pctS(m.gain)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <Link to="/charts/record" className="px-5 py-3 border-t border-hairline flex items-center gap-2 text-xs text-subtle hover:text-fg">
        <span className="flex-1">How these rules did across every ticker</span>
        <ChevronRight size={14} aria-hidden />
      </Link>
      <p className="px-5 pb-4 text-[11px] text-muted">
        Option prices are Black-Scholes estimates from the stock&apos;s recent volatility, with 2% slippage on every fill. Real fills differ. Past results, not advice.
      </p>
    </section>
  )
}

function Segmented({ label, items, value, onChange }) {
  return (
    <div className="mt-3">
      <div className="text-[11px] text-muted mb-1">{label}</div>
      <div className="flex gap-1 p-1 rounded-xl bg-bg-elev" role="tablist" aria-label={label}>
        {items.map(([k, text]) => (
          <button key={k} type="button" role="tab" aria-selected={value === k} onClick={() => onChange(k)}
            className={clsx('flex-1 min-w-0 min-h-[36px] px-1 rounded-lg text-xs font-semibold transition truncate',
              value === k ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-subtle')}>
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

function Tile({ label, value, sub, tone }) {
  return (
    <div className="rounded-xl bg-bg-elev px-3 py-3 min-w-0">
      <div className="text-[11px] text-muted font-semibold">{label}</div>
      <div className={clsx('mt-1 text-base font-semibold font-mono-tab leading-none truncate',
        tone == null ? 'text-fg' : tone < 0 ? 'text-rose-300' : 'text-green-400')}>{value}</div>
      <div className="text-[11px] text-muted mt-1 truncate">{sub}</div>
    </div>
  )
}
