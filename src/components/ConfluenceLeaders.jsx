import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, ExternalLink, Minus, Plus, Star, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { CHART_TICKERS } from '../lib/chartTickers'
import { betsOf } from '../utils/themes'
import { useTracking } from '../hooks/useTracking'
import { useAdvanced } from '../hooks/useAdvanced'
import { leaderFlags } from '../utils/riskFlags'
import { simulateCall, breakevenMoves, playContract, PLAYS, SWING_EXIT } from '../utils/callHistory'

// Charts → Pullbacks tab, formerly "Confluence leaders" (renamed 2026-10-07) (owner, 2026-10-03; verdicts 2026-10-04: "it's
// not telling me how to enter"; plain words 2026-10-04: "a novice user may
// find this confusing"): the universe ranked nightly by
// scripts/rank-confluence.mjs. Each row answers three questions in plain
// English — what to do, what it costs, when you're wrong — and one muted
// track-record line. Buy: BUY SETUP (early / confirmed) · NOT YET (what's
// missing, in words) · NOT IN AN UPTREND. Sell: STRETCHED · LOSING STEAM.
// Indicator names, per-share prices and the blended-history mechanics stay
// on the entry chart, which every row opens.
const VERDICT = {
  enter: ['LEADER · BUY', 'border-green-400/50 text-green-400'],
  notleader: ['NOT YET', 'border-border text-subtle'],
  wait: ['NOT YET', 'border-amber-400/50 text-amber-400'],
  hold: ['NOT NOW', 'border-rose-300/50 text-rose-300'],
  watch: ['NOT IN AN UPTREND', 'border-border text-subtle'],
  extended: ['STRETCHED', 'border-suite-bear/50 text-suite-bear'],
  turning: ['LOSING STEAM', 'border-border text-subtle'],
}
// What a missing buy-zone condition means, in words (the nightly row keeps
// the indicator version for the entry chart).
const PLAIN = {
  iv: 'options are too expensive right now',
  rsi: "hasn't pulled back enough",
  trend: 'short-term trend still down',
  rising: 'long-term trend is falling',
}
// A missed Leaders rule, in words (src/utils/leaders.js).
const MISS = {
  mom12: 'not strong enough over the past year',
  vs200: 'not far enough above its 200-day',
  slope200: '200-day not rising fast enough',
  volRank: 'options pricey vs its past year',
  spyUp: 'S&P 500 below its 200-day',
  history: 'not enough history',
}
const plainBlocker = (b) => (b.k === 'band' ? (/^Fall/.test(b.need ?? '') ? 'too far above its trend line' : 'too far below its trend line') : PLAIN[b.k] ?? b.label)
const money = (x, d = 2) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
// "about $1,200" — nearest $100 from $1,000, nearest $10 below.
const about = (x) => `about ${money(x >= 1000 ? Math.round(x / 100) * 100 : Math.round(x / 10) * 10, 0)}`
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')
const monthYear = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')
// Under this much room to the stop the row says the entry is at the edge of the zone.
const EDGE_ROOM = 0.03

// Five segments, one per signal (filled = lit today).
function SignalMeter({ score, side }) {
  const on = side === 'buy' ? 'bg-confluence' : 'bg-suite-bear'
  return (
    <span className="inline-flex items-center gap-1" aria-label={`${score} of 5 signals`}>
      <span className="flex gap-[3px]">{[0, 1, 2, 3, 4].map((i) => <span key={i} className={clsx('h-1.5 w-3 rounded-sm', i < score ? on : 'bg-border')} />)}</span>
      <span className="text-[11px] text-muted font-mono-tab">{score}/5</span>
    </span>
  )
}

