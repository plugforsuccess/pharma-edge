import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Share2 } from 'lucide-react'
import { peerComparisons, AGE_LABELS } from '../utils/peers'
import PeersShare from './PeersShare'
import { todayYmd } from '../utils/afterTax'

// Portfolio → Total card → Peers (owner, 2026-10-03; free): the user's net
// worth before tax against US households, from the Federal Reserve's
// Survey of Consumer Finances 2022 (inflation-adjusted). The benchmarks
// file is built in Actions (scraper/build_net_worth_benchmarks.py); until
// it exists the view says so instead of guessing.
const files = import.meta.glob('../data/netWorthBenchmarks.json', { eager: true, import: 'default' })
const BENCHMARKS = Object.values(files)[0] ?? null
// State rows: Census SIPP, built by scraper/build_state_net_worth.py.
const stateFiles = import.meta.glob('../data/stateNetWorth.json', { eager: true, import: 'default' })
const STATES = Object.values(stateFiles)[0] ?? null

const compact = (n) => {
  const a = Math.abs(n)
  const s = a >= 1e6 ? `$${+(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}K` : `$${Math.round(a)}`
  return n < 0 ? `−${s}` : s
}

export default function PeersView({ netWorth, profile, homeowner }) {
  const p = profile ?? {}
  const result = useMemo(() => peerComparisons({
    benchmarks: BENCHMARKS, netWorth, birthDate: p.birth_date, today: todayYmd(),
    filingStatus: p.filing_status, income: Number(p.annual_income), homeowner,
    sex: p.sex, race: p.race_ethnicity, education: p.education,
    stateBenchmarks: STATES, stateCode: p.state_code,
  }), [netWorth, p.birth_date, p.filing_status, p.annual_income, homeowner, p.sex, p.race_ethnicity, p.education, p.state_code])
  const [shareOpen, setShareOpen] = useState(false)

  if (!BENCHMARKS) {
    return <p className="text-sm text-subtle">Comparison data isn't available yet.</p>
  }
  const head = result.rows.find((r) => r.headline)
  const rest = result.rows.filter((r) => !r.headline)
  const src = BENCHMARKS.source
  const age = result.band ? AGE_LABELS[result.band] : null
  const month = src.dollars.match(/to (\w+ \d{4})/)?.[1]
  const stateRow = rest.find((r) => r.source === 'census')
  const sourceLine = `Federal Reserve SCF 2022${month ? `, in ${month} dollars` : ''}${stateRow ? `; ${stateRow.name.replace(' households', '')} from Census SIPP 2023` : ''}.`

  return (
    <div>
      {head ? (
        <div className="mb-6">
          <div className="text-5xl font-semibold tracking-tight font-mono-tab text-green-400 leading-none">{head.rank}</div>
          <div className="mt-2 text-sm text-subtle">
            {head.rank.startsWith('Top') && head.pctLabel ? `${head.pctLabel} · ` : ''}households {age}
          </div>
          <PercentileBar row={head} netWorth={netWorth} />
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Stat label="Your net worth" value={compact(netWorth)} strong />
            {head.mean != null && <Stat label="Average" value={compact(head.mean)} />}
          </div>
        </div>
      ) : (
        <div className="mb-5 rounded-xl bg-bg-elev px-4 py-3 text-sm text-subtle">
          Add your birth date to compare with your age group.
          <Link to="/settings#about-you" className="ml-1 text-amber-300">Settings</Link>
        </div>
      )}

      <ul className="space-y-5">
        {rest.map((r) => (
          <li key={r.key}>
            <div className="flex items-baseline gap-3">
              <div className="flex-1 min-w-0 text-sm text-fg truncate">
                {r.name}{r.withinAge && <span className="text-muted"> · {age}</span>}
                {r.source === 'census' && <span className="ml-2 align-middle text-[10px] uppercase tracking-wider text-muted">Census</span>}
              </div>
              <div className={clsx('shrink-0 text-sm font-semibold font-mono-tab', (r.pct ?? 0) >= 50 ? 'text-green-400' : 'text-subtle')}>{r.rank}</div>
            </div>
            <MiniBar pct={r.pct} />
            <div className="mt-1.5 text-xs text-muted font-mono-tab">
              Median {compact(r.median)}{r.mean != null && ` · Avg ${compact(r.mean)}`}
            </div>
          </li>
        ))}
      </ul>

      {head && (
        <button type="button" onClick={() => setShareOpen(true)}
          className="mt-6 w-full min-h-[44px] rounded-xl bg-bg-elev text-sm font-semibold text-fg inline-flex items-center justify-center gap-2 hover:bg-card-hover transition">
          <Share2 size={15} aria-hidden /> Share your rank
        </button>
      )}
      <p className="mt-4 text-[11px] text-muted">
        Net worth before tax. {sourceLine}
        {!(p.sex || p.race_ethnicity || p.education) && (
          <> <Link to="/settings#about-you" className="text-amber-300">Add more comparisons</Link></>
        )}
      </p>
      {head && (
        <PeersShare open={shareOpen} onClose={() => setShareOpen(false)} head={head} rows={rest.filter((r) => r.source !== 'census')}
          age={age} netWorth={netWorth} source={`Federal Reserve SCF 2022${month ? ` · ${month} dollars` : ''}`} />
      )}
    </div>
  )
}

function Stat({ label, value, strong = false }) {
  return (
    <div className="rounded-xl bg-bg-elev px-3 py-2.5 min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('mt-0.5 text-sm font-semibold font-mono-tab truncate', strong ? 'text-fg' : 'text-subtle')}>{value}</div>
    </div>
  )
}

// A slim track with the user's spot.
function MiniBar({ pct }) {
  const you = Math.max(0, Math.min(100, pct ?? 0))
  return (
    <div className="relative mt-2 h-1 rounded-full bg-bg-elev" aria-hidden>
      <div className="absolute inset-y-0 left-0 rounded-full bg-green-400/40" style={{ width: `${you}%` }} />
      <span className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-green-400" style={{ left: `${you}%` }} />
    </div>
  )
}

// Where the user sits against the median, 75th and 90th percentile.
function PercentileBar({ row, netWorth }) {
  const marks = [
    { label: 'Median', v: row.median, p: 50 },
    { label: '75th', v: row.p75, p: 75 },
    { label: '90th', v: row.p90, p: 90 },
  ]
  const you = Math.max(0, Math.min(100, row.pct ?? 0))
  return (
    <div className="mt-4">
      <div className="relative h-2 rounded-full bg-bg-elev">
        <div className="absolute inset-y-0 left-0 rounded-full bg-green-400/35" style={{ width: `${you}%` }} />
        {marks.map((m) => (
          <span key={m.label} className="absolute top-1/2 -translate-y-1/2 h-3 w-px bg-subtle" style={{ left: `${m.p}%` }} aria-hidden />
        ))}
        <span className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-3.5 w-3.5 rounded-full bg-green-400 ring-2 ring-card"
          style={{ left: `${you}%` }} aria-label="You" />
      </div>
      <div className="relative mt-2 h-8 text-[11px] text-muted">
        {marks.map((m) => (
          <span key={m.label} className="absolute -translate-x-1/2 text-center leading-tight whitespace-nowrap" style={{ left: `${m.p}%` }}>
            {m.label}<br /><span className="font-mono-tab text-subtle">{compact(m.v)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
