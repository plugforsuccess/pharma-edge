import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, Check, RotateCcw, Search, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { CHART_TICKERS } from '../lib/chartTickers'
import { entryModel, DEFAULT_PARAMS, HORIZONS } from '../utils/indicators'
import EntryChart, { SUB_PANES } from '../components/EntryChart'
import TickerDrawer from '../components/TickerDrawer'
import NumberInput from '../components/NumberInput'

// /charts/entry/:ticker — the LEAPS entry chart. Price with 200 / 50 SMA and
// the weekly 50 EMA, five indicator panes, the combined buy-zone signal
// (every condition true on the same day), today's status, adjustable
// thresholds (saved on this device) and a backtest of past signals.
// Data: the leaps-entry edge function (5 years of Yahoo daily bars + IV);
// the math is utils/indicators.js, run here so thresholds apply live.

const PARAMS_KEY = 'cm:entry-params'
const PANES_KEY = 'cm:entry-panes'
// [key, label, min, max, decimals, suffix]
const FIELDS = [
  ['bandPct', '200-day band', 0.5, 50, 1, '±%'],
  ['rsiLevel', 'RSI dip below', 1, 99, 0, ''],
  ['ivRankMax', 'IV Rank below', 1, 100, 0, ''],
  ['lookback', 'RSI lookback', 1, 60, 0, 'days'],
]

function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}
function saveJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* this visit only */ }
}
// Typed strings → numbers, falling back to the default when out of range.
function parseParams(draft) {
  const out = { ...DEFAULT_PARAMS }
  for (const [k, , min, max] of FIELDS) {
    const n = Number(draft[k])
    if (draft[k] !== '' && Number.isFinite(n) && n >= min && n <= max) out[k] = k === 'lookback' ? Math.round(n) : n
  }
  return out
}