// "+34% past year · 14% above a rising 200-day · options cheap for it"
function LeaderLine({ t }) {
  const p = (x) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}%`
  return (
    <span className="mt-2 block text-xs text-subtle">
      <span className="font-mono-tab text-green-400">{p(t.mom12)}</span> past year · <span className="font-mono-tab">{Math.round(t.vs200 * 100)}%</span> above a rising 200-day{t.volRank != null && <> · options cheap for it (<span className="font-mono-tab">{Math.round(t.volRank * 100)}</span>th pct)</>}
    </span>
  )
}

function Fact({ label, value, tone = 'text-fg' }) {
  return (
    <span className="min-w-0">
      <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">{label}</span>
      <span className={clsx('block text-sm leading-5 truncate', tone)}>{value}</span>
    </span>
  )
}

export default function ConfluenceLeaders({ mine: mineProp = [], leadersOnly = false }) {
  // ★ Favorites (owner, 2026-10-19) = the starred tickers only; holdings live
  // on Portfolio. The shared list updates the moment a star is tapped.
  const { tracking } = useTracking()
  const mine = leadersOnly ? (tracking ?? []) : mineProp
  // leadersOnly (owner, 2026-10-16: Charts is "only leaders"): buy side only.
  const [sideState, setSide] = useState('buy')
  const side = leadersOnly ? 'buy' : sideState
  const [scope, setScope] = useState('all')
  const [rows, setRows] = useState(null)
  // How many stocks are ranked today (owner, 2026-10-19: 38 leaders, the list
  // showed 10 and said "10 stocks meet the rule").
  const [total, setTotal] = useState(null)
  // The play (owner, 2026-10-15): at-the-money calls — 1M / 3M / 6M / 12M
  // for a 1–2 week swing, or the ~2-year LEAPS held to compound.
  const [playKey, setPlayState] = useState(() => { try { const k = localStorage.getItem('cm:pullbacks-play'); return PLAYS.some((x) => x.key === k) ? k : '1M' } catch { return '1M' } })
  const setPlay = (k) => { setPlayState(k); try { localStorage.setItem('cm:pullbacks-play', k) } catch { /* storage off */ } }
  // Leaders = LEAPS only (owner, 2026-10-16: the 1M … LEAPS selector was
  // confusing; LEAPS on leaders is the play the numbers support).
  const play = leadersOnly ? PLAYS.find((x) => x.key === 'LEAPS') : PLAYS.find((x) => x.key === playKey)
  // "3+ signals" (owner, 2026-10-07): an opt-in stricter list on the buy
  // side — 2 stays the rule; this only filters. Remembered on the device.
  const [strict, setStrictState] = useState(() => { try { return localStorage.getItem('cm:pullbacks-3plus') === '1' } catch { return false } })
  const setStrict = (v) => { setStrictState(v); try { localStorage.setItem('cm:pullbacks-3plus', v ? '1' : '0') } catch { /* storage off */ } }
  const mineKey = mine.join(',')
  // The market card links here (owner, 2026-10-19): ?leaders=all opens All N,
  // ?group=Oil filters the list to one group (over every ranked leader).
  const [params, setParams] = useSearchParams()
  const group = leadersOnly ? params.get('group') : null
  useEffect(() => {
    if (!leadersOnly) return
    if (params.get('leaders') === 'all' || params.get('group')) setScope('every')
    if (params.get('leaders')) { const p = new URLSearchParams(params); p.delete('leaders'); setParams(p, { replace: true }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])
  const clearGroup = () => { const p = new URLSearchParams(params); p.delete('group'); setParams(p, { replace: true }) }

  useEffect(() => {
    let cancelled = false
    setRows(null)
    let q = supabase.from('confluence_ranks')
      .select('ticker, side, as_of, close, score, rank, est_3m, est_6m, est_win_3m, est_win_6m, own_n, pool_n, verdict, hold_reason, blockers, trade, stop_price, momentum, call_hist, leader, leader_traits, spark')
      .eq('side', side)
    if (side === 'buy' && strict && !leadersOnly) q = q.gte('score', 3)
    q = scope === 'all' || scope === 'every'
      ? q.not('rank', 'is', null).order('rank').limit(scope === 'all' ? 10 : 200)
      : q.in('ticker', mine.length ? mine : ['—']).order(leadersOnly ? 'rank' : 'score', leadersOnly ? { ascending: true, nullsFirst: false } : { ascending: false }).limit(40)
    q.then(({ data, error }) => { if (!cancelled) setRows(error ? [] : data ?? []) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, scope, mineKey, strict])

  // Every ranked leader, light: the true count and the "Moves together" peers
  // across the whole list, not just the rows in view (owner, 2026-10-19).
  const [ranked, setRanked] = useState([])
  useEffect(() => {
    let cancelled = false
    supabase.from('confluence_ranks').select('ticker, rank, close, leader_traits').eq('side', side).not('rank', 'is', null).order('rank').limit(200)
      .then(({ data, error }) => { if (!cancelled && !error) { setRanked(data ?? []); setTotal((data ?? []).length) } })
    return () => { cancelled = true }
  }, [side])
  // What's driving each theme (theme-notes, nightly; newest per theme, last 7 days).
  const [notes, setNotes] = useState({})
  useEffect(() => {
    if (!leadersOnly) return
    let cancelled = false
    const since = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10)
    supabase.from('theme_notes').select('theme, as_of, driver, driver_source, risks').gte('as_of', since).order('as_of', { ascending: false }).limit(100)
      .then(({ data, error }) => {
        if (cancelled || error) return
        const m = {}
        for (const n of data ?? []) if (!m[n.theme]) m[n.theme] = n
        setNotes(m)
      })
    return () => { cancelled = true }
  }, [leadersOnly])

  // Yours: ranked first, then by score.
  const list = useMemo(() => (scope !== 'mine' ? rows : rows && [...rows].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.score - a.score)), [rows, scope])
  const asOf = rows?.[0]?.as_of

  if (leadersOnly) {
    const shown = group && list ? list.filter((r) => (r.leader_traits?.theme?.name ?? 'Other') === group) : list
    const pickScope = (k) => { if (group) clearGroup(); setScope(k) }
    return <LeadersView {...{ list: shown, scope, setScope: pickScope, strict, setStrict, play, playKey, setPlay, asOf, mine, total, ranked, notes, group, clearGroup }} />
  }

  return (
    <section className="bg-card border border-border rounded-2xl mb-5 overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="flex-1 text-sm font-semibold">{leadersOnly ? 'Leaders' : 'Pullbacks'}</h2>
          {asOf && <span className="text-[11px] text-muted">as of {day(asOf)}</span>}
        </div>
        <div className="mt-3 flex items-center gap-2">
          {!leadersOnly && <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Side">
            {[['buy', 'Buy · dips'], ['sell', 'Sell · stretched']].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={side === key} onClick={() => setSide(key)}
                className={clsx('min-h-[36px] px-2.5 rounded-md text-xs font-semibold transition whitespace-nowrap',
                  side === key ? (key === 'buy' ? 'bg-card text-confluence shadow-sm' : 'bg-card text-suite-bear shadow-sm') : 'text-muted hover:text-subtle')}>{label}</button>
            ))}
          </div>}
          {leadersOnly && (
            <button type="button" aria-pressed={strict} onClick={() => setStrict(!strict)}
              className={clsx('min-h-[36px] px-2.5 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 transition',
                strict ? 'border-violet-400/50 bg-violet-400/10 text-violet-300' : 'border-border text-muted hover:text-subtle')}>
              {strict ? '✓' : '+'} 3+ signals
            </button>
          )}
          <span className="flex-1" />
          <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Which tickers">
            {[['all', 'Top 10'], ['mine', 'Yours']].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={scope === key} onClick={() => setScope(key)}
                className={clsx('min-h-[36px] px-2.5 rounded-md text-xs font-semibold transition whitespace-nowrap', scope === key ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-subtle')}>{label}</button>
            ))}
          </div>
        </div>
        {!leadersOnly && side === 'buy' && (
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" aria-pressed={strict} onClick={() => setStrict(!strict)}
              className={clsx('min-h-[32px] px-2.5 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1.5 transition',
                strict ? 'border-violet-400/50 bg-violet-400/10 text-violet-300' : 'border-border text-muted hover:text-subtle')}>
              {strict ? '✓' : '+'} 3+ signals
            </button>
            {strict && <span className="text-[11px] text-muted">Stricter: slightly better 3-month record, fewer names.</span>}
          </div>
        )}
        {side === 'buy' && <p className="mt-2 text-xs text-muted">Leaders only: stocks up strongly over the past year, well above a rising 200-day, with options cheap for them.</p>}
        {side === 'buy' && (
          <div className="mt-3">
            <div className="grid grid-cols-5 gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Call">
              {PLAYS.map((x) => (
                <button key={x.key} type="button" role="tab" aria-selected={playKey === x.key} onClick={() => setPlay(x.key)}
                  className={clsx('min-h-[40px] rounded-md text-xs font-semibold', playKey === x.key ? 'bg-card text-violet-300 shadow-sm' : 'text-muted hover:text-subtle')}>{x.key}</button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted">At-the-money call · {play.kind === 'swing' ? `${play.key} to expiry · hold 1–2 weeks` : 'about 2 years · hold 6–12 months'}</p>
          </div>
        )}
        {side === 'sell' && <p className="mt-2 text-xs text-muted">2+ sell signals near a high. For shares and spreads; a LEAPS follows its exit plan.</p>}
      </div>
      {list === null ? (
        <div className="px-5 pb-5 space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-14 rounded-xl bg-bg-elev animate-pulse" />)}</div>
      ) : list.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-subtle">
          {side === 'buy' && strict ? 'No stock has 3 or more signals today. Turn off 3+ signals to see the 2-signal setups.'
            : scope === 'mine' ? (mine.length ? 'None of your tickers have signals today.' : 'Add tickers to Tracking or Portfolio to see them here.')
            : side === 'buy' ? 'No leader has 2+ signals today.' : 'No rankings yet — they run after each close.'}
        </div>
      ) : (
        <>
          <ul className="border-t border-hairline divide-y divide-hairline">
            {list.map((r) => {
              const v = VERDICT[r.verdict]
              const trade = r.verdict === 'enter' && r.trade ? playContract({ S: r.close, vol: r.trade.vol, asOf: r.as_of, play }) : null
              const perContract = trade ? trade.cost * 100 : null
              const ph = r.call_hist?.plays?.[playKey]
              const blockers = (r.blockers ?? []).map(plainBlocker)
              const room = r.stop_price != null && r.close > 0 ? 1 - r.stop_price / r.close : null
              const edge = room != null && room < EDGE_ROOM
              return (
                <li key={r.ticker}>
                  <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`} className="block px-5 py-4 hover:bg-card-hover/40 transition">
                    {/* Identity */}
                    <span className="flex items-center gap-2.5">
                      <span className={clsx('shrink-0 text-[11px] font-semibold font-mono-tab', r.rank ? 'text-muted' : 'text-muted/60')}>{r.rank ? `#${r.rank}` : '—'}</span>
                      <span className="text-base font-semibold text-fg leading-6">{r.ticker}</span>
                      <span className="text-xs text-subtle font-mono-tab">{money(r.close)}</span>
                      <span className="flex-1" />
                      {v && (
                        <span className={clsx('px-2 py-0.5 rounded-md border text-[11px] font-semibold tracking-wide whitespace-nowrap', v[1])}>
                          {v[0]}
                        </span>
                      )}
                      <ChevronRight size={15} className="shrink-0 text-muted" aria-hidden />
                    </span>

                    {/* The instruction */}
                    {trade && (
                      <span className="mt-3 flex items-end gap-3 rounded-xl bg-bg-elev px-3.5 py-3">
                        <span className="flex-1 min-w-0">
                          <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Buy</span>
                          <span className="block text-sm font-semibold text-fg leading-5">{expiryLabel(trade.expiry, play)} {money(trade.strike, trade.strike < 25 ? 2 : 0)} call</span>
                          <span className="block text-[11px] text-muted">{play.kind === 'swing' ? 'Hold 1–2 weeks' : 'Hold 6–12 months'}</span>
                        </span>
                        <span className="text-right">
                          <span className="block text-base font-semibold text-fg font-mono-tab leading-6">{about(perContract).replace('about ', '≈')}</span>
                          <span className="block text-[11px] text-muted">per contract</span>
                        </span>
                      </span>
                    )}
                    {r.verdict === 'wait' && blockers.length > 0 && (
                      <span className="mt-3 block rounded-xl bg-bg-elev px-3.5 py-3">
                        <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">{blockers.length === 1 ? 'Waiting on one thing' : 'Waiting on'}</span>
                        <span className="block text-sm text-amber-400 leading-5">{blockers.join(' · ')}</span>
                      </span>
                    )}
                    {r.verdict === 'hold' && (
                      <span className="mt-3 block rounded-xl bg-bg-elev px-3.5 py-3">
                        <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Not now</span>
                        <span className="block text-sm text-rose-300 leading-5">The rule is met, but {r.hold_reason}.</span>
                      </span>
                    )}
                    {r.verdict === 'notleader' && (
                      <span className="mt-3 block rounded-xl bg-bg-elev px-3.5 py-3">
                        <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Not yet a leader</span>
                        <span className="block text-sm text-subtle leading-5">{(r.leader_traits?.misses ?? []).map((m) => MISS[m] ?? m).join(' · ') || 'misses the Leaders rule'}</span>
                      </span>
                    )}
                    {r.verdict === 'watch' && (
                      <span className="mt-3 block rounded-xl bg-bg-elev px-3.5 py-3 text-sm text-subtle leading-5">Signals, but the long-term trend is falling — the rule doesn’t buy here.</span>
                    )}
                    {side === 'sell' && r.verdict && (
                      <span className="mt-3 block rounded-xl bg-bg-elev px-3.5 py-3">
                        <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">{r.verdict === 'extended' ? 'Stretched after a run' : 'Momentum fading'}</span>
                        <span className="block text-sm text-fg leading-5">Sell signal for shares and spreads · a LEAPS follows its exit plan</span>
                      </span>
                    )}

                    {/* Two facts */}
                    {trade && (
                      <span className="mt-3 grid grid-cols-2 gap-3">
                        <Fact label="Momentum" value={r.momentum === 'up' ? 'Rising · confirmed' : 'Falling · early'} tone={r.momentum === 'up' ? 'text-green-400' : 'text-amber-400'} />
                        {r.stop_price != null && (
                          <Fact label="Exit below" tone={edge ? 'text-amber-400' : 'text-fg'}
                            value={<><span className="font-mono-tab">{money(r.stop_price)}</span>{room != null && <span className={clsx('text-xs', edge ? 'text-amber-400' : 'text-muted')}> · {(room * 100).toFixed(1)}% away</span>}</>} />
                        )}
                      </span>
                    )}
                    {trade && r.leader_traits && <LeaderLine t={r.leader_traits} />}
                    {trade && edge && <span className="mt-1.5 block text-[11px] text-amber-400">This entry sits at the bottom edge of the buy zone.</span>}

                    {/* Signals + one line of history */}
                    <span className="mt-3 block"><SignalMeter score={r.score} side={side} /></span>
                    {side === 'buy' && <PastLine ph={ph} play={play} />}
                  </Link>
                  {side === 'buy' && r.trade && <PlayLab r={r} play={play} setPlay={setPlay} />}
                </li>
              )
            })}
          </ul>
        </>
      )}
      <Link to="/charts/record" className="px-5 py-3 border-t border-hairline flex items-center gap-2 text-xs text-subtle hover:text-fg">
        <span className="flex-1">Signal record: how these signals traded as LEAPS, every ticker</span>
        <ChevronRight size={14} aria-hidden />
      </Link>
      <p className="px-5 pb-3 text-[11px] text-muted">
        Option prices are estimates, not quotes. Past results are the stock’s, not advice. Rankings change after every close.
      </p>
    </section>
  )
}

