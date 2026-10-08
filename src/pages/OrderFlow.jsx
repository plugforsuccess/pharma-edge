import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, Pause, Play, RotateCcw, Radio, History, FlaskConical, Plus, X, ChevronDown, ShieldAlert } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import OrderFlowChart, { rollUp } from '../components/OrderFlowChart'
import { useOrderFlowPlayback, point } from '../hooks/useOrderFlowPlayback'
import { SOURCES, ORDER_SIZES, SCORE_WEIGHTS } from '../utils/orderflow/config.js'
import { SCENARIOS, generateScenario } from '../utils/orderflow/synthetic.js'
import { SESSION_LABEL, sessionOf } from '../utils/orderflow/sessions.js'

// /orderflow — NIGHTFLOW, the Order Flow Intelligence Engine. Monitoring,
// alerts and simulation only: nothing on this page can place an order.
// Three modes share one engine (src/utils/orderflow/):
//   Live       — orderflow_state from the dxlink-worker (dxFeed TimeAndSale + NBBO), realtime
//   Replay     — recorded prints + quotes for a symbol / day, run in the browser
//   Synthetic  — seeded scripted scenarios, clearly labelled, run in the browser

const MODE_KEY = 'cm:nightflow-mode'
const fmt = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }))
const usd = (n) => (n == null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${fmt(n, 0)}`)
const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`)
const px = (x) => (x == null ? '—' : x < 1 ? x.toFixed(4) : x.toFixed(2))
const sh = (n) => (n == null ? '—' : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : fmt(n))
const time = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—')
const dateEt = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms))
const load = (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const save = (k, v) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

const BAND_TONE = { limited: 'text-green-400', caution: 'text-amber-300', distribution: 'text-orange-300', severe: 'text-rose-300' }
const SEV = { 1: { label: 'Info', cls: 'border-border text-subtle' }, 2: { label: 'Warning', cls: 'border-amber-400/40 text-amber-300' }, 3: { label: 'Severe', cls: 'border-rose-400/50 text-rose-300' } }

export default function OrderFlow() {
  const [params, setParams] = useSearchParams()
  const [mode, setModeState] = useState(() => params.get('mode') ?? load(MODE_KEY, 'synthetic'))
  const setMode = (m) => { setModeState(m); save(MODE_KEY, m); setParams((p) => { p.set('mode', m); return p }, { replace: true }) }
  const [symbol, setSymbol] = useState(() => (params.get('s') ?? '').toUpperCase())

  return (
    <div className="px-4 py-4 pb-24 max-w-md md:max-w-3xl lg:max-w-6xl mx-auto">
      <header className="flex items-center gap-2 mb-3">
        <Link to="/markets" aria-label="Back to Pulse" className="min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center rounded-xl text-subtle hover:text-fg">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em] text-violet-300 font-semibold">NIGHTFLOW</div>
          <h1 className="text-lg font-semibold leading-tight">Order Flow Intelligence</h1>
        </div>
      </header>

      <div className="grid grid-cols-3 gap-0.5 p-0.5 rounded-lg bg-bg-elev mb-3" role="tablist" aria-label="Data mode">
        {[['live', 'Live', Radio], ['replay', 'Replay', History], ['synthetic', 'Synthetic', FlaskConical]].map(([k, label, Icon]) => (
          <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)}
            className={clsx('min-h-[44px] rounded-md text-sm font-semibold flex items-center justify-center gap-1.5 transition', mode === k ? 'bg-card text-violet-300 shadow-sm' : 'text-muted hover:text-subtle')}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      {mode === 'live' && <LiveMode symbol={symbol} setSymbol={setSymbol} onReplay={(s, t) => { setSymbol(s); setParams((p) => { p.set('mode', 'replay'); p.set('s', s); p.set('at', String(t)); return p }); setModeState('replay') }} />}
      {mode === 'replay' && <ReplayMode symbol={symbol} setSymbol={setSymbol} at={Number(params.get('at')) || null} />}
      {mode === 'synthetic' && <SyntheticMode />}

      <p className="mt-6 text-[11px] text-muted leading-relaxed flex gap-1.5">
        <ShieldAlert size={13} className="shrink-0 mt-0.5" />
        Monitoring, alerts and simulation only — nothing here places orders or touches a brokerage account. Trade direction is inferred from quotes, not observed; the engine cannot see hidden orders, identify institutions or know future orders. Scores use unvalidated starting weights.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- modes

function SyntheticMode() {
  const [scenario, setScenario] = useState('sell_absorption')
  const gen = useMemo(() => generateScenario(scenario), [scenario])
  const pb = useOrderFlowPlayback({ events: gen.events, symbol: 'DEMO', source: 'synthetic', context: null, startAt: gen.warmupEnd })
  return (
    <>
      <div className="mb-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
        <b>SYNTHETIC DEMO — generated data, not market data.</b> Seeded scripted scenarios that exercise the detectors. Symbol “DEMO” is fictional.
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {Object.entries(SCENARIOS).map(([k, v]) => (
          <button key={k} type="button" onClick={() => setScenario(k)}
            className={clsx('min-h-[36px] px-3 rounded-full text-xs font-semibold border', scenario === k ? 'border-violet-400/60 bg-violet-400/15 text-violet-200' : 'border-border text-subtle')}>
            {v.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-subtle mb-3">{SCENARIOS[scenario].blurb} The first 35 minutes are warm-up (baselines); playback starts after it.</p>
      <Transport pb={pb} />
      <Dashboard snap={pb.snap} history={pb.history} mode="synthetic" />
    </>
  )
}

function ReplayMode({ symbol, setSymbol, at }) {
  const [date, setDate] = useState(() => (at ? dateEt(at) : dateEt(Date.now())))
  const [session, setSession] = useState('regular')
  const [state, setState] = useState({ status: 'idle' })
  const [events, setEvents] = useState(null)
  const [ctx, setCtx] = useState(null)
  const sym = symbol || ''

  async function fetchAll(table, cols, from, to) {
    const rows = []
    for (let off = 0; off < 400_000; off += 1000) {
      const { data, error } = await supabase.from(table).select(cols).eq('symbol', sym).gte('t_ms', from).lte('t_ms', to).order('t_ms').range(off, off + 999)
      if (error) throw error
      rows.push(...data)
      setState({ status: 'loading', msg: `${table.replace('orderflow_', '')}: ${rows.length.toLocaleString()}` })
      if (data.length < 1000) break
    }
    return rows
  }

  async function loadDay() {
    if (!sym) return
    setEvents(null)
    setState({ status: 'loading', msg: 'starting' })
    try {
      // ET session bounds for the chosen day (DST-safe: search the offset).
      const base = Date.parse(`${date}T00:00:00Z`)
      const off = [4, 5].find((h) => sessionOf(base + (h + 9.5) * 3_600_000 + 60_000) === 'regular') ?? 4
      const bounds = { premarket: [4, 9.5], regular: [9.5, 16], afterhours: [16, 20], all: [4, 20] }[session]
      const from = base + (bounds[0] + off) * 3_600_000 - 30 * 60_000   // 30 min of lead-in for baselines
      const to = base + (bounds[1] + off) * 3_600_000
      const [prints, quotes] = await Promise.all([
        fetchAll('orderflow_prints', 't_ms, price, size, type, src_id, bid, ask, exch, conds, eth, valid', from, to),
        fetchAll('orderflow_quotes', 't_ms, bid, ask, bid_size, ask_size', from, to),
      ])
      const ev = [
        ...quotes.map((q) => ({ kind: 'quote', t: Number(q.t_ms), bid: Number(q.bid), ask: Number(q.ask), bidSize: q.bid_size == null ? null : Number(q.bid_size), askSize: q.ask_size == null ? null : Number(q.ask_size) })),
        ...prints.map((p) => ({ kind: 'trade', t: Number(p.t_ms), price: Number(p.price), size: Number(p.size), type: p.type, id: p.src_id, bid: p.bid == null ? null : Number(p.bid), ask: p.ask == null ? null : Number(p.ask), exch: p.exch, conds: p.conds ?? '', eth: p.eth, valid: p.valid })),
      ].sort((a, b) => a.t - b.t)
      const { data: dil } = await supabase.from('orderflow_dilution').select('score, level, summary, float_shares').eq('symbol', sym).maybeSingle()
      setCtx(dil ? { dilution: { score: dil.score == null ? null : Number(dil.score), level: dil.level, summary: dil.summary }, float: dil.float_shares } : null)
      setEvents(ev.length ? ev : null)
      setState(ev.length ? { status: 'ready', prints: prints.length, quotes: quotes.length } : { status: 'empty' })
    } catch (e) {
      setState({ status: 'error', msg: e.message })
    }
  }

  useEffect(() => { if (at && sym) loadDay() /* jump from an alert */ }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const pb = useOrderFlowPlayback({ events, symbol: sym, source: 'replay', context: ctx, startAt: at && events ? Math.max(events[0].t, at - 20 * 60_000) : events?.[0]?.t })

  return (
    <>
      <div className="mb-3 rounded-xl border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-xs text-violet-200">
        <b>REPLAY</b> — prints and quotes the worker recorded from the live feed, run through the engine in your browser with the clock: nothing after the replay time is used.
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <SymbolInput value={sym} onChange={setSymbol} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="min-h-[44px] rounded-lg bg-bg-elev border border-border px-3 text-base sm:text-sm" aria-label="Day" />
        <select value={session} onChange={(e) => setSession(e.target.value)} className="min-h-[44px] rounded-lg bg-bg-elev border border-border px-3 text-base sm:text-sm" aria-label="Session">
          <option value="premarket">Premarket</option><option value="regular">Regular</option><option value="afterhours">After hours</option><option value="all">4:00–20:00</option>
        </select>
        <button type="button" onClick={loadDay} disabled={!sym || state.status === 'loading'} className="min-h-[44px] rounded-lg bg-violet-500/20 text-violet-200 font-semibold text-sm disabled:opacity-40">Load</button>
      </div>
      {state.status === 'loading' && <div className="text-xs text-muted mb-3">Loading {state.msg}…</div>}
      {state.status === 'error' && <div className="text-xs text-rose-300 mb-3">Couldn't load: {state.msg}</div>}
      {state.status === 'empty' && <div className="text-xs text-subtle mb-3">No recorded prints for {sym} in that session. The worker only records symbols on the NIGHTFLOW watchlist while it's running.</div>}
      {events && <><Transport pb={pb} /><Dashboard snap={pb.snap} history={pb.history} mode="replay" /></>}
    </>
  )
}

function LiveMode({ symbol, setSymbol, onReplay }) {
  const { profile } = useAuth()
  const [watch, setWatch] = useState(null)
  const [row, setRow] = useState(undefined)
  const [alerts, setAlerts] = useState([])
  const [history, setHistory] = useState([])
  const [now, setNow] = useState(Date.now())
  const [dil, setDil] = useState(null)
  const [adding, setAdding] = useState('')

  const loadWatch = () => supabase.from('orderflow_watchlist').select('symbol, active, note').order('added_at').then(({ data }) => setWatch(data ?? []))
  useEffect(() => { loadWatch() }, [])
  useEffect(() => { if (!symbol && watch?.length) setSymbol(watch[0].symbol) }, [watch]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])

  useEffect(() => {
    if (!symbol) return undefined
    let dead = false
    setRow(undefined); setHistory([]); setDil(null)
    supabase.from('orderflow_state').select('*').eq('symbol', symbol).maybeSingle().then(({ data }) => { if (!dead) { setRow(data ?? null); if (data) setHistory([point(data.snapshot)]) } })
    supabase.from('orderflow_alerts').select('*').eq('symbol', symbol).order('t', { ascending: false }).limit(100).then(({ data }) => { if (!dead) setAlerts(data ?? []) })
    supabase.functions.invoke('orderflow-dilution', { body: { symbol } }).then(({ data }) => { if (!dead && data?.success) setDil(data) })
    const ch = supabase.channel(`orderflow:${symbol}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orderflow_state', filter: `symbol=eq.${symbol}` }, (p) => { if (p.new?.snapshot) { setRow(p.new); setHistory((h) => [...h.slice(-719), point(p.new.snapshot)]) } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orderflow_alerts', filter: `symbol=eq.${symbol}` }, (p) => setAlerts((a) => [p.new, ...a].slice(0, 100)))
      .subscribe()
    return () => { dead = true; supabase.removeChannel(ch) }
  }, [symbol])

  const age = row ? now - Date.parse(row.t) : null
  const fresh = age != null && age < 30_000
  const snap = row?.snapshot ? { ...row.snapshot, alerts: alerts.map(dbAlert).reverse() } : null

  async function add() {
    const s = adding.trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) return
    await supabase.from('orderflow_watchlist').insert({ symbol: s, added_by: profile?.id })
    setAdding(''); loadWatch(); setSymbol(s)
  }
  async function remove(s) { await supabase.from('orderflow_watchlist').delete().eq('symbol', s); loadWatch() }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {(watch ?? []).map((w) => (
          <span key={w.symbol} className={clsx('inline-flex items-center rounded-full border text-xs font-semibold', symbol === w.symbol ? 'border-violet-400/60 bg-violet-400/15 text-violet-200' : 'border-border text-subtle')}>
            <button type="button" onClick={() => setSymbol(w.symbol)} className="min-h-[36px] px-3">{w.symbol}</button>
            {profile?.is_admin && <button type="button" aria-label={`Remove ${w.symbol}`} onClick={() => remove(w.symbol)} className="min-h-[36px] pr-2 text-muted hover:text-rose-300"><X size={12} /></button>}
          </span>
        ))}
        {profile?.is_admin && (
          <span className="inline-flex items-center gap-1">
            <input value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Add symbol" className="min-h-[36px] w-28 rounded-full bg-bg-elev border border-border px-3 text-base sm:text-xs uppercase" />
            <button type="button" onClick={add} aria-label="Add to watchlist" className="min-h-[36px] min-w-[36px] rounded-full border border-border text-subtle flex items-center justify-center"><Plus size={14} /></button>
          </span>
        )}
        {watch && !watch.length && <span className="text-xs text-muted">The NIGHTFLOW watchlist is empty{profile?.is_admin ? ' — add a low-float symbol.' : '.'}</span>}
      </div>

      {row === null || (row && !fresh) ? (
        <div className="mb-3 rounded-xl border border-border bg-card px-3 py-3 text-xs text-subtle">
          <b className="text-fg">Live feed offline{row ? ` — last update ${Math.round(age / 60_000)} min ago` : ''}.</b> Live analytics come from the dxlink-worker (dxFeed TimeAndSale + NBBO via Tastytrade), which isn't running right now. Nothing is estimated in its place — use Replay or the Synthetic demo meanwhile.
        </div>
      ) : row ? (
        <div className="mb-3 flex items-center gap-2 text-xs text-subtle"><span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" /> LIVE · updated {Math.round(age / 1000)} s ago</div>
      ) : null}

      {dil && <DilutionBar d={dil} />}
      {snap && <Dashboard snap={snap} history={history} mode={fresh ? 'live' : 'stale'} />}
      <AlertHistory alerts={alerts} onReplay={(a) => onReplay(a.symbol, Date.parse(a.t))} />
    </>
  )
}

const dbAlert = (a) => ({ id: a.id, t: Date.parse(a.t), symbol: a.symbol, type: a.type, severity: a.severity, title: a.title, evidence: a.evidence, quoteQuality: a.quote_quality, session: a.session, source: a.source, sourceLabel: SOURCES[a.source]?.label ?? a.source, limitations: a.limitations })

// ------------------------------------------------------------- controls

function SymbolInput({ value, onChange }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <input value={v} onChange={(e) => setV(e.target.value.toUpperCase())} onBlur={() => onChange(v.trim())} onKeyDown={(e) => e.key === 'Enter' && onChange(v.trim())} placeholder="Symbol" aria-label="Symbol" className="min-h-[44px] rounded-lg bg-bg-elev border border-border px-3 text-base sm:text-sm uppercase" />
}

function Transport({ pb }) {
  if (pb.clock == null) return null
  const span = pb.last - pb.first || 1
  return (
    <div className="mb-3 rounded-xl border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => pb.setPlaying(!pb.playing)} aria-label={pb.playing ? 'Pause' : 'Play'} className="min-h-[44px] min-w-[44px] rounded-lg bg-violet-500/20 text-violet-200 flex items-center justify-center">
          {pb.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button type="button" onClick={() => pb.seek(pb.first)} aria-label="Restart" className="min-h-[44px] min-w-[44px] rounded-lg text-subtle flex items-center justify-center"><RotateCcw size={15} /></button>
        <div className="text-xs font-mono-tab text-subtle w-24">{time(pb.clock)} ET</div>
        <div className="flex gap-0.5 ml-auto">
          {[1, 10, 60, 300].map((s) => (
            <button key={s} type="button" onClick={() => pb.setSpeed(s)} className={clsx('min-h-[36px] px-2 rounded-md text-[11px] font-semibold', pb.speed === s ? 'bg-bg-elev text-violet-300' : 'text-muted')}>{s}×</button>
          ))}
        </div>
      </div>
      <input type="range" min={0} max={1000} value={Math.round(((pb.clock - pb.first) / span) * 1000)} onChange={(e) => pb.seek(pb.first + (Number(e.target.value) / 1000) * span)} aria-label="Replay time" className="w-full mt-1 accent-violet-400" />
    </div>
  )
}

// ------------------------------------------------------------ dashboard

function Dashboard({ snap, history, mode }) {
  const [res, setRes] = useState('10s')
  const buckets = useMemo(() => rollUp(snap?.chart ?? [], res === '1m' ? 60_000 : 10_000), [snap, res])
  if (!snap) return <div className="h-64 rounded-2xl bg-card border border-border animate-pulse" />
  if (snap.status === 'disabled') {
    return <Card title="Analytics disabled"><p className="text-sm text-subtle">{snap.reason}</p></Card>
  }
  return (
    <>
      <StatusStrip snap={snap} mode={mode} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4 min-w-0">
          <section className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="px-4 pt-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold flex-1">{snap.symbol} · price · volume · CVD</h2>
              {['10s', '1m'].map((r) => <button key={r} type="button" onClick={() => setRes(r)} className={clsx('min-h-[32px] px-2 rounded-md text-[11px] font-semibold', res === r ? 'bg-bg-elev text-violet-300' : 'text-muted')}>{r}</button>)}
            </div>
            <div className="px-4 text-[11px] text-muted">Volume bars green when buyer-initiated volume ≥ seller-initiated. CVD resets each session. ▼ alerts, ▲ possible accumulation.</div>
            <OrderFlowChart buckets={buckets} alerts={snap.alerts ?? []} height={440} />
          </section>
          <WindowsTable w={snap.windows} />
          <div className="grid gap-4 md:grid-cols-2">
            <DivergenceCard d={snap.divergence} />
            <AbsorptionCard a={snap.absorption} />
          </div>
          <LiquidityCard l={snap.liquidity} history={history} quote={snap.quote} />
          <ImpactTable impact={snap.liquidity?.impact} />
          <DistributionCard d={snap.distribution} />
        </div>
        <div className="space-y-4 min-w-0">
          <ScoreCard s={snap.score} history={history} />
          <AlertsCard alerts={snap.alerts ?? []} />
          <ModulesCard snap={snap} mode={mode} />
          <ValidationCard />
        </div>
      </div>
    </>
  )
}

function Card({ title, right, children, className }) {
  return (
    <section className={clsx('bg-card border border-border rounded-2xl p-4', className)}>
      {title && <div className="flex items-center gap-2 mb-3"><h2 className="text-sm font-semibold flex-1">{title}</h2>{right}</div>}
      {children}
    </section>
  )
}

function StatusStrip({ snap, mode }) {
  const q = snap.quote
  const tag = { live: ['LIVE', 'bg-green-400/15 text-green-300'], stale: ['STALE', 'bg-rose-400/15 text-rose-300'], replay: ['REPLAY', 'bg-violet-400/15 text-violet-200'], synthetic: ['SYNTHETIC', 'bg-amber-400/15 text-amber-200'] }[mode]
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-subtle font-mono-tab">
      <span className={clsx('px-2 py-0.5 rounded font-semibold tracking-wide', tag[1])}>{tag[0]}</span>
      <span>{snap.sourceLabel}</span>
      <span>{SESSION_LABEL[snap.session] ?? snap.session}</span>
      <span>{time(snap.t)} ET</span>
      {q && <span>NBBO {px(q.bid)} × {px(q.ask)} · {sh(q.bidSize)} × {sh(q.askSize)}</span>}
      {q && <span>quote <b className={q.grade === 'good' ? 'text-green-400' : q.grade === 'fair' ? 'text-amber-300' : 'text-rose-300'}>{q.grade}</b></span>}
      <span>{fmt(snap.stats?.prints)} prints · {fmt(snap.stats?.excluded)} excluded · {fmt(snap.stats?.late)} late · {fmt(snap.stats?.cancels)} cancels / {fmt(snap.stats?.corrections)} corrections</span>
    </div>
  )
}

function WindowsTable({ w }) {
  const rows = ['10s', '1m', '5m', '15m', 'session']
  return (
    <Card title="Cumulative volume delta">
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs font-mono-tab">
          <thead className="text-muted"><tr className="text-right">
            <th className="text-left font-normal px-1 pb-1">Window</th><th className="font-normal px-1">Buy</th><th className="font-normal px-1">Sell</th><th className="font-normal px-1">CVD</th><th className="font-normal px-1">Net %</th><th className="font-normal px-1">Price</th><th className="font-normal px-1">Unclass.</th><th className="font-normal px-1">Trades</th>
          </tr></thead>
          <tbody>
            {rows.map((k) => { const a = w?.[k]; return (
              <tr key={k} className="text-right border-t border-hairline">
                <td className="text-left px-1 py-1.5 text-subtle">{k === 'session' ? 'Session' : k}</td>
                <td className="px-1 text-green-400">{sh(a?.buy)}</td>
                <td className="px-1 text-rose-300">{sh(a?.sell)}</td>
                <td className={clsx('px-1 font-semibold', (a?.delta ?? 0) >= 0 ? 'text-green-400' : 'text-rose-300')}>{a?.delta >= 0 ? '+' : ''}{sh(a?.delta)}</td>
                <td className="px-1">{a?.deltaRatio == null ? '—' : `${Math.round(a.deltaRatio * 100)}%`}</td>
                <td className={clsx('px-1', (a?.ret ?? 0) >= 0 ? 'text-green-400' : 'text-rose-300')}>{a?.ret == null ? '—' : pct(Math.exp(a.ret) - 1, 2)}</td>
                <td className="px-1 text-muted">{a?.indShare == null ? '—' : `${Math.round(a.indShare * 100)}%`}</td>
                <td className="px-1 text-muted">{fmt(a?.n)}</td>
              </tr>) })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted">Classified by the quote at execution (Lee–Ready), tick rule when no usable quote. Late, out-of-sequence, average-price, auction and off-market prints count as volume but are never classified.</p>
    </Card>
  )
}

const DIV_TONE = { bull: 'text-green-400', bear: 'text-rose-300', warn: 'text-amber-300', neutral: 'text-subtle' }
function DivergenceCard({ d }) {
  return (
    <Card title="Price vs CVD (5 min)" right={d?.key && !['neutral', 'insufficient'].includes(d.key) ? <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-bg-elev text-violet-300">{d.key}</span> : null}>
      {d?.key === 'insufficient' ? (
        <><div className="text-sm text-subtle">Insufficient data</div><ul className="mt-1 text-[11px] text-muted list-disc pl-4">{d.reasons?.map((r) => <li key={r}>{r}</li>)}</ul></>
      ) : (
        <><div className={clsx('text-sm font-semibold', DIV_TONE[d?.tone] ?? 'text-subtle')}>{d?.label}</div><ul className="mt-1 text-[11px] text-muted list-disc pl-4">{d?.evidence?.map((r) => <li key={r}>{r}</li>)}</ul></>
      )}
    </Card>
  )
}

function Check({ met, available = true, label, detail }) {
  return (
    <li className="flex gap-2 text-xs">
      <span className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border', !available ? 'border-dashed border-muted' : met ? 'bg-amber-300 border-amber-300' : 'border-border')} />
      <span><span className={met ? 'text-fg font-semibold' : 'text-subtle'}>{label}</span><span className="block text-[11px] text-muted">{available ? detail : `unavailable — ${detail}`}</span></span>
    </li>
  )
}

function AbsorptionCard({ a }) {
  return (
    <Card title="Sell-side absorption" right={<span className={clsx('text-[11px] font-semibold', a?.active ? 'text-amber-300' : 'text-muted')}>{a?.met ?? 0} of {a?.of ?? 5}</span>}>
      {a?.active && <div className="mb-2 text-xs font-semibold text-amber-300">POTENTIAL SELL-SIDE ABSORPTION</div>}
      <ul className="space-y-2">{a?.conditions?.map((c) => <Check key={c.key} {...c} />)}</ul>
      <p className="mt-2 text-[11px] text-muted">Fires only with aggressive buying plus 2 more independent conditions and enough data. A stall with positive CVD alone is not treated as a hidden seller.</p>
    </Card>
  )
}

function DistributionCard({ d }) {
  const tone = { none: 'text-green-400', watch: 'text-subtle', possible: 'text-amber-300', hazardous: 'text-rose-300', insufficient: 'text-muted' }[d?.level]
  return (
    <Card title="Distribution risk" right={<span className={clsx('text-xs font-semibold capitalize', tone)}>{d?.level}{d && ['possible', 'hazardous'].includes(d.level) ? ` · ${d.character}` : ''}</span>}>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {d?.factors?.map((f) => (
          <div key={f.key} className="text-xs">
            <div className="flex justify-between gap-2"><span className={f.value >= 0.5 ? 'text-fg font-semibold' : 'text-subtle'}>{f.label}</span><span className="font-mono-tab text-muted">{f.available ? `${Math.round(f.value * 100)}` : 'n/a'}</span></div>
            <Bar v={f.value} warn={f.value >= 0.5} />
            <div className="text-[11px] text-muted">{f.detail}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted">“Sustained distribution” needs CVD deterioration, thinning bids and repeated rejections together; “profit-taking” needs stable bids and spreads. Anything else is reported as uncertain — prints alone often can't tell them apart.</p>
    </Card>
  )
}

function Bar({ v, warn }) {
  return <div className="h-1.5 rounded bg-bg-elev my-1 overflow-hidden"><div className={clsx('h-full rounded', warn ? 'bg-amber-300' : 'bg-violet-400/70')} style={{ width: `${Math.round((v ?? 0) * 100)}%` }} /></div>
}

function Spark({ data, color = 'var(--color-confluence)', zero = false, h = 36 }) {
  const pts = data.filter((d) => d.v != null)
  if (pts.length < 2) return <div style={{ height: h }} className="text-[11px] text-muted flex items-center">collecting…</div>
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1
  const lo = Math.min(...pts.map((p) => p.v), zero ? 0 : Infinity), hi = Math.max(...pts.map((p) => p.v), zero ? 0 : -Infinity)
  const y = (v) => (hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * (h - 2) - 1)
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(((p.t - t0) / (t1 - t0 || 1)) * 100).toFixed(2)},${y(p.v).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" className="w-full" style={{ height: h }}>
      {zero && <line x1="0" x2="100" y1={y(0)} y2={y(0)} stroke="var(--color-border)" strokeWidth="0.5" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function LiquidityCard({ l, history, quote }) {
  if (!l) return null
  const depth = l.depth?.levels
  const maxSz = depth ? Math.max(...depth.bids.map((x) => x[1]), ...depth.asks.map((x) => x[1]), 1) : Math.max(quote?.bidSize ?? 0, quote?.askSize ?? 0, 1)
  const imb = l.depth?.imbalance ?? l.imbalanceTop
  return (
    <Card title="Liquidity" right={<span className="text-[11px] text-muted">{l.displayedOnly ? 'top of book only — no Level 2' : 'Level 2 depth'}</span>}>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted mb-1">{depth ? 'Depth (10 levels)' : 'Best bid / offer'}</div>
          {depth ? (
            <div className="grid grid-cols-2 gap-x-2 text-[11px] font-mono-tab">
              <div className="space-y-0.5">{depth.bids.map(([p, z]) => <div key={`b${p}`} className="relative flex justify-between px-1"><span className="absolute inset-y-0 right-0 bg-green-400/15 rounded-sm" style={{ width: `${(z / maxSz) * 100}%` }} /><span className="relative text-muted">{sh(z)}</span><span className="relative text-green-400">{px(p)}</span></div>)}</div>
              <div className="space-y-0.5">{depth.asks.map(([p, z]) => <div key={`a${p}`} className="relative flex justify-between px-1"><span className="absolute inset-y-0 left-0 bg-rose-400/15 rounded-sm" style={{ width: `${(z / maxSz) * 100}%` }} /><span className="relative text-rose-300">{px(p)}</span><span className="relative text-muted">{sh(z)}</span></div>)}</div>
            </div>
          ) : (
            <div className="space-y-1 text-xs font-mono-tab">
              <div className="flex items-center gap-2"><span className="w-10 text-green-400">Bid</span><div className="flex-1 h-3 bg-bg-elev rounded"><div className="h-full bg-green-400/40 rounded" style={{ width: `${((quote?.bidSize ?? 0) / maxSz) * 100}%` }} /></div><span className="w-24 text-right">{px(quote?.bid)} × {sh(quote?.bidSize)}</span></div>
              <div className="flex items-center gap-2"><span className="w-10 text-rose-300">Ask</span><div className="flex-1 h-3 bg-bg-elev rounded"><div className="h-full bg-rose-400/40 rounded" style={{ width: `${((quote?.askSize ?? 0) / maxSz) * 100}%` }} /></div><span className="w-24 text-right">{px(quote?.ask)} × {sh(quote?.askSize)}</span></div>
            </div>
          )}
          <div className="mt-3 text-[11px] text-muted">Imbalance {imb == null ? '—' : `${imb >= 0 ? '+' : ''}${Math.round(imb * 100)}%`} (bid − ask over both){l.depth ? ', within 1% of mid' : ', top of book'}</div>
          <div className="h-2 mt-1 rounded bg-bg-elev relative"><div className="absolute top-0 bottom-0 left-1/2 w-px bg-border" /><div className={clsx('absolute top-0 bottom-0 rounded', (imb ?? 0) >= 0 ? 'bg-green-400/60 left-1/2' : 'bg-rose-400/60 right-1/2')} style={{ width: `${Math.abs(imb ?? 0) * 50}%` }} /></div>
        </div>
        <div className="space-y-2 text-xs">
          <Row k="Spread" v={l.spreadPct == null ? '—' : `${(l.spreadPct * 100).toFixed(2)}%`} sub={l.spreadRatio == null ? 'no 30-min baseline yet' : `${l.spreadRatio.toFixed(2)}× its 30-min median (${(l.spreadBase30m * 100).toFixed(2)}%)`} warn={l.spreadRatio >= 2} />
          <Spark data={history.map((p) => ({ t: p.t, v: p.spreadPct }))} color="var(--color-amber-400)" />
          <Row k="Displayed bid $" v={usd(l.bidUsd)} sub={l.bidRatio == null ? 'no baseline yet' : `${Math.round(l.bidRatio * 100)}% of 15-min median`} warn={l.bidRatio != null && l.bidRatio < 0.5} />
          <Spark data={history.map((p) => ({ t: p.t, v: p.bidUsd }))} color="var(--color-green-400)" />
          <Row k="Price impact" v={l.lambdaBpsPer10k == null ? '—' : `${l.lambdaBpsPer10k.toFixed(1)} bps / $10K net`} sub="fitted on 30 min of 10-second returns vs signed dollar flow" />
          {l.withdrawals?.length > 0 && <div className="text-rose-300 text-[11px]">Liquidity withdrawals (30 min): {l.withdrawals.map((w) => `${time(w.t)} −${Math.round(w.dropPct * 100)}%`).join(' · ')}</div>}
        </div>
      </div>
      <ul className="mt-3 text-[11px] text-muted list-disc pl-4">{l.notes?.map((n) => <li key={n}>{n}</li>)}</ul>
    </Card>
  )
}

function Row({ k, v, sub, warn }) {
  return <div><div className="flex justify-between"><span className="text-subtle">{k}</span><span className={clsx('font-mono-tab font-semibold', warn && 'text-amber-300')}>{v}</span></div>{sub && <div className="text-[11px] text-muted">{sub}</div>}</div>
}

function ImpactTable({ impact }) {
  const [side, setSide] = useState('sell')
  if (!impact) return null
  const rows = impact[side]
  return (
    <Card title="Hypothetical fills" right={
      <div className="flex gap-0.5 p-0.5 rounded-lg bg-bg-elev">{['buy', 'sell'].map((s) => <button key={s} type="button" onClick={() => setSide(s)} className={clsx('min-h-[32px] px-3 rounded-md text-[11px] font-semibold capitalize', side === s ? 'bg-card text-violet-300' : 'text-muted')}>{s}</button>)}</div>
    }>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs font-mono-tab">
          <thead className="text-muted"><tr className="text-right"><th className="text-left font-normal px-1 pb-1">Order</th><th className="font-normal px-1">Displayed</th><th className="font-normal px-1">Executable*</th><th className="font-normal px-1">Avg px</th><th className="font-normal px-1">Slippage</th><th className="font-normal px-1">Model</th><th className="font-normal px-1">Fill</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.usd} className="text-right border-t border-hairline">
                <td className="text-left px-1 py-1.5">{usd(r.usd)}</td>
                <td className="px-1">{Math.round(r.displayedPct * 100)}%</td>
                <td className="px-1 text-muted">{Math.round(r.executablePct * 100)}%</td>
                <td className="px-1">{px(r.avgPrice)}</td>
                <td className="px-1">{r.slipBps == null ? '—' : `${r.slipBps.toFixed(0)} bps`}</td>
                <td className="px-1 text-muted">{r.modelBps == null ? '—' : `${r.modelBps.toFixed(0)} bps`}</td>
                <td className={clsx('px-1 font-semibold', { good: 'text-green-400', costly: 'text-amber-300', partial: 'text-orange-300', thin: 'text-rose-300' }[r.quality])}>{r.quality}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted">Displayed = what the {impact.basis === 'Level 2' ? 'book' : 'best bid/offer'} shows now; slippage vs the mid for that part. *Executable assumes half of displayed size beyond the first level is still there when you arrive — an assumption, not data. Model = half-spread + square-root impact on the whole order (σ from 10-second returns, volume from the session pace). Sizes: {ORDER_SIZES.map(usd).join(', ')}.</p>
    </Card>
  )
}

function ScoreCard({ s, history }) {
  const ok = s?.status === 'ok'
  return (
    <Card title="Selling Pressure Risk Score">
      {ok ? (
        <div className="flex items-end gap-3"><div className={clsx('text-5xl font-semibold font-mono-tab leading-none', BAND_TONE[s.band])}>{s.value}</div><div className={clsx('text-sm font-semibold pb-1', BAND_TONE[s.band])}>{s.label}</div></div>
      ) : (
        <><div className="text-lg font-semibold text-muted">Insufficient data</div><ul className="mt-1 text-[11px] text-muted list-disc pl-4">{s?.reasons?.map((r) => <li key={r}>{r}</li>)}</ul></>
      )}
      <div className="mt-2"><Spark data={history.map((p) => ({ t: p.t, v: p.score }))} color="var(--color-amber-400)" h={40} /></div>
      <div className="mt-3 space-y-2">
        {s?.components?.map((c) => (
          <div key={c.key} className="text-xs">
            <div className="flex justify-between"><span className={c.available ? 'text-subtle' : 'text-muted'}>{c.label} <span className="text-muted">· {c.weight}%</span></span><span className="font-mono-tab text-muted">{c.available ? Math.round(c.value * 100) : 'n/a'}</span></div>
            <Bar v={c.value} warn={c.value >= 0.5} />
            <div className="text-[11px] text-muted">{c.reason}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted">0–24 limited · 25–49 elevated caution · 50–74 potential distribution · 75–100 severe. Weights ({Object.values(SCORE_WEIGHTS).join(' / ')}) are starting hypotheses, not validated probabilities; unavailable parts are left out and the rest re-weighted (needs ≥ 70% coverage). Coverage now {s?.coverage == null ? '—' : `${Math.round(s.coverage * 100)}%`}.</p>
    </Card>
  )
}

function AlertsCard({ alerts }) {
  const list = [...alerts].reverse().slice(0, 30)
  return (
    <Card title="Alerts" right={<span className="text-[11px] text-muted">{alerts.length}</span>}>
      {!list.length && <div className="text-xs text-muted">No alerts yet.</div>}
      <ul className="space-y-2">{list.map((a) => <AlertRow key={a.id} a={a} />)}</ul>
    </Card>
  )
}

function AlertRow({ a, onReplay }) {
  const [open, setOpen] = useState(false)
  const sev = SEV[a.severity] ?? SEV[1]
  return (
    <li className={clsx('rounded-xl border px-3 py-2', sev.cls)}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full text-left">
        <div className="flex items-center gap-2 text-xs"><span className="font-semibold flex-1">{a.title}</span><span className="text-[11px] font-mono-tab text-muted">{time(a.t)}</span><ChevronDown size={12} className={clsx('text-muted transition', open && 'rotate-180')} /></div>
        <div className="text-[11px] text-muted">{a.symbol} · {sev.label} · {SESSION_LABEL[a.session] ?? a.session} · quote {a.quoteQuality}</div>
      </button>
      {open && (
        <div className="mt-2 text-[11px] space-y-1.5">
          <ul className="list-disc pl-4 text-subtle">{a.evidence?.map((e) => <li key={e}>{e}</li>)}</ul>
          <div className="text-muted">Source: {a.sourceLabel ?? a.source}</div>
          <ul className="list-disc pl-4 text-muted">{a.limitations?.map((e) => <li key={e}>{e}</li>)}</ul>
          {onReplay && <button type="button" onClick={onReplay} className="min-h-[36px] text-violet-300 font-semibold">Replay this moment →</button>}
        </div>
      )}
    </li>
  )
}

function AlertHistory({ alerts, onReplay }) {
  if (!alerts.length) return null
  return (
    <Card title="Alert history (recorded)" className="mt-4">
      <ul className="space-y-2">{alerts.slice(0, 50).map((a) => { const x = dbAlert(a); return <AlertRow key={x.id} a={x} onReplay={() => onReplay(a)} /> })}</ul>
    </Card>
  )
}

function DilutionBar({ d }) {
  const tone = { active: 'border-rose-400/50 text-rose-200', shelf: 'border-amber-400/40 text-amber-200', minor: 'border-border text-subtle', none: 'border-border text-subtle', unknown: 'border-border text-muted' }[d.level] ?? 'border-border text-subtle'
  return (
    <div className={clsx('mb-3 rounded-xl border px-3 py-2 text-xs', tone)}>
      <b>SEC filings: {d.level}</b> — {d.summary}{d.float_shares ? ` · float ${sh(d.float_shares)} shares` : ''}. <span className="text-muted">Flags filings that allow selling stock, not whether it will happen.</span>
    </div>
  )
}

function ModulesCard({ snap, mode }) {
  const src = SOURCES[snap.source] ?? SOURCES.synthetic
  const live = mode === 'live' ? 'Live' : mode === 'stale' ? 'Offline' : mode === 'replay' ? 'Replay' : 'Synthetic'
  const tone = { Live: 'text-green-400', Replay: 'text-violet-300', Synthetic: 'text-amber-300', Offline: 'text-rose-300', Unavailable: 'text-muted', Model: 'text-subtle' }
  const rows = [
    ['Trade classification', live], ['CVD windows', live], ['Divergence A–E', live], ['Sell-side absorption', live], ['Distribution risk', live],
    ['Level 2 depth', src.depth ? live : 'Unavailable'], ['Liquidity (NBBO)', live], ['Depth beyond best bid/offer', src.depth ? live : 'Model'],
    ['Dilution (SEC EDGAR)', snap.score?.components?.find((c) => c.key === 'dilution')?.available ? 'Live' : 'Unavailable'],
    ['Overnight session', src.sessions.overnight ? live : 'Unavailable'], ['Risk score', live], ['Alerts', live],
  ]
  return (
    <Card title="What's running on what">
      <ul className="space-y-1 text-xs">{rows.map(([k, v]) => <li key={k} className="flex justify-between"><span className="text-subtle">{k}</span><span className={clsx('font-semibold', tone[v])}>{v}</span></li>)}</ul>
      <details className="mt-3 text-[11px] text-muted"><summary className="cursor-pointer text-subtle min-h-[32px] flex items-center">Feed coverage — {src.label}</summary><ul className="list-disc pl-4 space-y-1 mt-1">{src.notes.map((n) => <li key={n}>{n}</li>)}</ul></details>
    </Card>
  )
}

function ValidationCard() {
  return (
    <Card title="Validation status">
      <p className="text-xs text-subtle">Not validated on real market data yet. The backtest harness (<span className="font-mono">npm run orderflow:backtest</span>) grades alerts against labelled selloffs — coverage, false positives, time to reversal, adverse excursion, outcomes after alerts, by session, with execution costs — fitting thresholds on earlier days and reporting later ones. It needs recorded low-float days (winners and failed breakouts); the worker starts recording once it runs.</p>
      <p className="mt-2 text-[11px] text-muted">Until then every number on this page is descriptive, and no alert is a prediction.</p>
    </Card>
  )
}