const money = (v) => (v == null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const signed = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`)
const ret = (v) => (v == null ? null : v * 100)
const shortDay = (t) => {
  const d = new Date(`${t}T12:00:00Z`)
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ’${String(d.getUTCFullYear()).slice(2)}`
}
const day = (t) => new Date(`${t}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export default function LeapsEntry() {
  const { ticker: raw } = useParams()
  const ticker = String(raw || 'SPY').toUpperCase()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [hover, setHover] = useState(null)
  const [draft, setDraft] = useState(() => {
    const saved = loadJson(PARAMS_KEY) ?? {}
    return Object.fromEntries(FIELDS.map(([k]) => [k, String(saved[k] ?? DEFAULT_PARAMS[k])]))
  })
  const [panes, setPanes] = useState(() => {
    const saved = loadJson(PANES_KEY)
    return Array.isArray(saved) ? saved : SUB_PANES.map(([k]) => k)
  })

  useEffect(() => {
    let cancelled = false
    setData(null)
    setHover(null)
    supabase.functions.invoke('leaps-entry', { body: { ticker } }).then(({ data: d, error }) => {
      if (cancelled) return
      setData(error || !d?.success ? { error: d?.error || error?.message || 'failed' } : d)
    })
    return () => { cancelled = true }
  }, [ticker])

  const params = useMemo(() => parseParams(draft), [draft])
  const bars = data?.bars ?? null
  const model = useMemo(() => (bars?.length
    ? entryModel(bars, { ivPoints: data.iv_points ?? [], ivToday: data.iv_today ?? null, params })
    : null), [bars, data, params])

  const setField = (k, v) => {
    const next = { ...draft, [k]: v }
    setDraft(next)
    saveJson(PARAMS_KEY, parseParams(next))
  }
  const resetParams = () => {
    const next = Object.fromEntries(FIELDS.map(([k]) => [k, String(DEFAULT_PARAMS[k])]))
    setDraft(next)
    saveJson(PARAMS_KEY, DEFAULT_PARAMS)
  }
  const isDefault = FIELDS.every(([k]) => params[k] === DEFAULT_PARAMS[k])
  const togglePane = (k) => {
    const next = panes.includes(k) ? panes.filter((x) => x !== k) : [...panes, k]
    setPanes(next)
    saveJson(PANES_KEY, next)
  }

  const s = model?.status
  const last = bars ? bars[bars.length - 1] : null
  const shown = hover != null && bars ? bars[hover] : last
  const prev = hover != null && bars ? bars[hover - 1] : bars?.[bars.length - 2]
  const dayChange = shown && prev ? shown.c / prev.c - 1 : null

  return (
    <div className="px-4 py-4 pb-24 max-w-md md:max-w-3xl mx-auto">
      <header className="flex items-center gap-2 mb-4">
        <Link to="/charts" aria-label="Back to Charts"
          className="min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center rounded-xl text-subtle hover:text-fg">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">LEAPS entry</div>
          <h1 className="text-lg font-semibold leading-tight">{ticker}</h1>
        </div>
        <button type="button" onClick={() => setSearchOpen(true)} aria-label="Search tickers"
          className="min-h-[44px] px-3 inline-flex items-center gap-2 rounded-xl bg-card border border-border text-sm text-subtle hover:text-fg transition">
          <Search size={15} aria-hidden /> Search
        </button>
      </header>

      {data === null ? (
        <div className="space-y-4" aria-busy="true">
          <div className="h-44 rounded-2xl bg-card border border-border animate-pulse" />
          <div className="h-[520px] rounded-2xl bg-card border border-border animate-pulse" />
        </div>
      ) : data.error || !model ? (
        <section className="bg-card border border-border rounded-2xl p-5">
          <h2 className="text-sm font-semibold mb-1">Couldn't load {ticker}</h2>
          <p className="text-sm text-subtle">Prices for this ticker aren't available right now. Try another one.</p>
        </section>
      ) : (
        <div className="md:grid md:grid-cols-[1fr_280px] md:gap-x-5 md:items-start">
          <div className="min-w-0 md:order-1">
            <StatusPanel s={s} model={model} params={params} />
          </div>

          {/* Chart */}
          <div className="min-w-0 md:order-3 md:col-span-2">
            <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
              <div className="px-5 pt-4 pb-2 flex items-end gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-2xl font-semibold font-mono-tab leading-none">{money(shown?.c)}</div>
                  <div className="mt-1 text-[11px] text-muted font-mono-tab">
                    {shown && day(shown.t)}
                    {dayChange != null && (
                      <span className={clsx('ml-2', dayChange < 0 ? 'text-rose-300' : 'text-green-400')}>{signed(dayChange * 100, 2)}</span>
                    )}
                  </div>
                </div>
                {hover != null && model.cond[hover] && (
                  <div className="text-right text-[11px] font-mono-tab">
                    <div className="text-muted">Conditions</div>
                    <div className={model.cond[hover].all ? 'text-green-400 font-semibold' : 'text-subtle'}>
                      {countMet(model.cond[hover])} of 5{model.cond[hover].all ? ' · Buy' : ''}
                    </div>
                  </div>
                )}
              </div>
              <div className="px-3 pb-2 flex flex-wrap gap-1.5" role="group" aria-label="Panels">
                {SUB_PANES.map(([k, label]) => (
                  <button key={k} type="button" onClick={() => togglePane(k)} aria-pressed={panes.includes(k)}
                    className={clsx('min-h-[32px] px-2.5 rounded-lg text-[11px] font-semibold border transition',
                      panes.includes(k) ? 'bg-bg-elev border-border-hover text-fg' : 'border-hairline text-muted hover:text-subtle')}>
                    {label}
                  </button>
                ))}
              </div>
              <EntryChart bars={bars} model={model} panes={panes} onHover={setHover} />
              <div className="px-5 py-3 border-t border-hairline flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-muted">
                <Key className="text-green-400" glyph="▲">Buy signal</Key>
                <Key className="text-green-400/50" glyph="●">MACD confirms</Key>
                <Key className="text-amber-300" glyph="●">Golden cross</Key>
                <Key className="text-rose-300" glyph="●">Death cross</Key>
                <Key glyph={<span className="inline-block w-3 h-2.5 rounded-sm bg-green-400/15 align-middle" />}>Buy zone</Key>
              </div>
            </section>
          </div>

          <div className="min-w-0 md:order-2">
            <Thresholds draft={draft} setField={setField} reset={resetParams} isDefault={isDefault} />
          </div>

          <div className="min-w-0 md:order-4 md:col-span-2">
            <Backtest model={model} />
          </div>
        </div>
      )}

      <TickerDrawer
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        curated={CHART_TICKERS}
        watchlist={[]}
        gatedSet={NO_GATES}
        selected={ticker}
        onSelect={(sym) => { setSearchOpen(false); navigate(`/charts/entry/${encodeURIComponent(sym)}`) }}
        allowCustom
        feedLabels={false}
      />
    </div>
  )
}
const NO_GATES = new Set()

const countMet = (c) => ['band', 'rising', 'trend', 'rsi', 'iv'].filter((k) => c[k]).length

function Key({ glyph, className, children }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx('text-[10px] leading-none', className)} aria-hidden>{glyph}</span>{children}
    </span>
  )
}

function StatusPanel({ s, model, params }) {
  const c = s.cond
  const yes = c.all
  const met = countMet(c)
  const lastConfirm = model.macdUp.length ? model.macdUp[model.macdUp.length - 1] : null
  const lastIdx = model.closes.length - 1
  const macdAgo = lastConfirm == null ? null : lastIdx - lastConfirm
  const lastTrade = model.trades[model.trades.length - 1]
  const rows = [
    {
      ok: c.band, label: `Within ±${params.bandPct}% of the 200-day`,
      value: signed(s.dist), sub: `200-day ${money(s.sma200)}`,
    },
    {
      ok: c.rising, label: '200-day rising',
      value: s.slope200 == null ? '—' : `${s.slope200 >= 0 ? '+' : '−'}${money(Math.abs(s.slope200))}`, sub: 'over 20 days',
    },
    {
      ok: c.trend, label: '50-day above 200-day',
      value: money(s.sma50), sub: s.sma50 && s.sma200 ? `${signed((s.sma50 / s.sma200 - 1) * 100)} vs 200` : '',
    },
    {
      ok: c.rsi, label: `RSI dipped below ${params.rsiLevel}, now rising`,
      value: s.rsi == null ? '—' : `${s.rsiPrev?.toFixed(1) ?? '—'} → ${s.rsi.toFixed(1)}`,
      sub: Number.isFinite(s.rsiMinLookback) ? `low ${s.rsiMinLookback.toFixed(1)} in ${params.lookback}d` : '',
    },
    {
      ok: c.iv, label: `IV Rank below ${params.ivRankMax}`,
      value: s.ivRank == null ? '—' : s.ivRank.toFixed(0),
      sub: model.ivSource === 'iv' ? (s.iv ? `IV ${(s.iv * 100).toFixed(1)}%` : '') : 'HV rank stand-in',
    },
  ]
  return (
    <section className={clsx('relative rounded-2xl border mb-4 overflow-hidden',
      yes ? 'border-green-400/40 bg-card' : 'border-border bg-card')}>
      {yes && <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-green-400/12 to-transparent pointer-events-none" aria-hidden />}
      <div className="relative px-5 pt-5 pb-4 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted font-semibold">Buy zone · {day(s.t)}</div>
          <div className={clsx('mt-1 text-3xl font-display font-semibold tracking-tight', yes ? 'text-green-400' : 'text-fg')}>
            {yes ? 'YES' : 'NO'}
          </div>
          <div className="text-xs text-subtle mt-0.5">
            {yes ? 'Every condition is met today.' : `${met} of 5 conditions met.`}
            {lastTrade && !yes && <span className="text-muted"> Last signal {day(lastTrade.t)}.</span>}
          </div>
        </div>
        <Meter met={met} yes={yes} />
      </div>
      <ul className="relative border-t border-hairline divide-y divide-hairline">
        {rows.map((r) => (
          <li key={r.label} className="px-5 py-2.5 flex items-center gap-3 min-h-[52px]">
            <span className={clsx('shrink-0 h-6 w-6 rounded-full flex items-center justify-center',
              r.ok ? 'bg-green-400/15 text-green-400' : 'bg-red-400/12 text-rose-300')}
              aria-label={r.ok ? 'Met' : 'Not met'}>
              {r.ok ? <Check size={14} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}
            </span>
            <span className="flex-1 min-w-0 text-sm text-fg leading-snug">{r.label}</span>
            <span className="text-right shrink-0">
              <span className="block text-sm font-mono-tab text-fg">{r.value}</span>
              {r.sub && <span className="block text-[11px] text-muted font-mono-tab">{r.sub}</span>}
            </span>
          </li>
        ))}
        <li className="px-5 py-2.5 flex items-center gap-3 min-h-[48px]">
          <span className={clsx('shrink-0 h-6 w-6 rounded-full flex items-center justify-center border border-dashed',
            macdAgo != null && macdAgo <= params.macdWindow ? 'border-green-400/60 text-green-400' : 'border-border text-muted')} aria-hidden>
            {macdAgo != null && macdAgo <= params.macdWindow ? <Check size={12} strokeWidth={3} /> : <span className="text-[10px]">—</span>}
          </span>
          <span className="flex-1 min-w-0 text-sm text-subtle leading-snug">
            MACD confirmation <span className="text-muted">(optional)</span>
          </span>
          <span className="text-right shrink-0 text-[11px] text-muted font-mono-tab">
            {macdAgo == null ? 'no cross' : macdAgo === 0 ? 'crossed up today' : `crossed up ${macdAgo}d ago`}
          </span>
        </li>
      </ul>
    </section>
  )
}

// Five-segment meter of conditions met.
function Meter({ met, yes }) {
  return (
    <div className="flex items-end gap-1 h-10" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={clsx('w-2 rounded-full transition-colors',
          i < met ? (yes ? 'bg-green-400' : 'bg-amber-400') : 'bg-faint')}
          style={{ height: `${40 + i * 15}%` }} />
      ))}
    </div>
  )
}

function Thresholds({ draft, setField, reset, isDefault }) {
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 p-5">
      <div className="flex items-center mb-3">
        <h2 className="flex-1 text-sm font-semibold">Thresholds</h2>
        {!isDefault && (
          <button type="button" onClick={reset}
            className="min-h-[36px] -mr-2 px-2 inline-flex items-center gap-1.5 rounded-lg text-xs text-subtle hover:text-fg">
            <RotateCcw size={12} aria-hidden /> Reset
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-1 gap-3">
        {FIELDS.map(([k, label, min, max, decimals, suffix]) => {
          const n = Number(draft[k])
          const bad = draft[k] === '' || !Number.isFinite(n) || n < min || n > max
          return (
            <label key={k} className="block">
              <span className="block text-[11px] text-muted mb-1">{label}</span>
              <span className={clsx('flex items-center rounded-xl bg-bg-elev border px-3 min-h-[44px] focus-within:border-amber-400/60 transition',
                bad ? 'border-red-400/50' : 'border-border')}>
                <NumberInput value={draft[k]} onChange={(v) => setField(k, v)} decimals={decimals}
                  className="flex-1 min-w-0 bg-transparent outline-none text-sm font-mono-tab text-fg" aria-label={label} />
                {suffix && <span className="text-[11px] text-muted ml-1.5">{suffix}</span>}
              </span>
            </label>
          )
        })}
      </div>
    </section>
  )
}

function Backtest({ model }) {
  const trades = [...model.trades].reverse()
  return (
    <section className="bg-card border border-border rounded-2xl mb-4 overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-sm font-semibold">Backtest</h2>
        <div className="text-xs text-muted mt-0.5">
          {model.trades.length} trade{model.trades.length === 1 ? '' : 's'} in 5 years ({model.signals.length} signal days) · stock return, not option return
        </div>
      </div>
      <div className="px-5 pb-4 grid grid-cols-3 gap-2">
        {model.stats.map((st) => (
          <div key={st.label} className="rounded-xl bg-bg-elev px-3 py-3">
            <div className="text-[11px] text-muted font-semibold">{st.label}</div>
            <div className={clsx('mt-1 text-lg font-semibold font-mono-tab leading-none',
              st.avg == null ? 'text-muted' : st.avg < 0 ? 'text-rose-300' : 'text-green-400')}>
              {st.avg == null ? '—' : signed(st.avg * 100)}
            </div>
            <div className="text-[11px] text-muted mt-1">avg return</div>
            <div className="mt-2 h-1 rounded-full bg-faint overflow-hidden" aria-hidden>
              <div className="h-full bg-green-400" style={{ width: `${(st.winRate ?? 0) * 100}%` }} />
            </div>
            <div className="text-[11px] mt-1 font-mono-tab">
              <span className="text-fg">{st.winRate == null ? '—' : `${Math.round(st.winRate * 100)}%`}</span>
              <span className="text-muted"> win · {st.n}</span>
            </div>
          </div>
        ))}
      </div>
      {trades.length === 0 ? (
        <div className="px-5 pb-5 text-sm text-subtle">No buy signals in this history with these thresholds.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono-tab">
            <thead>
              <tr className="text-muted text-[11px] border-y border-hairline">
                <th className="text-left font-semibold pl-5 pr-1 py-2">Date</th>
                <th className="text-right font-semibold px-1.5 py-2">Entry</th>
                {HORIZONS.map(([label]) => <th key={label} className="text-right font-semibold px-1.5 py-2 last:pr-5">{label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {trades.map((tr) => (
                <tr key={tr.t}>
                  <td className="pl-5 pr-1 py-2.5 text-fg whitespace-nowrap">
                    {shortDay(tr.t)}
                    {tr.confirmed && <span className="ml-1.5 text-green-400/60" title="MACD confirmed" aria-label="MACD confirmed">●</span>}
                  </td>
                  <td className="px-1.5 py-2.5 text-right text-subtle">{money(tr.price)}</td>
                  {tr.returns.map((r, h) => (
                    <td key={h} className={clsx('px-1.5 py-2.5 text-right whitespace-nowrap last:pr-5',
                      r == null ? 'text-muted' : r < 0 ? 'text-rose-300' : 'text-green-400')}>
                      {r == null ? 'open' : signed(ret(r))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