// Past results & what-if (owner, 2026-10-15: "it is crowded … 1, 3, 6, 12,
// LEAPS on pullbacks"; then "compared to itself on the same signal for the
// same durations as the calls … spot gain over 1M, 3M, 6M, 12M, 2 year"):
// after past signals, the stock's gain over each span beside the matching
// at-the-money call held to expiry (confluence_ranks.call_hist.plays,
// nightly), then today's contract valued for a stock move after each hold.
const pctS = (x, d = 0) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const usd0 = (x) => `${x < 0 ? '−' : '+'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`
const tone = (x) => (x == null ? 'text-muted' : x >= 0 ? 'text-green-400' : 'text-rose-300')
const holdWords = { '1W': '1 week', '2W': '2 weeks', '6M': '6 months', '12M': '12 months' }
// Short expiries read as the date ("Nov 20"), LEAPS as the month ("Jan 2029").
// Six months before expiry: the playbook's out-or-roll date.
function rollBy(expiry) {
  const d = new Date(`${expiry}T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 6)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function expiryLabel(t, play) {
  const d = new Date(`${t}T12:00:00Z`)
  return play.kind === 'leaps' ? monthYear(t) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric', timeZone: 'UTC' })
}

// "After past signals (all stocks), over 1M: stock +1% · this call +3%"
// One line under the Buy card: the play graded on the exit plan, all leaders.
function PastLine({ ph, play }) {
  const e = ph?.pool?.exit
  if (!e?.n) return null
  return (
    <span className="mt-1.5 block text-xs text-muted">
      Past leaders with your exit plan: typical trade <span className={clsx('font-mono-tab font-semibold', tone(e.median))}>{pctS(e.median)}</span>
      {' · '}profitable {oneIn10(e.win)}
    </span>
  )
}

// "7 of 10" — plain odds instead of "71% up" (owner, 2026-10-16).
const oneIn10 = (w) => (w == null ? '—' : `${Math.round(w * 10)} of 10 times`)

// A history cell (owner, 2026-10-16): the typical result (median) as the
// headline, how often (higher / profitable, out of 10), the bad case (the
// worst quarter) and the average, smaller.
function Cell({ s, kind }) {
  if (!s?.n) return <td className="px-1.5 py-2 text-center text-muted align-top">—</td>
  const stock = kind === 'stock'
  const med = stock ? s.stockMedian : s.median
  const win = stock ? s.stockWin : s.win
  const bad = stock ? s.stockBadq : s.badq
  const avg = stock ? s.stock : s.avg
  return (
    <td className="px-1.5 py-2 text-center align-top">
      <span className={clsx('block text-sm font-semibold font-mono-tab', tone(med))}>{pctS(med)}</span>
      <span className="block text-[11px] text-subtle whitespace-nowrap">{stock ? 'higher' : 'profitable'} {win == null ? '—' : `${Math.round(win * 10)} of 10`}</span>
      {bad != null && <span className="block text-[11px] text-muted font-mono-tab whitespace-nowrap">1 in 4: {pctS(bad)} or worse</span>}
      {avg != null && <span className="block text-[11px] text-muted font-mono-tab whitespace-nowrap">avg {pctS(avg)}</span>}
    </td>
  )
}

const BUDGETS = [1000, 5000, 10000, 40000]

function PlayLab({ r, play, setPlay, rows = PLAYS }) {
  const [open, setOpen] = useState(false)
  const [hold, setHold] = useState(null)
  const [budget, setBudgetState] = useState(() => { try { const b = Number(localStorage.getItem('cm:pullbacks-budget')); return BUDGETS.includes(b) ? b : 5000 } catch { return 5000 } })
  const setBudget = (b) => { setBudgetState(b); try { localStorage.setItem('cm:pullbacks-budget', String(b)) } catch { /* storage off */ } }
  const plays = r.call_hist?.plays
  // This stock (BUY SETUP; the 2-signal version under 3 cases) or all stocks.
  // History on leader days (one per 21 trading days); older rows carry the
  // signal-based setup / 2-signal history until the nightly run refreshes.
  const ownKey = plays?.['1M']?.own?.leader ? 'leader' : (plays?.['1M']?.own?.setup?.n ?? 0) >= 3 ? 'setup' : 'confluence'
  const [scopeH, setScopeH] = useState(() => ((plays?.['1M']?.own?.[ownKey]?.n ?? 0) >= 3 ? 'own' : 'pool'))
  const statOf = (p) => (scopeH === 'own' ? plays?.[p.key]?.own?.[ownKey] : plays?.[p.key]?.pool?.leader ?? plays?.[p.key]?.pool?.setup)
  const exitOf = (p) => plays?.[p.key]?.[scopeH]?.exit
  const hk = play.holds.some((h) => h[0] === hold) ? hold : play.holds.at(-1)[0]
  const trade = useMemo(() => playContract({ S: r.close, vol: r.trade?.vol, asOf: r.as_of, play }), [r, play])
  const sim = useMemo(() => (open && trade ? simulateCall({ S: r.close, trade, asOf: r.as_of, moves: play.moves, horizons: play.holds }) : null), [open, r, trade, play])
  const be = useMemo(() => (open && trade ? breakevenMoves({ S: r.close, trade, asOf: r.as_of, horizons: play.holds }) : null), [open, r, trade, play])
  const qty = trade ? Math.max(1, Math.floor(budget / (trade.cost * 100))) : 1
  const cost = trade ? trade.cost * 100 * qty : null
  const rowsH = sim?.find((x) => x.label === hk)
  const beH = be?.find((x) => x.label === hk)
  const n1 = statOf(PLAYS[0])?.n ?? 0
  return (
    <div className="px-5 pb-4 -mt-1">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="min-h-[40px] w-full flex items-center gap-2 rounded-xl border border-border px-3.5 text-xs font-semibold text-violet-300 hover:bg-card-hover/40">
        <span className="flex-1 text-left">Past results & what-if</span>
        <ChevronDown size={14} className={clsx('transition', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          {plays?.['1M']?.pool ? (
            <div>
              <div className="grid grid-cols-2 gap-0.5 p-0.5 rounded-lg bg-bg-elev mb-2" role="tablist" aria-label="Whose history">
                {[['own', r.ticker], ['pool', 'All leaders']].map(([k, l]) => (
                  <button key={k} type="button" role="tab" aria-selected={scopeH === k} onClick={() => setScopeH(k)}
                    className={clsx('min-h-[36px] rounded-md text-xs font-semibold', scopeH === k ? 'bg-card text-violet-300 shadow-sm' : 'text-muted')}>{l}</button>
                ))}
              </div>
              <table className="w-full text-xs">
                <thead><tr className="text-muted">
                  <th className="text-left font-normal px-1.5 pb-1">After buying</th>
                  <th className="font-normal px-1.5 pb-1 text-center">Stock<span className="block text-[11px]">over the span</span></th>
                  <th className="font-normal px-1.5 pb-1 text-center">Call<span className="block text-[11px]">with your exit plan</span></th>
                </tr></thead>
                <tbody className="divide-y divide-hairline">
                  {rows.map((p) => {
                    const st = statOf(p)
                    const ex = exitOf(p)
                    return (
                      <tr key={p.key} onClick={() => setPlay(p.key)} className={clsx('cursor-pointer', p.key === play.key && 'bg-violet-400/10')}>
                        <td className="px-1.5 py-2 text-subtle whitespace-nowrap">{p.span}<span className="block text-[11px] text-muted">{st?.n ?? 0} {st?.n === 1 ? 'signal' : 'signals'}</span></td>
                        <Cell s={st} kind="stock" />
                        <Cell s={ex} kind="call" />
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11px] text-muted">Past days it was a leader (one a month). Big number = the typical trade (the middle one). Stock = its move over the span. Call = the at-the-money call bought the next open and sold on your exit plan{rows.length === 1 && rows[0].kind === 'leaps' ? ' (70% at +100%, 15% at +200%, the rest on a 30% trail, out with 6 months left)' : `: 1M–12M sell it all at +${Math.round(SWING_EXIT.target * 100)}%, else after 2 weeks; LEAPS sell 70% at +100%, 15% at +200%, trail the rest 30%`}.{scopeH === 'own' && n1 < 5 ? ' Few cases on this stock.' : ''}{!plays?.['1M']?.pool?.exit ? ' Exit-plan results arrive with the next nightly run.' : ''}</p>
            </div>
          ) : <p className="text-[11px] text-muted">Past results arrive with the next nightly run.</p>}
          {trade && rowsH && (
            <div>
              <div className="grid grid-cols-4 gap-0.5 p-0.5 rounded-lg bg-bg-elev mb-2" role="tablist" aria-label="Amount">
                {BUDGETS.map((b) => (
                  <button key={b} type="button" role="tab" aria-selected={budget === b} onClick={() => setBudget(b)}
                    className={clsx('min-h-[36px] rounded-md text-xs font-semibold font-mono-tab', budget === b ? 'bg-card text-violet-300 shadow-sm' : 'text-muted')}>${b / 1000}k</button>
                ))}
              </div>
              <div className="flex items-center gap-2 mb-2">
                <span className="flex-1 text-xs text-subtle">
                  <span className="font-mono-tab">{qty}</span> × {expiryLabel(trade.expiry, play)} {money(trade.strike, trade.strike < 25 ? 2 : 0)} call · <span className="font-mono-tab">{money(cost, 0)}</span>
                </span>
                <span className="grid grid-cols-2 gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Held for">
                  {play.holds.map(([l]) => (
                    <button key={l} type="button" role="tab" aria-selected={hk === l} onClick={() => setHold(l)}
                      className={clsx('min-h-[32px] px-2 rounded-md text-xs font-semibold', hk === l ? 'bg-card text-violet-300 shadow-sm' : 'text-muted')}>{l}</button>
                  ))}
                </span>
              </div>
              <table className="w-full text-xs font-mono-tab">
                <thead><tr className="text-muted text-right"><th className="text-left font-normal pb-1">{r.ticker} in {holdWords[hk]}</th><th className="font-normal pb-1">Worth</th><th className="font-normal pb-1">Profit</th></tr></thead>
                <tbody className="divide-y divide-hairline">
                  {rowsH.cells.map((c) => (
                    <tr key={c.move} className="text-right">
                      <td className="text-left py-1.5"><span className={c.move === 0 ? 'text-subtle' : tone(c.move)}>{c.move === 0 ? 'flat' : pctS(c.move)}</span> <span className="text-muted">{money(r.close * (1 + c.move))}</span></td>
                      <td className="py-1.5">{money(c.value * 100 * qty, 0)}</td>
                      <td className={clsx('py-1.5 font-semibold', tone(c.pnl))}>{usd0(c.pnl * qty)} <span className="font-normal text-[11px]">{pctS(c.ret)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11px] text-muted">
                Break-even in {holdWords[hk]}: {beH?.move == null ? '—' : <>{pctS(beH.move, 1)} ({money(r.close * (1 + beH.move))})</>}. Estimates from past volatility, not quotes.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Leaders, Robinhood-style (owner, 2026-10-16: "Can we make the UI state
// of the art like Robinhood app?"). A quiet list — ticker and the play on
// the left, a 3-month sparkline, a price pill coloured by the 3-month move —
// and a tap opens the row in place: hero price, a large sparkline, the play,
// four stat tiles, history, past results & what-if and the chart button.

export function Sparkline({ values, className, height = 32, fill = false }) {
  const id = useMemo(() => `sp${Math.random().toString(36).slice(2, 8)}`, [])
  if (!values || values.length < 2) return <span className={className} style={{ height }} />
  const lo = Math.min(...values), hi = Math.max(...values)
  const span = hi - lo || 1
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 100 - ((v - lo) / span) * 100])
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  return (
    <svg viewBox="0 -4 100 108" preserveAspectRatio="none" className={className} style={{ height }} aria-hidden>
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${d} L100,104 L0,104 Z`} fill={`url(#${id})`} stroke="none" />
        </>
      )}
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// Risk flags on an opened leader (owner, 2026-10-19: risks over plays).
const FLAG_TONE = { red: 'border-red-400/30 bg-red-400/5 text-red-300', amber: 'border-amber-400/30 bg-amber-400/5 text-amber-300', neutral: 'border-border bg-bg-elev text-fg' }
function RiskFlags({ flags }) {
  if (!flags.length) {
    return <div className="mt-4 rounded-2xl bg-bg-elev px-4 py-3 text-sm text-subtle">No risk flags today — no earnings in the next two weeks, not stretched, not commodity-driven.</div>
  }
  return (
    <div className="mt-4 space-y-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Risks to watch</div>
      {flags.map((f) => (
        <div key={f.key} className={clsx('rounded-2xl border px-4 py-3', FLAG_TONE[f.tone])}>
          <div className="text-sm font-semibold">{f.title}</div>
          <div className="mt-0.5 text-sm text-subtle">{f.body}</div>
        </div>
      ))}
    </div>
  )
}

