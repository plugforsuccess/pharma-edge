import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { peerComparisons } from '../utils/peers'
import { todayYmd } from '../utils/afterTax'

// Portfolio → Total card → Peers (owner, 2026-10-03; free): the user's net
// worth before tax against US households, from the Federal Reserve's
// Survey of Consumer Finances 2022 (inflation-adjusted). The benchmarks
// file is built in Actions (scraper/build_net_worth_benchmarks.py); until
// it exists the view says so instead of guessing.
const files = import.meta.glob('../data/netWorthBenchmarks.json', { eager: true, import: 'default' })
const BENCHMARKS = Object.values(files)[0] ?? null

const usd = (n) => (Number.isFinite(n) ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}` : '—')
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
  }), [netWorth, p.birth_date, p.filing_status, p.annual_income, homeowner, p.sex, p.race_ethnicity, p.education])

  if (!BENCHMARKS) {
    return <p className="text-sm text-subtle">Comparison data isn't available yet.</p>
  }
  const head = result.rows.find((r) => r.headline)
  const rest = result.rows.filter((r) => !r.headline)
  const src = BENCHMARKS.source

  return (
    <div>
      {head ? (
        <div className="mb-5">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-1">{head.label}</div>
          <div className="text-3xl font-semibold font-mono-tab text-green-400">{head.rank}</div>
          <div className="text-xs text-subtle mt-1">
            Your net worth before tax, <span className="font-mono-tab text-fg">{usd(netWorth)}</span>
          </div>
          <PercentileBar row={head} netWorth={netWorth} />
        </div>
      ) : (
        <div className="mb-5 rounded-xl border border-hairline bg-bg/40 px-4 py-3 text-sm text-subtle">
          Add your birth date to compare with households your age.
          <Link to="/settings#about-you" className="ml-1 text-amber-300 underline decoration-dotted underline-offset-4">Add it in Settings</Link>
        </div>
      )}

      <ul className="divide-y divide-hairline border-t border-hairline">
        {rest.map((r) => (
          <li key={r.key} className="py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-fg leading-snug">{r.label}</div>
              <div className="text-xs text-muted font-mono-tab">Median {usd(r.median)}</div>
            </div>
            <div className={clsx('text-sm font-semibold font-mono-tab shrink-0', (r.pct ?? 0) >= 50 ? 'text-green-400' : 'text-subtle')}>{r.rank}</div>
          </li>
        ))}
      </ul>

      {!(p.sex || p.race_ethnicity || p.education) && (
        <p className="mt-3 text-xs text-muted">
          You can also compare by education, race or ethnicity, and (for single households) sex.
          <Link to="/settings#about-you" className="ml-1 text-amber-300">Settings</Link>
        </p>
      )}
      <p className="mt-3 text-xs text-muted">
        {src.survey}, {src.dollars.replace(/^(\d{4}) dollars adjusted by CPI-U to/, '$1 dollars adjusted for inflation to')}.
        Net worth before tax, compared by household.
      </p>
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
