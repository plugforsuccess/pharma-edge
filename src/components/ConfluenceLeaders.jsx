import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { simulateCall, breakevenMoves, CALL_HORIZONS } from '../utils/callHistory'

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
  enter: ['BUY SETUP', 'border-green-400/50 text-green-400'],
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
const plainBlocker = (b) => (b.k === 'band' ? (/^Fall/.test(b.need ?? '') ? 'too far above its trend line' : 'too far below its trend line') : PLAIN[b.k] ?? b.label)
const money = (x, d = 2) => `$${Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
// "about $1,200" — nearest $100 from $1,000, nearest $10 below.
const about = (x) => `about ${money(x >= 1000 ? Math.round(x / 100) * 100 : Math.round(x / 10) * 10, 0)}`
const pct0 = (x) => `${Math.round(Math.abs(x) * 100)}%`
const day = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')
const monthYear = (t) => (t ? new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '')
const THIN_POOL = 30
// Under this much room to the stop the row says the entry is at the edge of the zone.
const EDGE_ROOM = 0.03
const FEW_OWN = 5

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

// Plain sentences, each number with its context: how often the pattern
// appeared, how often it worked against how often any random day worked,
// the typical result, the bad quarter, beat the market, and that the call
// moves more than the stock.
function TrackRecord({ r, side, baseline }) {
  const H = side === 'buy' ? '6m' : '3m'
  const avg = r[`est_${H}`]
  const win = r[`est_win_${H}`]
  const med = r[`est_med_${H}`]
  const badq = r[`est_badq_${H}`]
  const beat = r[`est_beat_${H}`]
  if (avg == null || !r.pool_n) return null
  const t = r.verdict === 'enter' ? r.trade : null
  const levRaw = t && t.cost > 0 && r.close > 0 ? (t.delta * r.close) / t.cost : null
  const lev = levRaw ? (levRaw < 3 ? levRaw.toFixed(1) : String(Math.round(levRaw))) : null
  const times = (k) => (k === 1 ? 'once' : k === 2 ? 'twice' : `${k.toLocaleString('en-US')} times`)
  const own = r.own_n === 0 ? `never on ${r.ticker}` : `${times(r.own_n)} on ${r.ticker}`
  const num = (x, cls = 'text-fg') => <span className={clsx('font-mono-tab', cls)}>{x}</span>
  const seen = <>Seen {num(times(r.pool_n), 'text-subtle')} across all stocks ({own}).</>
  if (r.pool_n < THIN_POOL) return <p className="mt-2 text-[11px] leading-4 text-muted">{seen} Too few to judge.</p>
  const months = side === 'buy' ? 'Six' : 'Three'
  const dir = side === 'buy' ? 'higher' : 'lower'
  const baseWin = baseline?.[`win_${H}`]
  const vs = baseWin == null || win == null ? null
    : win - baseWin > 0.08 ? 'better than' : win - baseWin < -0.08 ? 'worse than' : 'about the same as'
  const good = (x) => (side === 'buy' ? x >= 0 : x <= 0)
  const signed = (x) => `${x >= 0 ? '+' : '−'}${pct0(x)}`
  // The bad quarter reads as a loss for buys, a rise for sells.
  const badText = badq == null ? null
    : side === 'buy'
      ? (badq < 0 ? <>one case in four lost more than {num(pct0(badq), 'text-rose-300')}</> : <>even the worst quarter of cases gained {num(pct0(badq), 'text-green-400')} or more</>)
      : (badq > 0 ? <>one case in four rose more than {num(pct0(badq), 'text-rose-300')}</> : <>even the worst quarter of cases fell {num(pct0(badq), 'text-green-400')} or more</>)
  return (
    <p className="mt-2 text-[11px] leading-4 text-muted">
      {seen}{' '}
      {months} months later the stock was {dir} {num(pct0(win))} of the time
      {vs && <> — {vs} any random day ({num(pct0(baseWin), 'text-subtle')})</>}.
      {med != null && <> The typical result was {num(signed(med), good(med) ? 'text-green-400' : 'text-rose-300')}</>}
      {med != null && badText && <>; {badText}</>}{med != null && '.'}
      {beat != null && <> It {side === 'buy' ? 'beat' : 'fell behind'} the S&P 500 {num(pct0(beat))} of the time.</>}
      {lev && <> A call like this moves about {num(`${lev}×`, 'text-subtle')} the stock.</>}
    </p>
  )
}

// What the app's own rule did on this very stock — ahead of the pattern's
// record across all stocks, and flagged when the two disagree.
function OwnRecord({ r }) {
  const o = r.own_record
  if (!o) return null
  const z = o.zone
  const num = (x, cls = 'text-fg') => <span className={clsx('font-mono-tab', cls)}>{x}</span>
  const signed = (x) => `${x >= 0 ? '+' : '−'}${pct0(x)}`
  const tone = (x) => (x >= 0 ? 'text-green-400' : 'text-rose-300')
  const times = (k) => (k === 1 ? 'once' : k === 2 ? 'twice' : `${k} times`)
  const monthOf = (t) => new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  const poolWin = r.est_win_6m
  // The pattern looks fine but this stock's own trades lost: say so.
  const disagree = z.n >= 1 && z.avg != null && z.avg < 0 && poolWin != null && poolWin >= 0.55
  const rallies = o.moves?.n ? <> It caught {num(`${o.moves.caught} of ${o.moves.n}`)} of {r.ticker}’s big rallies{o.moves.why?.['already holding'] ? <> ({o.moves.why['already holding']} missed while holding an earlier, losing entry)</> : null}.</> : null
  if (z.n === 0) {
    return (
      <p className="mt-2 text-[11px] leading-4 text-muted">
        <span className="text-subtle font-semibold">On {r.ticker} itself:</span> this is the first time the rule has fired in 5 years
        {o.confluence.n > 0 && <>; the broader 2-signal version fired {times(o.confluence.n)}, {o.confluence.wins} of {o.confluence.n} up (avg {num(signed(o.confluence.avg), tone(o.confluence.avg))} on the call)</>}.
        {rallies}
      </p>
    )
  }
  return (
    <p className={clsx('mt-2 text-[11px] leading-4', disagree ? 'text-amber-400' : 'text-muted')}>
      <span className={clsx('font-semibold', disagree ? 'text-amber-400' : 'text-subtle')}>On {r.ticker} itself:</span> this rule has fired {num(times(z.n), disagree ? 'text-amber-400' : 'text-subtle')} in 5 years
      {z.n > 0 && <> — {num(`${z.wins} of ${z.n}`, disagree ? 'text-amber-400' : 'text-fg')} up, averaging {num(signed(z.avg), tone(z.avg))} on the call{z.open_n > 0 && <> ({z.open_n} still open, counted at today’s mark)</>}</>}
      {z.open && <>; the {monthOf(z.open.signal)} entry is still open at {num(signed(z.open.option), tone(z.open.option))}</>}.
      {!z.open && o.confluence.open && <> A {monthOf(o.confluence.open.signal)} entry on similar signals is still open at {num(signed(o.confluence.open.option), tone(o.confluence.open.option))}.</>}
      {rallies}
      {disagree && <> <span className="font-semibold">{r.ticker}’s own history disagrees with the pattern’s record below.</span></>}
    </p>
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
  const [baseline, setBaseline] = useState(null)
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
      .select('ticker, side, as_of, close, score, rank, est_3m, est_6m, est_win_3m, est_win_6m, own_n, pool_n, verdict, hold_reason, blockers, trade, stop_price, momentum, own_record, est_med_3m, est_med_6m, est_badq_3m, est_badq_6m, est_beat_3m, est_beat_6m, call_hist')
      .eq('side', side)
    if (side === 'buy' && strict) q = q.gte('score', 3)
    q = scope === 'all'
      ? q.not('rank', 'is', null).order('rank').limit(10)
      : q.in('ticker', mine.length ? mine : ['—']).order('score', { ascending: false }).limit(40)
    q.then(({ data, error }) => { if (!cancelled) setRows(error ? [] : data ?? []) })
    // The baseline the record is read against: every ticker, every day.
    supabase.from('confluence_pool').select('win_3m, win_6m, med_3m, med_6m').eq('side', side).eq('combo', '__any_day__').maybeSingle()
      .then(({ data }) => { if (!cancelled) setBaseline(data ?? null) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, scope, mineKey, strict])

  // Yours: ranked first, then by score.
  const list = useMemo(() => (scope === 'all' ? rows : rows && [...rows].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.score - a.score)), [rows, scope])
  const asOf = rows?.[0]?.as_of
  const noEntry = side === 'buy' && scope === 'all' && list?.length > 0 && !list.some((r) => r.verdict === 'enter')

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
        <p className="mt-2 text-xs text-muted">
          {side === 'buy'
            ? 'BUY SETUP = the entry rule is met today. EARLY = momentum is still falling; the rule buys anyway, a cautious entry waits for it to rise. NOT YET = what’s still missing. NOT NOW = the rule is met but it is already losing on this stock.'
            : 'Stocks showing 2+ sell signals near a high. For shares and spreads; a LEAPS follows its exit plan.'}
        </p>
      </div>
      {list === null ? (
        <div className="px-5 pb-5 space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-14 rounded-xl bg-bg-elev animate-pulse" />)}</div>
      ) : list.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-subtle">
          {side === 'buy' && strict ? 'No stock has 3 or more signals today. Turn off 3+ signals to see the 2-signal setups.'
            : scope === 'mine' ? (mine.length ? 'None of your tickers have signals today.' : 'Add tickers to Tracking or Portfolio to see them here.')
            : 'No rankings yet — they run after each close.'}
        </div>
      ) : (
        <>
          {noEntry && <p className="px-5 pb-3 text-xs text-amber-400">No stock meets the entry rule today. These are the closest, and what each still needs.</p>}
          <ul className="border-t border-hairline divide-y divide-hairline">
            {list.map((r) => {
              const v = VERDICT[r.verdict]
              const trade = r.verdict === 'enter' ? r.trade : null
              const perContract = trade ? trade.cost * 100 : null
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
                          <span className="block text-sm font-semibold text-fg leading-5">{monthYear(trade.expiry)} {money(trade.strike, 0)} call</span>
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
                    {trade && edge && <span className="mt-1.5 block text-[11px] text-amber-400">This entry sits at the bottom edge of the buy zone.</span>}

                    {/* Signals + record */}
                    <span className="mt-3 block"><SignalMeter score={r.score} side={side} /></span>
                    {side === 'buy' && (r.verdict === 'enter' || r.verdict === 'hold') && <OwnRecord r={r} />}
                    <TrackRecord r={r} side={side} baseline={baseline} />
                  </Link>
                  {side === 'buy' && (r.trade || r.call_hist) && <CallLab r={r} accountSize={accountSize} />}
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

// Gains & simulator (owner, 2026-10-15): under each buy row, collapsed.
//   Past gains — the suggested call (~2 years, 0.75 delta) marked 1 / 3 / 6 /
//   12 months after past signals: this stock, every stock, and any random
//   day (the yardstick). From the nightly job (confluence_ranks.call_hist).
//   Simulator — today's call valued for a stock move at each horizon,
//   today's vol held (src/utils/callHistory.js).
const pctS = (x, d = 0) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const usd0 = (x) => `${x < 0 ? '−' : '+'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`
const tone = (x) => (x == null ? 'text-muted' : x >= 0 ? 'text-green-400' : 'text-rose-300')

function HistCell({ h }) {
  if (!h || !h.n) return <td className="px-1.5 py-2 text-center text-muted">—</td>
  return (
    <td className="px-1.5 py-2 text-center">
      <span className={clsx('block font-semibold font-mono-tab', tone(h.avg))}>{pctS(h.avg)}</span>
      <span className="block text-[11px] text-muted font-mono-tab whitespace-nowrap">{Math.round(h.win * 100)}% up</span>
    </td>
  )
}

function CallLab({ r, accountSize }) {
  const [open, setOpen] = useState(false)
  const [hz, setHz] = useState('6M')
  const [qty, setQty] = useState(1)
  const ch = r.call_hist
  const ownSetup = ch?.own?.setup, ownConf = ch?.own?.confluence
  const ownN = ownSetup?.[1]?.n ?? 0
  const own = ownN >= 3 ? { stats: ownSetup, label: 'This stock · buy setup' } : { stats: ownConf, label: 'This stock · 2+ signals' }
  const sim = useMemo(() => (open && r.trade ? simulateCall({ S: r.close, trade: r.trade, asOf: r.as_of }) : null), [open, r])
  const be = useMemo(() => (open && r.trade ? breakevenMoves({ S: r.close, trade: r.trade, asOf: r.as_of }) : null), [open, r])
  const rowsH = sim?.find((x) => x.label === hz)
  const beH = be?.find((x) => x.label === hz)
  const cost = r.trade ? r.trade.cost * 100 * qty : null
  const n = (st) => st?.find((x) => x.n)?.n ?? 0
  return (
    <div className="px-5 pb-4 -mt-1">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="min-h-[40px] w-full flex items-center gap-2 rounded-xl border border-border px-3.5 text-xs font-semibold text-violet-300 hover:bg-card-hover/40">
        <span className="flex-1 text-left">Past gains & profit simulator</span>
        <ChevronDown size={14} className={clsx('transition', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          {ch && (
            <div>
              <div className="text-[11px] uppercase tracking-[0.12em] text-muted font-semibold mb-1">Past gains on this call</div>
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-xs">
                  <thead><tr className="text-muted">
                    <th className="text-left font-normal px-1.5 pb-1">Bought on…</th>
                    {CALL_HORIZONS.map(([l]) => <th key={l} className="font-normal px-1.5 pb-1 text-center">{l}</th>)}
                  </tr></thead>
                  <tbody className="divide-y divide-hairline">
                    <tr>
                      <td className="px-1.5 py-2 text-subtle">{own.label}<span className="block text-[11px] text-muted">{n(own.stats)} {n(own.stats) === 1 ? "dip" : "dips"}</span></td>
                      {CALL_HORIZONS.map(([l], i) => <HistCell key={l} h={own.stats?.[i]} />)}
                    </tr>
                    <tr>
                      <td className="px-1.5 py-2 text-subtle">All stocks · buy setup<span className="block text-[11px] text-muted">{n(ch.pool?.setup).toLocaleString()} dips</span></td>
                      {CALL_HORIZONS.map(([l], i) => <HistCell key={l} h={ch.pool?.setup?.[i]} />)}
                    </tr>
                    <tr>
                      <td className="px-1.5 py-2 text-subtle">Any random day<span className="block text-[11px] text-muted">the yardstick</span></td>
                      {CALL_HORIZONS.map(([l], i) => <HistCell key={l} h={ch.pool?.any?.[i]} />)}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-[11px] text-muted leading-relaxed">
                Average gain on the ~2-year call {r.trade ? `(${Math.round((r.trade.delta ?? 0.75) * 100)} delta)` : ''} if held that long, and how often it was up. A setup is only worth more than buying any day if its row beats the yardstick. Prices are Black-Scholes estimates from past volatility, not real quotes. Past results, not a forecast.
              </p>
            </div>
          )}
          {r.trade && rowsH && (
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="flex-1 text-[11px] uppercase tracking-[0.12em] text-muted font-semibold">Profit simulator</span>
                <span className="inline-flex items-center rounded-lg border border-border">
                  <button type="button" aria-label="Fewer contracts" onClick={() => setQty(Math.max(1, qty - 1))} className="min-h-[32px] min-w-[32px] flex items-center justify-center text-subtle"><Minus size={12} /></button>
                  <span className="px-1 text-xs font-mono-tab">{qty} {qty === 1 ? 'contract' : 'contracts'}</span>
                  <button type="button" aria-label="More contracts" onClick={() => setQty(Math.min(99, qty + 1))} className="min-h-[32px] min-w-[32px] flex items-center justify-center text-subtle"><Plus size={12} /></button>
                </span>
              </div>
              <div className="text-xs text-subtle mb-2">
                {monthYear(r.trade.expiry)} {money(r.trade.strike, 0)} call · cost {about(cost).replace('about ', '≈')}{accountSize ? ` · ${(cost / accountSize * 100).toFixed(1)}% of account` : ''}
              </div>
              <div className="grid grid-cols-4 gap-0.5 p-0.5 rounded-lg bg-bg-elev mb-2" role="tablist" aria-label="Held for">
                {CALL_HORIZONS.map(([l]) => (
                  <button key={l} type="button" role="tab" aria-selected={hz === l} onClick={() => setHz(l)}
                    className={clsx('min-h-[36px] rounded-md text-xs font-semibold', hz === l ? 'bg-card text-violet-300 shadow-sm' : 'text-muted')}>{l}</button>
                ))}
              </div>
              <table className="w-full text-xs font-mono-tab">
                <thead><tr className="text-muted text-right"><th className="text-left font-normal pb-1">If {r.ticker} is…</th><th className="font-normal pb-1">Call worth</th><th className="font-normal pb-1">Profit</th></tr></thead>
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
              <p className="mt-1.5 text-[11px] text-muted leading-relaxed">
                Break-even in {hz === '12M' ? '12 months' : hz.replace('M', ' months').replace('1 months', '1 month')}: {beH?.move == null ? '—' : <>{r.ticker} {pctS(beH.move, 1)} ({money(r.close * (1 + beH.move))})</>}. Today's volatility held; the call loses time value each month the stock goes nowhere. An estimate, not a quote.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