// Moves together (owner, 2026-10-19: copy from "Same bet"; "the companies … listed clearly with links to
// them"): every ranked leader in the same industry theme, one tappable row
// each — a leader in view opens in place, any other opens its chart.
function SameBet({ sameBet, tone, onJump }) {
  const { theme, peers } = sameBet
  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}%`
  return (
    <div className={clsx('mt-2 rounded-2xl border overflow-hidden', tone ? tone.card : 'border-violet-400/30 bg-violet-400/5')}>
      <div className="px-4 pt-3 pb-2">
        <div className={clsx('text-sm font-semibold', tone ? tone.text : 'text-violet-300')}>
          {theme ? `Moves together: ${theme}` : 'Moves together with:'}
        </div>
        <div className="mt-0.5 text-xs text-subtle">
          When one falls, the others usually do too. Owning several is like owning one bigger position.
        </div>
      </div>
      <ul className="divide-y divide-hairline border-t border-hairline">
        {peers.slice(0, 6).map((p) => {
          const tr = p.leader_traits
          const name = companyName(p.ticker)
          return (
            <li key={p.ticker}>
              <button type="button" onClick={() => onJump(p.ticker)}
                className="w-full min-h-[52px] px-4 py-2 flex items-center gap-3 text-left hover:bg-card-hover/40 transition">
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[15px] font-semibold text-fg">{p.ticker}</span>
                    {p.rank != null && <span className="text-[11px] text-muted font-mono-tab">#{p.rank}</span>}
                  </span>
                  {name && <span className="block text-xs text-subtle truncate">{name}</span>}
                </span>
                {tr?.mom12 != null && (
                  <span className="text-right">
                    <span className="block text-sm font-semibold font-mono-tab text-green-400">{pct(tr.mom12)}</span>
                    <span className="block text-[11px] text-muted">past year</span>
                  </span>
                )}
                <ChevronRight size={16} className="text-muted shrink-0" aria-hidden />
              </button>
            </li>
          )
        })}
      </ul>
      {peers.length > 6 && <div className="px-4 py-2 text-[11px] text-muted border-t border-hairline">and {peers.length - 6} more</div>}
    </div>
  )
}

// What's driving the theme (theme-notes, nightly news summary with sources).
const KIND_LABEL = { geopolitical: 'Geopolitical', macro: 'Macro', company: 'Company', regulatory: 'Regulatory', commodity: 'Commodity', event: 'Event' }
function Src({ s }) {
  if (!s?.url) return null
  return (
    <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[11px] text-muted hover:text-fg underline decoration-dotted underline-offset-2">
      {s.name}{s.date ? `, ${day(s.date)}` : ''}<ExternalLink size={10} aria-hidden />
    </a>
  )
}
function ThemeNote({ note, theme }) {
  return (
    <div className="mt-2 rounded-2xl bg-bg-elev px-4 py-3">
      <div className="text-sm font-semibold">What's driving {theme ?? 'it'}</div>
      <p className="mt-1 text-sm text-subtle">{note.driver} <Src s={note.driver_source} /></p>
      {note.risks?.length > 0 && (
        <>
          <div className="mt-2.5 text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">What could reverse it</div>
          <ul className="mt-1 space-y-1.5">
            {note.risks.map((k, i) => (
              <li key={i} className="text-sm text-subtle">
                <span className="font-semibold text-amber-300">{KIND_LABEL[k.kind] ?? 'Risk'}:</span> {k.text} <Src s={k} />
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-2 text-[11px] text-muted">News summary · {day(note.as_of)} · not advice</div>
    </div>
  )
}

// Tracking star (owner, 2026-10-19): starred tickers land in "Yours" and get
// the "new leader" alert.
export function StarButton({ starred, onClick, ticker, className }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={!!starred}
      aria-label={starred ? `Remove ${ticker} from Favorites` : `Add ${ticker} to Favorites`}
      className={clsx('w-11 shrink-0 flex items-center justify-center transition', starred ? 'text-amber-400' : 'text-muted hover:text-fg', className)}>
      <Star size={18} className={starred ? 'fill-current' : ''} aria-hidden />
    </button>
  )
}

function Pill({ active, onClick, children, label }) {
  return (
    <button type="button" aria-pressed={active} aria-label={label} onClick={onClick}
      className={clsx('shrink-0 min-h-[36px] px-3.5 rounded-full text-[13px] font-semibold transition whitespace-nowrap',
        active ? 'bg-fg text-bg' : 'bg-card border border-border text-subtle hover:text-fg')}>
      {children}
    </button>
  )
}

function Tile({ label, value, sub, tone = 'text-fg' }) {
  return (
    <div className="rounded-2xl bg-bg-elev px-3.5 py-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('mt-0.5 text-base font-semibold font-mono-tab leading-6', tone)}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  )
}

function LeadersView({ list, scope, setScope, strict, setStrict, play, playKey, setPlay, asOf, mine, total, ranked, notes, group = null, clearGroup }) {
  const [open, setOpen] = useState(null)
  const navigate = useNavigate()
  // Stocks first (owner, 2026-10-19); the option play is the Advanced view.
  const [advanced] = useAdvanced()
  // Earnings in the next two weeks, for the risk flags.
  const [earnings, setEarnings] = useState({})
  const tickersKey = (ranked ?? []).map((x) => x.ticker).join(',')
  useEffect(() => {
    if (!tickersKey) return
    let cancelled = false
    const today = new Date().toISOString().slice(0, 10)
    const until = new Date(Date.now() + 15 * 86400e3).toISOString().slice(0, 10)
    supabase.from('earnings_calendar').select('ticker, earnings_date, announcement_time')
      .in('ticker', tickersKey.split(',')).gte('earnings_date', today).lte('earnings_date', until).order('earnings_date')
      .then(({ data, error }) => {
        if (cancelled || error) return
        const m = {}
        for (const e of data ?? []) if (!m[e.ticker]) m[e.ticker] = { date: e.earnings_date, time: e.announcement_time }
        setEarnings(m)
      })
    return () => { cancelled = true }
  }, [tickersKey])
  // Ranked leaders by theme, for each row's "Moves together" list.
  const byTheme = useMemo(() => {
    const m = new Map()
    for (const x of ranked ?? []) { const th = x.leader_traits?.theme?.name; if (th) { if (!m.has(th)) m.set(th, []); m.get(th).push(x) } }
    return m
  }, [ranked])
  const rankedBy = useMemo(() => new Map((ranked ?? []).map((x) => [x.ticker, x])), [ranked])
  // A peer in view opens in place; any other goes to its chart.
  const jump = (sym) => {
    if (list?.some((x) => x.ticker === sym)) {
      setOpen(sym)
      requestAnimationFrame(() => document.getElementById(`leader-${sym}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } else navigate(`/charts/entry/${encodeURIComponent(sym)}`)
  }
  const { isTracked, toggle } = useTracking()
  // What kind of bet each leader is (owner, 2026-10-16): leaders sharing an
  // industry theme are one bet — "Top 10 = 5 bets: Chips 4 · Oil 2 …".
  const bets = useMemo(() => betsOf((list ?? []).filter((r) => r.verdict === 'enter')
    .map((r) => ({ ticker: r.ticker, theme: r.leader_traits?.theme?.name ?? null }))), [list])
  const betOf = useMemo(() => {
    const m = new Map()
    bets.filter((b) => !b.alone).forEach((b, k) => b.tickers.forEach((t) => m.set(t, { name: b.name, peers: b.tickers.filter((x) => x !== t), tone: BET_TONES[k % BET_TONES.length] })))
    return m
  }, [bets])
  return (
    <section id="leaders" className="mb-5 scroll-mt-16">
      <div className="mb-4">
        <div className="text-[11px] text-muted">{asOf ? `As of ${day(asOf)} close` : 'Ranked after each close'}</div>
        <h2 className="mt-0.5 text-[28px] leading-9 font-semibold tracking-tight">Leaders</h2>
        <p className="text-sm text-subtle">
          {/* Plain words for beginners (owner, 2026-10-19: "12 stocks meet the
              Leaders rule" wasn't good copy) — the count lives on the chips. */}
          {group ? `${group} stocks in strong uptrends`
            : scope === 'mine' ? 'Stocks you’ve starred'
            : 'Stocks in the strongest uptrends right now'}
        </p>
      </div>

      <div className="-mx-4 px-4 flex gap-2 overflow-x-auto no-scrollbar pb-1">
        {group && (
          <button type="button" onClick={clearGroup} aria-label={`Show every group, not just ${group}`}
            className="shrink-0 min-h-[36px] pl-3.5 pr-2.5 rounded-full text-[13px] font-semibold bg-amber-400/15 text-amber-300 border border-amber-400/30 inline-flex items-center gap-1.5">
            {group} <X size={14} aria-hidden />
          </button>
        )}
        <Pill active={!group && scope === 'all'} onClick={() => setScope('all')}>Top 10</Pill>
        {total > 10 && <Pill active={!group && scope === 'every'} onClick={() => setScope('every')}>All {total}</Pill>}
        <Pill active={!group && scope === 'mine'} onClick={() => setScope('mine')} label="Favorites">
          <span className="inline-flex items-center gap-1.5"><Star size={14} aria-hidden className="fill-current text-amber-400" />Favorites</span>
        </Pill>
      </div>

      {/* The play and its exit, once for the whole list (owner, 2026-10-16:
          LEAPS only; exits confirmed — the playbook, no price stop). Advanced
          view only (owner, 2026-10-19). */}
      {advanced && <div className="mt-3 rounded-2xl bg-card border border-border px-4 py-3">
        <div className="text-sm font-semibold">The play: an at-the-money call about 2 years out</div>
        <ol className="mt-1.5 space-y-0.5 text-xs text-subtle list-decimal pl-4">
          <li>Sell 70% when the call is up 100% (your cost back plus profit)</li>
          <li>Sell 15% more at +200%</li>
          <li>Let the last 15% run; sell it after a 30% drop from its peak</li>
          <li>Out or roll with 6 months left. No price stop.</li>
        </ol>
      </div>}

      {list === null ? (
        <div className="mt-4 space-y-px" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded-xl bg-card animate-pulse mb-2" />)}</div>
      ) : list.length === 0 ? (
        <div className="mt-6 rounded-2xl bg-card border border-border p-5 text-sm text-subtle">
          {scope === 'mine' ? (mine.length ? 'None of your favorites are in our stock list yet.' : 'Tap ☆ on any stock to add it here.')
            : 'No stock meets the Leaders rule today. The list updates after each close.'}
        </div>
      ) : (
        <ul className="mt-4 rounded-2xl bg-card border border-border overflow-hidden divide-y divide-hairline">
          {list.map((r) => (
            <LeaderRow key={r.ticker} r={r} bet={betOf.get(r.ticker)} play={play} setPlay={setPlay}
              starred={isTracked(r.ticker)} onStar={() => toggle(r.ticker)}
              sameBet={(() => {
                const th = r.leader_traits?.theme?.name
                const peers = th ? (byTheme.get(th) ?? []).filter((x) => x.ticker !== r.ticker) : []
                if (peers.length) return { theme: th, peers }
                const mw = (r.leader_traits?.moves_with ?? []).map((t) => rankedBy.get(t) ?? { ticker: t })
                return mw.length ? { theme: null, peers: mw } : null
              })()}
              note={notes?.[r.leader_traits?.theme?.name]} onJump={jump} advanced={advanced}
              flags={leaderFlags({ traits: r.leader_traits, earnings: earnings[r.ticker], asOf: r.as_of, groupSize: (byTheme.get(r.leader_traits?.theme?.name)?.length ?? 1) })}
              open={open === r.ticker} onToggle={() => setOpen(open === r.ticker ? null : r.ticker)} />
          ))}
        </ul>
      )}

      {/* Factual, the same for everyone (owner, 2026-10-19: "leaders have done
          better as a group than one at a time" — the 5-year stock test). */}
      <p className="mt-4 px-1 text-sm text-subtle">Over the past 5 years, leaders have done better as a group than one at a time.</p>
      <Link to="/charts/leader-record" className="mt-1 min-h-[44px] px-1 flex items-center gap-2 text-sm text-subtle hover:text-fg">
        <span className="flex-1">Leader record: how each stock has moved since joining</span>
        <ChevronRight size={14} aria-hidden />
      </Link>
      {/* The option-trade research is the Advanced view (owner, 2026-10-19). */}
      {advanced && (
        <Link to="/charts/record" className="min-h-[44px] px-1 flex items-center gap-2 text-xs text-subtle hover:text-fg">
          <span className="flex-1">Signal record: how these signals traded as options</span>
          <ChevronRight size={14} aria-hidden />
        </Link>
      )}
      <p className="px-1 text-[11px] text-muted">General information, the same for every subscriber — not personalized investment advice.{advanced ? ' Option prices are estimates, not quotes.' : ''} Past results don't guarantee future results.</p>
    </section>
  )
}

