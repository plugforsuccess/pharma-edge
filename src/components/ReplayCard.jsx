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
const pctS = (x) => (x == null ? '—' : Math.abs(x) < 0.005 ? '0%' : `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`)
const share = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const day = (t) => new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' }).replace(/, (\d\d)$/, ', ’$1')
const money = (x) => `$${x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2)}`
const p = EXIT_PLAYBOOK
// One line per rule, shown under the pickers.
const RULE_TEXT = {
  confluence: '2+ buy signals, 200-day rising',
  zone: 'Buy zone turns YES',
  bravo: 'Bravo bull ◆, 200-day rising',
  targets: `${share(p.fractions[0])} at ${1 + p.targets[0]}x · ${share(p.fractions[1])} at ${1 + p.targets[1]}x · trail the rest ${share(p.runnerTrailPct)}`,
  signals: 'All out on 2+ sell signals',
  both: `${share(p.fractions[0])} at ${1 + p.targets[0]}x, then 2+ sell signals`,
}
const REASON = { t1: 'T1', t2: 'T2', trail: 'Trail', signal: 'Signal', time: 'Time stop' }

function loadRules() {
  try {
    const v = JSON.parse(localStorage.getItem(RULES_KEY) ?? 'null')
    if (v && ENTRY_RULES.some(([k]) => k === v.entry) && EXIT_RULES.some(([k]) => k === v.exit)) return v
  } catch { /* storage unavailable */ }
  return { entry: 'confluence', exit: 'targets' }
}

export default function ReplayCard({ bars, model, suite, onJumpDay }) {
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

  const caughtOf = graded.stats.moves - graded.stats.held
  const put = rp.puts?.falling ?? null
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <div className="px-5 pt-5">
        <div className="flex items-baseline gap-2">
          <h2 className="flex-1 text-sm font-semibold">Replay</h2>
          <span className="text-[11px] text-muted">as LEAPS · no hindsight</span>
        </div>
        <Segmented label="Buy" items={ENTRY_RULES} value={rules.entry} onChange={(v) => setRule('entry', v)} hint={RULE_TEXT[rules.entry]} />
        <Segmented label="Sell" items={EXIT_RULES} value={rules.exit} onChange={(v) => setRule('exit', v)} hint={RULE_TEXT[rules.exit]} />
      </div>

      <div className="px-5 pt-5 pb-4 grid grid-cols-3 gap-3">
        <Big label="Avg trade" value={pctS(st.avg)} tone={st.avg} />
        <Big label="Win rate" value={share(st.winRate)} />
        <Big label="Trades" value={String(st.n)} sub={st.n > st.closed ? `${st.n - st.closed} open` : null} />
      </div>

      {caughtOf > 0 && (
        <div className="px-5 pb-4">
          <div className="flex items-baseline text-xs">
            <span className="flex-1 text-subtle">Big moves caught <span className="text-muted">(+{share(MOVE.minGain)} off a low)</span></span>
            <span className="font-mono-tab text-fg">{graded.stats.caught} of {caughtOf}</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-bg-elev overflow-hidden" aria-hidden>
            <div className="h-full rounded-full bg-confluence" style={{ width: `${(graded.stats.caught / caughtOf) * 100}%` }} />
          </div>
          {graded.stats.avgKept != null && <div className="mt-1 text-[11px] text-muted">Kept {share(graded.stats.avgKept)} of each move caught</div>}
        </div>
      )}

      {put && put.stats.n > 0 && (
        <div className="px-5 pb-4">
          <div className="flex items-baseline text-xs">
            <span className="flex-1 text-subtle">Puts <span className="text-muted">· spreads on 2+ sell signals, 200-day falling</span></span>
            <span className={clsx('font-mono-tab', put.stats.avg == null ? 'text-muted' : put.stats.avg < 0 ? 'text-rose-300' : 'text-green-400')}>{pctS(put.stats.avg)} avg</span>
          </div>
          <div className="mt-1 text-[11px] text-muted font-mono-tab">
            {put.stats.n} trades · {share(put.stats.winRate)} win · {Math.round(put.stats.avgDays ?? 0)} days
            {put.dropStats.drops - put.dropStats.held > 0 && <> · drops caught {put.dropStats.caught} of {put.dropStats.drops - put.dropStats.held}</>}
          </div>
        </div>
      )}

      {trades.length > 0 ? (
        <ul className="border-t border-hairline divide-y divide-hairline">
          {shown.map((t) => (
            <li key={t.i} {...row(t.i)}>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-fg font-mono-tab">{day(t.t)} → {t.open ? 'now' : day(t.endT)}</span>
                <span className="block text-xs text-muted font-mono-tab truncate">
                  {money(t.strike)} call{t.exits.length ? ` · ${t.exits.map((x) => `${REASON[x.reason]} ${x.mult.toFixed(1)}x`).join(' · ')}` : ' · open'}
                </span>
              </span>
              <span className={clsx('shrink-0 text-sm font-semibold font-mono-tab', t.optionReturn < 0 ? 'text-rose-300' : 'text-green-400')}>{pctS(t.optionReturn)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 pb-4 text-sm text-subtle">No trades on this rule.</p>
      )}
      {trades.length > 8 && (
        <button type="button" onClick={() => setAll(!all)} className="w-full min-h-[44px] border-t border-hairline text-xs font-semibold text-subtle hover:text-fg">
          {all ? 'Show fewer' : `Show all ${trades.length}`}
        </button>
      )}

      {missed.length > 0 && (
        <>
          <div className="px-5 pt-4 pb-1 border-t border-hairline text-[11px] uppercase tracking-wider text-muted">Missed</div>
          <ul className="divide-y divide-hairline">
            {missed.slice().reverse().map((m) => (
              <li key={m.lowI} {...row(m.lowI)}>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-fg font-mono-tab">{day(m.lowT)} → {day(m.peakT)}</span>
                  <span className="block text-xs text-muted">{m.why}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold font-mono-tab text-subtle">{pctS(m.gain)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <Link to="/charts/record" className="px-5 min-h-[48px] border-t border-hairline flex items-center gap-2 text-xs text-subtle hover:text-fg">
        <span className="flex-1">Every ticker</span>
        <ChevronRight size={14} aria-hidden />
      </Link>
      <p className="px-5 pb-4 text-[11px] text-muted">Estimated option prices. Past results, not advice.</p>
    </section>
  )
}

function Big({ label, value, tone, sub }) {
  return (
    <div className="min-w-0">
      <div className={clsx('text-2xl font-semibold tracking-tight font-mono-tab leading-none truncate',
        tone == null ? 'text-fg' : tone < 0 ? 'text-rose-300' : 'text-green-400')}>{value}</div>
      <div className="mt-1.5 text-[11px] text-muted truncate">{label}{sub ? ` · ${sub}` : ''}</div>
    </div>
  )
}

function Segmented({ label, items, value, onChange, hint }) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <span className="w-8 shrink-0 text-[11px] text-muted">{label}</span>
        <div className="flex-1 flex gap-1 p-1 rounded-xl bg-bg-elev" role="tablist" aria-label={label}>
          {items.map(([k, text]) => (
            <button key={k} type="button" role="tab" aria-selected={value === k} onClick={() => onChange(k)}
              className={clsx('flex-1 min-w-0 min-h-[36px] px-1 rounded-lg text-xs font-semibold transition truncate',
                value === k ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-subtle')}>
              {text}
            </button>
          ))}
        </div>
      </div>
      {hint && <div className="mt-1 pl-10 text-[11px] text-muted">{hint}</div>}
    </div>
  )
}
