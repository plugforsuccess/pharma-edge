import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Activity, DollarSign, Users, TrendingUp, Clock, AlertCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import Spinner from '../components/Spinner'

// Owner-only dashboard: spend ledger, user counts, funnel, cron health.
// Gated by profiles.is_admin = true (set manually for the platform
// owner's row). Non-admins land here and get bounced back to the tape.
//
// All queries run as the user against tables with admin SELECT policies
// added in migration 20260509_admin_dashboard_and_token_attribution.
// No service-role calls from the client.

export default function Admin() {
  const { profile } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [cost, setCost] = useState(null)
  const [users, setUsers] = useState(null)
  const [funnel, setFunnel] = useState(null)
  const [cron, setCron] = useState(null)

  useEffect(() => {
    if (profile && !profile.is_admin) return
    if (!profile) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const [costData, usersData, funnelData, cronData] = await Promise.all([
          loadCost(),
          loadUsers(),
          loadFunnel(),
          loadCron(),
        ])
        if (cancelled) return
        setCost(costData)
        setUsers(usersData)
        setFunnel(funnelData)
        setCron(cronData)
      } catch (e) {
        if (!cancelled) setError(e.message ?? String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [profile])

  if (profile && !profile.is_admin) {
    return <Navigate to="/" replace />
  }

  if (loading || !profile) {
    return (
      <div className="px-4 lg:px-6 py-8 max-w-md lg:max-w-4xl mx-auto">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="px-4 lg:px-6 py-5 max-w-md lg:max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-semibold leading-tight">Admin</h1>
        <p className="text-xs text-subtle">Owner-only spend, users, funnel, cron health.</p>
      </div>

      {error && (
        <div className="bg-card border border-crimson/40 rounded-xl p-3 text-xs text-crimson flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {cost && <CostCard cost={cost} />}
      {users && <UsersCard users={users} />}
      {funnel && <FunnelCard funnel={funnel} />}
      {cron && <CronCard cron={cron} />}
    </div>
  )
}

// ─── Loaders ────────────────────────────────────────────────────

async function loadCost() {
  // Pull last 30 days from the admin_cost_daily view (one row per
  // (day, function_name)). Aggregate client-side since the dataset
  // is bounded (~30 days × 3 functions = 90 rows max).
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('admin_cost_daily')
    .select('*')
    .gte('day', since)
    .order('day', { ascending: false })
  if (error) throw error
  return data ?? []
}

async function loadUsers() {
  const [total, byTier, active7d] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('profiles').select('subscription_tier'),
    supabase
      .from('claude_calls')
      .select('user_id')
      .gte('called_at', new Date(Date.now() - 7 * 86_400_000).toISOString()),
  ])
  if (total.error) throw total.error
  if (byTier.error) throw byTier.error
  if (active7d.error) throw active7d.error
  const tierCounts = {}
  for (const p of byTier.data ?? []) {
    const t = p.subscription_tier ?? 'free'
    tierCounts[t] = (tierCounts[t] ?? 0) + 1
  }
  const activeUserIds = new Set((active7d.data ?? []).map((r) => r.user_id))
  return { total: total.count ?? 0, tierCounts, activeUsers7d: activeUserIds.size }
}

async function loadFunnel() {
  // Funnel stages: profile created → first signal logged → first
  // outcome recorded. Each stage measured as a distinct user count.
  const [profiles, signalUsers, outcomeUsers] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('signals').select('user_id'),
    supabase.from('outcomes').select('user_id'),
  ])
  if (profiles.error) throw profiles.error
  if (signalUsers.error) throw signalUsers.error
  if (outcomeUsers.error) throw outcomeUsers.error
  const usersWithSignal = new Set((signalUsers.data ?? []).map((r) => r.user_id))
  const usersWithOutcome = new Set((outcomeUsers.data ?? []).map((r) => r.user_id))
  return {
    signedUp: profiles.count ?? 0,
    loggedFirstSignal: usersWithSignal.size,
    loggedFirstOutcome: usersWithOutcome.size,
  }
}

async function loadCron() {
  // Most recent scanner_runs row per source. We pull the last 50 rows
  // across all sources and reduce client-side — fine for the
  // dashboard since scanner_runs is small (one row per source per
  // cron tick, ~3-5 sources).
  const { data, error } = await supabase
    .from('scanner_runs')
    .select('source, run_at, status, error_log, signals_generated')
    .order('run_at', { ascending: false })
    .limit(50)
  if (error) throw error
  const latest = {}
  for (const row of data ?? []) {
    if (!latest[row.source]) latest[row.source] = row
  }
  return Object.values(latest)
}

// ─── Cards ──────────────────────────────────────────────────────

function CostCard({ cost }) {
  const today = new Date().toISOString().slice(0, 10)
  const sevenAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  const todayRows = cost.filter((r) => r.day === today)
  const weekRows = cost.filter((r) => r.day >= sevenAgo)
  const monthRows = cost
  const sumCost = (rows) => rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)
  const sumCalls = (rows) => rows.reduce((s, r) => s + Number(r.call_count ?? 0), 0)

  const byFunction = {}
  for (const r of monthRows) {
    const f = r.function_name ?? 'unknown'
    if (!byFunction[f]) {
      byFunction[f] = { calls: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
    }
    byFunction[f].calls += Number(r.call_count ?? 0)
    byFunction[f].cost += Number(r.cost_usd ?? 0)
    byFunction[f].input += Number(r.input_tokens ?? 0)
    byFunction[f].output += Number(r.output_tokens ?? 0)
    byFunction[f].cacheRead += Number(r.cache_read_tokens ?? 0)
    byFunction[f].cacheCreate += Number(r.cache_creation_tokens ?? 0)
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <DollarSign size={14} className="text-brand" />
        <h2 className="text-sm font-semibold">Cost ledger</h2>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <BigStat label="Today" value={fmtUsd(sumCost(todayRows))} sub={`${sumCalls(todayRows)} calls`} />
        <BigStat label="Last 7d" value={fmtUsd(sumCost(weekRows))} sub={`${sumCalls(weekRows)} calls`} />
        <BigStat label="Last 30d" value={fmtUsd(sumCost(monthRows))} sub={`${sumCalls(monthRows)} calls`} />
      </div>
      {Object.keys(byFunction).length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-muted">Per function (30d)</div>
          {Object.entries(byFunction)
            .sort((a, b) => b[1].cost - a[1].cost)
            .map(([fn, v]) => (
              <div key={fn} className="text-xs flex items-baseline justify-between border-b border-border/50 pb-1">
                <div>
                  <div className="font-medium text-fg">{fn}</div>
                  <div className="text-[10px] text-muted">
                    {v.calls.toLocaleString()} calls · {fmtTokens(v.input)} in · {fmtTokens(v.output)} out · {fmtTokens(v.cacheRead)} cache hit
                  </div>
                </div>
                <div className="font-mono-tab text-fg">{fmtUsd(v.cost)}</div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function UsersCard({ users }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Users size={14} className="text-brand" />
        <h2 className="text-sm font-semibold">Users</h2>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <BigStat label="Total" value={users.total.toLocaleString()} />
        <BigStat label="Active 7d" value={users.activeUsers7d.toLocaleString()} sub="≥1 Claude call" />
      </div>
      {Object.keys(users.tierCounts).length > 0 && (
        <div className="space-y-1 pt-1">
          <div className="text-[10px] uppercase tracking-wider text-muted">By tier</div>
          {Object.entries(users.tierCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([tier, count]) => (
              <div key={tier} className="text-xs flex items-baseline justify-between">
                <span className="text-subtle">{tier}</span>
                <span className="font-mono-tab text-fg">{count}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function FunnelCard({ funnel }) {
  const stages = [
    { label: 'Signed up', value: funnel.signedUp },
    { label: 'Logged first signal', value: funnel.loggedFirstSignal },
    { label: 'Logged first outcome', value: funnel.loggedFirstOutcome },
  ]
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <TrendingUp size={14} className="text-brand" />
        <h2 className="text-sm font-semibold">Funnel</h2>
      </div>
      <div className="space-y-2">
        {stages.map((s, i) => {
          const dropFromPrev = i > 0 && stages[i - 1].value > 0
            ? 1 - s.value / stages[i - 1].value
            : null
          return (
            <div key={s.label} className="text-xs flex items-baseline justify-between border-b border-border/50 pb-1">
              <span className="text-subtle">{s.label}</span>
              <span className="font-mono-tab text-fg">
                {s.value.toLocaleString()}
                {dropFromPrev != null && dropFromPrev > 0 && (
                  <span className="text-muted ml-2">−{(dropFromPrev * 100).toFixed(0)}%</span>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CronCard({ cron }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Clock size={14} className="text-brand" />
        <h2 className="text-sm font-semibold">Cron health</h2>
      </div>
      {cron.length === 0 ? (
        <div className="text-xs text-subtle">No scanner_runs rows yet.</div>
      ) : (
        <div className="space-y-2">
          {cron.map((row) => {
            const ageMs = Date.now() - new Date(row.run_at).getTime()
            const stale = ageMs > 36 * 3600_000  // older than 36h is suspicious for a daily cron
            return (
              <div key={row.source} className="text-xs border-b border-border/50 pb-1.5 space-y-0.5">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium text-fg">{row.source ?? 'unknown'}</span>
                  <span className={`text-[10px] uppercase tracking-wider ${
                    row.status === 'success' ? 'text-green-400' : 'text-crimson'
                  }`}>
                    {row.status ?? 'unknown'}
                  </span>
                </div>
                <div className="flex items-baseline justify-between text-[11px]">
                  <span className={stale ? 'text-amber-400' : 'text-subtle'}>
                    {ago(row.run_at)} {stale && '· stale'}
                  </span>
                  <span className="font-mono-tab text-muted">
                    {row.signals_generated ?? 0} signals
                  </span>
                </div>
                {row.error_log && (
                  <div className="text-[10px] text-crimson font-mono leading-tight">
                    {row.error_log.slice(0, 200)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────

function BigStat({ label, value, sub }) {
  return (
    <div className="bg-bg/50 border border-border/50 rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-xl font-mono-tab font-semibold text-fg mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-muted mt-0.5">{sub}</div>}
    </div>
  )
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '$0'
  if (n >= 1000) return `$${n.toFixed(0)}`
  if (n >= 10) return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(3)}`
  return `$${n.toFixed(5)}`
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}
