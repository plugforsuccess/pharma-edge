import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { simulateCall, breakevenMoves, playContract, PLAYS } from '../utils/callHistory'

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
  notleader: ['NOT A LEADER', 'border-border text-subtle'],
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

export default function ConfluenceLeaders({ mine = [] }) {
  const [side, setSide] = useState('buy')
  const [scope, setScope] = useState('all')
  const [rows, setRows] = useState(null)
  const [accountSize, setAccountSize] = useState(null)
  // The play (owner, 2026-10-15): at-the-money calls — 1M / 3M / 6M / 12M
  // for a 1–2 week swing, or the ~2-year LEAPS held to compound.
  const [playKey, setPlayState] = useState(() => { try { const k = localStorage.getItem('cm:pullbacks-play'); return PLAYS.some((x) => x.key === k) ? k : '1M' } catch { return '1M' } })
  const setPlay = (k) => { setPlayState(k); try { localStorage.setItem('cm:pullbacks-play', k) } catch { /* storage off */ } }
  const play = PLAYS.find((x) => x.key === playKey)
  // "3+ signals" (owner, 2026-10-07): an opt-in stricter list on the buy
  // side — 2 stays the rule; this only filters. Remembered on the device.
  const [strict, setStrictState] = useState(() => { try { return localStorage.getItem('cm:pullbacks-3plus') === '1' } catch { return false } })
  const setStrict = (v) => { setStrictState(v); try { localStorage.setItem('cm:pullbacks-3plus', v ? '1' : '0') } catch { /* storage off */ } }
  const mineKey = mine.join(',')

  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(({ data }) => {
      if (!data?.user) return
      return supabase.from('profiles').select('account_size').eq('id', data.user.id).maybeSingle()
        .then(({ data: p }) => { if (!cancelled && p?.account_size > 0) setAccountSize(Number(p.account_size)) })
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setRows(null)
    let q = supabase.from('confluence_ranks')
      .select('ticker, side, as_of, close, score, rank, est_3m, est_6m, est_win_3m, est_win_6m, own_n, pool_n, verdict, hold_reason, blockers, trade, stop_price, momentum, call_hist, leader, leader_traits')
      .eq('side', side)
    if (side === 'buy' && strict) q = q.gte('score', 3)
    q = scope === 'all'
      ? q.not('rank', 'is', null).order('rank').limit(10)
      : q.in('ticker', mine.length ? mine : ['—']).order('score', { ascending: false }).limit(40)
    q.then(({ data, error }) => { if (!cancelled) setRows(error ? [] : data ?? []) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, scope, mineKey, strict])

  // Yours: ranked first, then by score.
  const list = useMemo(() => (scope === 'all' ? rows : rows && [...rows].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.score - a.score)), [rows, scope])
  const asOf = rows?.[0]?.as_of
  
  return (
    <section className="bg-card border border-border rounded-2xl mb-5 overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="flex-1 text-sm font-semibold">Pullbacks</h2>
          {asOf && <span className="text-[11px] text-muted">as of {day(asOf)}</span>}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Side">
            {[['buy', 'Buy · dips'], ['sell', 'Sell · stretched']].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={side === key} onClick={() => setSide(key)}
                className={clsx('min-h-[36px] px-2.5 rounded-md text-xs font-semibold transition whitespace-nowrap',
                  side === key ? (key === 'buy' ? 'bg-card text-confluence shadow-sm' : 'bg-card text-suite-bear shadow-sm') : 'text-muted hover:text-subtle')}>{label}</button>
            ))}
          </div>
          <span className="flex-1" />
          <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev" role="tablist" aria-label="Which tickers">
            {[['all', 'Top 10'], ['mine', 'Yours']].map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={scope === key} onClick={() => setScope(key)}
                className={clsx('min-h-[36px] px-2.5 rounded-md text-xs font-semibold transition whitespace-nowrap', scope === key ? 'bg-card text-fg shadow-sm' : 'text-muted hover:text-subtle')}>{label}</button>
            ))}
          </div>
        </div>
        {side === 'buy' && (
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" aria-pressed={strict} onClick={() => setStrict(!strict)}
              className={clsx('min-h-[32px] px-2.5 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1.5 transition',
                strict ? 'border-violet-400/50 bg-violet-400/10 text-violet-300' : 'border-border text-muted hover:text-subtle')}>
              {strict ? '✓' : '+'} 3+ signals
            </button>
            {strict && <span className="text-[11px] text-muted">Stricter: slightly better 3-month record, fewer names.</span>}
          </div>
        )}
        {side === 'buy' && <p className="mt-2 text-xs text-muted">Leaders only: stocks up strongly over the past year, well above a rising 200-day, with options cheap for them, while the S&P 500 is above its 200-day.</p>}
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
                          <span className="block text-[11px] text-muted">per contract{accountSize && ` · ${(perContract / accountSize * 100).toFixed(1)}% of account`}</span>
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
                        <span className="block text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Signals, but not a leader</span>
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
                  {side === 'buy' && r.trade && <PlayLab r={r} play={play} setPlay={setPlay} accountSize={accountSize} />}
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
function expiryLabel(t, play) {
  const d = new Date(`${t}T12:00:00Z`)
  return play.kind === 'leaps' ? monthYear(t) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric', timeZone: 'UTC' })
}