// Company names for the open row's header (owner, 2026-10-16). The ticker
// list keeps terse labels; these fill the ones whose label is the symbol.
const FULL_NAMES = {
  ADP: 'Automatic Data Processing', AIG: 'American International Group', AMD: 'Advanced Micro Devices',
  ASML: 'ASML Holding', CSX: 'CSX Corp.', EQT: 'EQT Corp.', FIS: 'Fidelity National Information Services',
  IBM: 'International Business Machines', IFF: 'International Flavors & Fragrances', KKR: 'KKR & Co.',
  MSCI: 'MSCI Inc.', NVR: 'NVR Inc.', PTC: 'PTC Inc.', RTX: 'RTX Corp.', SLB: 'SLB (Schlumberger)',
  UDR: 'UDR Inc.', UPS: 'United Parcel Service',
}
const NAME_OF = new Map(CHART_TICKERS.map((t) => [t.symbol, t.label]))
const companyName = (sym) => {
  const n = FULL_NAMES[sym] ?? NAME_OF.get(sym)
  return n && n !== sym ? n : null
}

// One colour per bet in view (theme tokens / Tailwind ramps, never hex).
const BET_TONES = [
  { chip: 'bg-amber-400/15 text-amber-300', text: 'text-amber-300', card: 'border-amber-400/30 bg-amber-400/5' },
  { chip: 'bg-sky-400/15 text-sky-300', text: 'text-sky-300', card: 'border-sky-400/30 bg-sky-400/5' },
  { chip: 'bg-violet-400/15 text-violet-300', text: 'text-violet-300', card: 'border-violet-400/30 bg-violet-400/5' },
  { chip: 'bg-teal-400/15 text-teal-300', text: 'text-teal-300', card: 'border-teal-400/30 bg-teal-400/5' },
  { chip: 'bg-orange-400/15 text-orange-300', text: 'text-orange-300', card: 'border-orange-400/30 bg-orange-400/5' },
  { chip: 'bg-pink-400/15 text-pink-300', text: 'text-pink-300', card: 'border-pink-400/30 bg-pink-400/5' },
]

function LeaderRow({ r, bet, play, setPlay, open, onToggle, starred, onStar, sameBet, note, onJump, advanced, flags = [] }) {
  const isLeader = r.verdict === 'enter'
  const trade = useMemo(() => (isLeader && r.trade ? playContract({ S: r.close, vol: r.trade.vol, asOf: r.as_of, play }) : null), [isLeader, r, play])
  const spark = r.spark?.length ? r.spark : null
  const move = spark ? spark[spark.length - 1] / spark[0] - 1 : null
  const up = move == null || move >= 0
  const per = trade ? trade.cost * 100 : null
  const t = r.leader_traits
  const ph = r.call_hist?.plays?.[play.key]
  const why = (t?.misses ?? []).map((m) => MISS[m] ?? m)
  // Since joining the list (owner, 2026-10-19: the leader record).
  // The change first, so a narrow row keeps it ("+12% since Sep 2").
  const since = t?.since ? `${pctS(t.since.gain, Math.abs(t.since.gain) < 0.1 ? 1 : 0)} since ${new Date(`${t.since.on}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : null
  const sub = isLeader && !advanced && t ? `${since ?? `${pctS(t.mom12)} past year · ${Math.round(t.vs200 * 100)}% above its 200-day`}${flags.some((f) => f.tone === 'red') ? ' · ⚠' : ''}`
    : isLeader && trade ? `${expiryLabel(trade.expiry, play)} ${money(trade.strike, trade.strike < 25 ? 2 : 0)} call · ${about(per).replace('about ', '')}`
    : r.verdict === 'notleader' ? `Not yet a leader${why[0] ? ` · ${why[0]}` : ''}`
    : r.verdict === 'watch' ? 'Long-term trend falling' : 'Signals today'
  return (
    <li id={`leader-${r.ticker}`} className="scroll-mt-16">
      <div className="flex items-stretch">
      {/* A spacer the star's width keeps the open header centered. */}
      {open && <span className="w-11 shrink-0" aria-hidden />}
      <button type="button" onClick={onToggle} aria-expanded={open}
        className={clsx('flex-1 min-w-0 min-h-[68px] pl-4 py-3 flex items-center gap-3 hover:bg-card-hover/40 transition', open ? 'justify-center text-center pr-0' : 'text-left pr-1')}>
        {/* Open (owner, 2026-10-16): no sparkline or price pill — the ticker
            and the call sit centered above the hero price and 3M chart. */}
        <span className={clsx('min-w-0', open ? 'flex-none' : 'flex-1')}>
          <span className={clsx('flex items-center gap-1.5', open && 'justify-center')}>
            <span className={clsx('font-semibold text-fg', open ? 'text-[28px] leading-9 font-bold tracking-tight' : 'text-[15px]')}>{r.ticker}</span>
            {!open && bet && <span className={clsx('shrink-0 whitespace-nowrap px-1.5 py-px rounded-full text-[11px] font-semibold', bet.tone.chip)}>{bet.name}</span>}
          </span>
          {open
            ? companyName(r.ticker) && <span className="mt-0.5 block truncate text-sm font-semibold text-amber-300">{companyName(r.ticker)}</span>
            : <span className={clsx('block text-xs truncate', isLeader ? 'text-subtle' : 'text-muted')}>{sub}</span>}
        </span>
        {!open && (
          <>
            <Sparkline values={spark} className={clsx('w-[72px] shrink-0', up ? 'text-green-400' : 'text-red-400', !isLeader && 'opacity-50')} />
            <span className={clsx('shrink-0 min-w-[78px] px-2.5 py-1.5 rounded-lg text-[13px] font-semibold font-mono-tab text-center',
              !isLeader ? 'bg-bg-elev text-subtle' : up ? 'bg-green-400 text-bg' : 'bg-red-400 text-bg')}>
              {money(r.close)}
            </span>
          </>
        )}
      </button>
      <StarButton starred={starred} onClick={onStar} ticker={r.ticker} />
      </div>

      {open && (
        <div className="px-4 pb-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <div className="text-[28px] leading-9 font-semibold font-mono-tab tracking-tight">{money(r.close)}</div>
              {move != null && <div className={clsx('text-sm font-semibold font-mono-tab', up ? 'text-green-400' : 'text-red-400')}>{`${move >= 0 ? '+' : '−'}${Math.abs(move * 100).toFixed(1)}%`} <span className="font-normal text-muted">past 3 months</span></div>}
            </div>
            {isLeader
              ? <span className="mb-1 px-2 py-1 rounded-full bg-green-400/10 text-green-400 text-[11px] font-semibold">Leader</span>
              : <span className="mb-1 px-2 py-1 rounded-full bg-bg-elev text-subtle text-[11px] font-semibold">{r.verdict === 'watch' ? 'Not in an uptrend' : 'Not yet'}</span>}
          </div>
          <Sparkline values={spark} fill height={96} className={clsx('mt-3 w-full', up ? 'text-green-400' : 'text-red-400')} />

          {isLeader && !advanced && <RiskFlags flags={flags} />}

          {advanced && trade ? (
            <div className="mt-4 rounded-2xl bg-bg-elev p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-lg font-semibold leading-7 whitespace-nowrap">{expiryLabel(trade.expiry, play)} {money(trade.strike, trade.strike < 25 ? 2 : 0)} call</div>
                  <div className="text-xs text-subtle">{play.kind === 'swing' ? 'Hold 1–2 weeks' : 'About 2 years to expiry'}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-semibold font-mono-tab leading-8">{about(per).replace('about ', '≈')}</div>
                  <div className="text-[11px] text-muted">per contract</div>
                </div>
              </div>
              {play.kind === 'leaps' && (
                <div className="mt-3 pt-3 border-t border-hairline grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <span className="text-muted">Sell 70%</span><span className="text-right font-mono-tab"><span className="text-green-400 font-semibold">{about(per * 2).replace('about ', '≈')}</span> <span className="text-muted">per contract · +100%</span></span>
                  <span className="text-muted">Sell 15%</span><span className="text-right font-mono-tab"><span className="text-green-400 font-semibold">{about(per * 3).replace('about ', '≈')}</span> <span className="text-muted">per contract · +200%</span></span>
                  <span className="text-muted">Last 15%</span><span className="text-right text-subtle">after a 30% drop from its peak</span>
                  <span className="text-muted">Out or roll by</span><span className="text-right font-mono-tab text-subtle">{rollBy(trade.expiry)}</span>
                </div>
              )}
            </div>
          ) : !isLeader && why.length > 0 && (
            <div className="mt-4 rounded-2xl bg-bg-elev p-4">
              <div className="text-[11px] text-muted">What it still needs</div>
              <div className="mt-0.5 text-sm text-subtle">{why.join(' · ')}</div>
            </div>
          )}

          {isLeader && note && <ThemeNote note={note} theme={t?.theme?.name} />}

          {isLeader && sameBet && <SameBet sameBet={sameBet} tone={bet?.tone} onJump={onJump} />}

          {isLeader && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {t && <Tile label="200-day trend" value={`${t.slope200 >= 0 ? '+' : '−'}${Math.abs(t.slope200 * 100).toFixed(1)}%`} sub="rise over 20 days" tone="text-green-400" />}
              {advanced
                ? <Tile label="Price stop" value="None" sub="exit on the plan, not a price" />
                : <Tile label="Off its high" value={t?.off20 != null ? `${Math.round(t.off20 * 100)}%` : '—'} sub="under its 20-day high" />}
              {t && <Tile label="Past year" value={`${t.mom12 >= 0 ? '+' : '−'}${Math.round(Math.abs(t.mom12) * 100)}%`} sub={`${Math.round(t.vs200 * 100)}% above its 200-day`} tone="text-green-400" />}
              {t && (advanced
                ? <Tile label="Option price" value={t.volRank != null ? `${Math.round(t.volRank * 100)}th pct` : '—'} sub="cheap for this stock" />
                : <Tile label="Volatility" value={t.volRank != null ? `${Math.round(t.volRank * 100)}th pct` : '—'} sub="calm vs its past year" />)}
            </div>
          )}

          {advanced && <PastLine ph={ph} play={play} />}

          {advanced && <div className="mt-3 -mx-5"><PlayLab r={r} play={play} setPlay={setPlay} rows={[play]} /></div>}

          <Link to={`/charts/entry/${encodeURIComponent(r.ticker)}`}
            className="mt-1 min-h-[48px] w-full rounded-full bg-amber-400 text-bg text-sm font-semibold flex items-center justify-center gap-1.5">
            Open {r.ticker} chart <ChevronRight size={16} aria-hidden />
          </Link>
        </div>
      )}
    </li>
  )
}