// "After past signals (all stocks), over 1M: stock +1% · this call +3%"
function PastLine({ ph, play }) {
  const s = ph?.pool?.setup
  if (!s?.n) return null
  return (
    <span className="mt-1.5 block text-xs text-muted">
      Past signals, all stocks, over {play.span}: stock <span className={clsx('font-mono-tab font-semibold', tone(s.stock))}>{pctS(s.stock)}</span>
      {' · '}{play.kind === 'leaps' ? 'LEAPS' : `${play.key} call`} to expiry <span className={clsx('font-mono-tab font-semibold', tone(s.avg))}>{pctS(s.avg)}</span>
    </span>
  )
}

function Cell({ avg, win }) {
  if (avg == null) return <td className="px-1.5 py-2 text-center text-muted">—</td>
  return (
    <td className="px-1.5 py-2 text-center">
      <span className={clsx('block font-semibold font-mono-tab', tone(avg))}>{pctS(avg)}</span>
      <span className="block text-[11px] text-muted font-mono-tab whitespace-nowrap">{Math.round(win * 100)}% up</span>
    </td>
  )
}

const BUDGETS = [1000, 5000, 10000, 40000]

function PlayLab({ r, play, setPlay, accountSize }) {
  const [open, setOpen] = useState(false)
  const [hold, setHold] = useState(null)
  const [budget, setBudgetState] = useState(() => { try { const b = Number(localStorage.getItem('cm:pullbacks-budget')); return BUDGETS.includes(b) ? b : 5000 } catch { return 5000 } })
  const setBudget = (b) => { setBudgetState(b); try { localStorage.setItem('cm:pullbacks-budget', String(b)) } catch { /* storage off */ } }
  const plays = r.call_hist?.plays
  // This stock (BUY SETUP; the 2-signal version under 3 cases) or all stocks.
  const ownSetupN = plays?.['1M']?.own?.setup?.n ?? 0
  const ownKey = ownSetupN >= 3 ? 'setup' : 'confluence'
  const [scopeH, setScopeH] = useState(() => ((plays?.['1M']?.own?.[ownKey]?.n ?? 0) >= 3 ? 'own' : 'pool'))
  const statOf = (p) => (scopeH === 'own' ? plays?.[p.key]?.own?.[ownKey] : plays?.[p.key]?.pool?.setup)
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
                {[['own', `${r.ticker}${ownKey === 'confluence' ? ' · 2+ signals' : ''}`], ['pool', 'All stocks']].map(([k, l]) => (
                  <button key={k} type="button" role="tab" aria-selected={scopeH === k} onClick={() => setScopeH(k)}
                    className={clsx('min-h-[36px] rounded-md text-xs font-semibold', scopeH === k ? 'bg-card text-violet-300 shadow-sm' : 'text-muted')}>{l}</button>
                ))}
              </div>
              <table className="w-full text-xs">
                <thead><tr className="text-muted">
                  <th className="text-left font-normal px-1.5 pb-1">After the signal</th>
                  <th className="font-normal px-1.5 pb-1 text-center">Stock</th>
                  <th className="font-normal px-1.5 pb-1 text-center">ATM call<span className="block text-[11px]">held to expiry</span></th>
                </tr></thead>
                <tbody className="divide-y divide-hairline">
                  {PLAYS.map((p) => {
                    const st = statOf(p)
                    return (
                      <tr key={p.key} onClick={() => setPlay(p.key)} className={clsx('cursor-pointer', p.key === play.key && 'bg-violet-400/10')}>
                        <td className="px-1.5 py-2 text-subtle whitespace-nowrap">{p.span}<span className="block text-[11px] text-muted">{st?.n ?? 0} {st?.n === 1 ? 'signal' : 'signals'}</span></td>
                        <Cell avg={st?.n ? st.stock : null} win={st?.stockWin} />
                        <Cell avg={st?.n ? st.avg : null} win={st?.win} />
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-1.5 text-[11px] text-muted">Same signals, same span: the stock's gain vs the {PLAYS.map((p) => p.span).join(' / ')} at-the-money call bought the next open and held to expiry.{scopeH === 'own' && n1 < 5 ? ' Few cases on this stock.' : ''}</p>
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
                  <span className="font-mono-tab">{qty}</span> × {expiryLabel(trade.expiry, play)} {money(trade.strike, trade.strike < 25 ? 2 : 0)} call · <span className="font-mono-tab">{money(cost, 0)}</span>{accountSize ? ` · ${(cost / accountSize * 100).toFixed(1)}% of account` : ''}
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
