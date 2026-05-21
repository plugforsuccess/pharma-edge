import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, ArrowDownCircle, ArrowUpCircle, CheckCircle2, Filter, ShieldAlert, Sparkles, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { evaluateRisk } from '../utils/botRiskEval'

// Flow page — the bot's feed.
//
// Replaces the prior option_flow_daily aggregate view with a live
// timeline of whale_tail_alerts: every UW print the scanner saw,
// what the filter decided, and (when we tailed) the position that
// resulted. Twitter-style feed so the user can scan during a meeting
// break and see "what did the bot just do?"
//
// Data source: public.whale_tail_alerts populated by the scanner
// (PR #2). Page renders cleanly with an empty table — the bot isn't
// running yet. Once the scanner is wired, alerts appear automatically
// via Supabase realtime.
//
// Top of page: bot status card (mode, today's stats, risk envelope,
// kill switch). Reads profiles.bot_config + bot_runs for today.

const STATUS_BADGE = {
  observed: { label: 'Observed', cls: 'bg-bg/60 border-border text-subtle' },
  queued: { label: 'Queued for entry', cls: 'bg-amber-950/30 border-amber-400/40 text-amber-400' },
  tailed: { label: 'Tailed', cls: 'bg-green-950/30 border-green-400/40 text-green-400' },
  skipped_filter: { label: 'Filtered out', cls: 'bg-bg/60 border-border text-muted' },
  skipped_caps: { label: 'Risk-capped', cls: 'bg-orange-950/30 border-orange-400/40 text-orange-400' },
  rejected_broker: { label: 'Broker rejected', cls: 'bg-red-950/20 border-crimson/40 text-crimson' },
  failed: { label: 'Failed', cls: 'bg-red-950/20 border-crimson/40 text-crimson' },
}

const FILTER_TABS = [
  { id: 'all', label: 'All' },
  { id: 'tailed', label: 'Tailed' },
  { id: 'queued', label: 'Queued' },
  { id: 'skipped', label: 'Skipped' },
]

export default function Flow() {
  const { user, profile } = useAuth()
  const [alerts, setAlerts] = useState([])
  const [todayRun, setTodayRun] = useState(null)
  const [openCount, setOpenCount] = useState(0)
  const [filterTab, setFilterTab] = useState('all')
  const [loading, setLoading] = useState(true)
  const [killSwitchBusy, setKillSwitchBusy] = useState(false)
  const [killSwitchError, setKillSwitchError] = useState(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
      const [alertsRes, runRes, openRes] = await Promise.all([
        supabase
          .from('whale_tail_alerts')
          .select('*')
          .eq('user_id', user.id)
          .order('received_at', { ascending: false })
          .limit(50),
        supabase
          .from('bot_runs')
          .select('*')
          .eq('user_id', user.id)
          .eq('run_date', today)
          .maybeSingle(),
        supabase
          .from('open_positions')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('status', 'open'),
      ])
      if (cancelled) return
      setAlerts(alertsRes.data ?? [])
      setTodayRun(runRes.data ?? null)
      setOpenCount(openRes.count ?? 0)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [user])

  // Realtime: new alerts append at top, status changes update in place.
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel(`flow:user:${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'whale_tail_alerts', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setAlerts((prev) => [payload.new, ...prev].slice(0, 50))
          } else if (payload.eventType === 'UPDATE') {
            setAlerts((prev) => prev.map((a) => (a.id === payload.new.id ? payload.new : a)))
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bot_runs', filter: `user_id=eq.${user.id}` },
        (payload) => {
          if (payload.new) setTodayRun(payload.new)
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user])

  const filtered = useMemo(() => {
    if (filterTab === 'all') return alerts
    if (filterTab === 'tailed') return alerts.filter((a) => a.status === 'tailed')
    if (filterTab === 'queued') return alerts.filter((a) => a.status === 'queued')
    if (filterTab === 'skipped') return alerts.filter((a) =>
      ['skipped_filter', 'skipped_caps', 'rejected_broker', 'failed'].includes(a.status),
    )
    return alerts
  }, [alerts, filterTab])

  async function haltBot() {
    if (!user) return
    if (!confirm('Halt the bot? This cancels all working orders and requests close on every open position. Manual resume required.')) return
    setKillSwitchBusy(true)
    setKillSwitchError(null)
    try {
      const { data, error } = await supabase.functions.invoke('bot-kill-switch', {
        body: { reason: 'manual halt from Flow page' },
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'kill switch failed')
    } catch (e) {
      setKillSwitchError(e.message || 'kill switch failed')
    } finally {
      setKillSwitchBusy(false)
    }
  }

  return (
    <div className="px-4 lg:px-6 py-5 max-w-md lg:max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-semibold leading-tight">Flow</h1>
        <p className="text-xs text-subtle">
          Live whale-print feed. Bot scanner runs during RTH; alerts appear here in real time.
        </p>
      </div>

      <BotStatusCard
        profile={profile}
        todayRun={todayRun}
        openCount={openCount}
        onHalt={haltBot}
        killSwitchBusy={killSwitchBusy}
        killSwitchError={killSwitchError}
      />


      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Filter size={12} className="text-muted shrink-0" />
        {FILTER_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setFilterTab(t.id)}
            className={`text-[11px] uppercase tracking-wider px-2.5 py-1 rounded-full border transition shrink-0 ${
              filterTab === t.id
                ? 'bg-amber-400/10 border-amber-400/40 text-amber-400'
                : 'bg-bg/60 border-border text-subtle hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-xs text-subtle py-8 text-center">Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState filterTab={filterTab} botEnabled={profile?.bot_config?.enabled} />
      ) : (
        <div className="space-y-2">
          {filtered.map((a) => (
            <AlertCard key={a.id} alert={a} />
          ))}
        </div>
      )}
    </div>
  )
}

function BotStatusCard({ profile, todayRun, openCount, onHalt, killSwitchBusy, killSwitchError }) {
  const config = profile?.bot_config ?? {}
  const enabled = config.enabled ?? false
  const mode = config.mode ?? 'paper'
  const pausedUntil = profile?.bot_paused_until
  const pausedReason = profile?.bot_paused_reason
  const isPaused = pausedUntil && new Date(pausedUntil).getTime() > Date.now()

  // Live broker NLV — same pattern as BotSettingsSection + AccountContextCard.
  // The stale profile.account_size is a $1M placeholder; without this the
  // risk envelope reads as 4%/20%/35% of $1M instead of the user's actual
  // Tastytrade balance.
  //
  // Account selection: when mode='paper', look up sandbox_account_number;
  // when mode='live', look up live_account_number. Falls back to the
  // largest non-paper account if the configured number isn't found in the
  // broker response (catches the unconfigured case + stale account numbers).
  const [liveNlv, setLiveNlv] = useState(null)
  const [liveNlvSource, setLiveNlvSource] = useState('loading')
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Pass env that matches the current bot mode so we look in the
        // right Tastytrade environment for the configured account.
        // mode=paper → env=cert (api.cert.tastyworks.com)
        // mode=live  → env=live (api.tastyworks.com)
        const targetEnv = mode === 'paper' ? 'cert' : 'live'
        const { data, error: err } = await supabase.functions.invoke('get-account', {
          body: { env: targetEnv },
        })
        if (cancelled) return
        if (err || !data?.success) {
          setLiveNlvSource('broker_unreachable')
          return
        }
        const accounts = (data.accounts ?? []).slice()
        accounts.sort(
          (a, b) =>
            Number(b.net_liquidating_value ?? 0) - Number(a.net_liquidating_value ?? 0),
        )
        const targetNumber = mode === 'live'
          ? config.live_account_number
          : config.sandbox_account_number
        const matched = targetNumber
          ? accounts.find((a) => String(a.account_number) === String(targetNumber))
          : null
        const primary = matched || accounts.find((a) => !a.is_paper) || accounts[0]
        const nlv = Number(primary?.net_liquidating_value)
        if (Number.isFinite(nlv) && nlv > 0) {
          setLiveNlv(nlv)
          setLiveNlvSource(
            matched
              ? (targetEnv === 'cert' ? 'broker_cert' : (primary.is_paper ? 'broker_paper' : 'broker_live'))
              : 'broker_fallback',
          )
        } else {
          setLiveNlvSource('broker_no_balance')
        }
      } catch {
        if (!cancelled) setLiveNlvSource('broker_unreachable')
      }
    })()
    return () => { cancelled = true }
  }, [profile?.id, mode, config.live_account_number, config.sandbox_account_number])

  const manualNlv = Number(profile?.account_size) || 0
  const nlv = liveNlv ?? manualNlv
  const envelope = useMemo(() => {
    if (!profile) return null
    try {
      return evaluateRisk({
        config: { ...config, event_block_days: config.event_block_days ?? [] },
        nlv,
        todayPnl: Number(todayRun?.daily_pnl) || 0,
        weekPnl: Number(todayRun?.daily_pnl) || 0,
        openPositionsCount: openCount,
        openExposureDollars: 0,
        tradesAttemptedToday: Number(todayRun?.trades_attempted) || 0,
        recentClosedTrades: [],
        botPausedUntil: pausedUntil,
        botPausedReason: pausedReason,
        todayEventBlock: null,
      })
    } catch {
      return null
    }
  }, [profile, config, nlv, todayRun, openCount, pausedUntil, pausedReason])

  let statusLabel, statusTone, statusIcon
  if (isPaused) {
    statusLabel = 'HALTED'
    statusTone = 'text-crimson border-crimson/40 bg-crimson/10'
    statusIcon = <ShieldAlert size={14} className="text-crimson" />
  } else if (!enabled) {
    statusLabel = 'DISABLED'
    statusTone = 'text-muted border-border bg-bg/60'
    statusIcon = <Activity size={14} className="text-muted" />
  } else if (mode === 'paper') {
    statusLabel = 'PAPER · ACTIVE'
    statusTone = 'text-amber-400 border-amber-400/40 bg-amber-400/10'
    statusIcon = <Sparkles size={14} className="text-amber-400" />
  } else {
    statusLabel = 'LIVE · ACTIVE'
    statusTone = 'text-green-400 border-green-400/40 bg-green-400/10'
    statusIcon = <Sparkles size={14} className="text-green-400" />
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {statusIcon}
          <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded border ${statusTone}`}>
            {statusLabel}
          </span>
        </div>
        {enabled && !isPaused && (
          <button
            onClick={onHalt}
            disabled={killSwitchBusy}
            className="text-[11px] font-semibold text-crimson hover:text-red-300 disabled:opacity-50 px-2 py-1 border border-crimson/30 rounded transition"
          >
            {killSwitchBusy ? 'Halting…' : 'HALT BOT'}
          </button>
        )}
      </div>

      {isPaused && (
        <div className="bg-crimson/10 border border-crimson/40 rounded-lg p-2 text-[11px] text-crimson space-y-1">
          <div className="font-semibold">Bot is halted.</div>
          {pausedReason && <div>Reason: {pausedReason}</div>}
          <div className="text-subtle text-[10px]">
            Resume from Settings → Bot → Reset pause.
          </div>
        </div>
      )}

      {killSwitchError && (
        <div className="text-[11px] text-crimson">{killSwitchError}</div>
      )}

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <Stat label="Trades today" value={String(todayRun?.trades_attempted ?? 0)} />
        <Stat
          label="Daily P&L"
          value={formatPnl(todayRun?.daily_pnl)}
          tone={Number(todayRun?.daily_pnl) > 0 ? 'pos' : Number(todayRun?.daily_pnl) < 0 ? 'neg' : 'neutral'}
        />
        <Stat label="Open" value={`${openCount} / ${config.max_concurrent_positions ?? 3}`} />
      </div>

      {envelope?.envelope && nlv > 0 && (
        <div className="bg-bg/40 border border-border/50 rounded-lg p-2.5 space-y-1 text-[10px]">
          <div className="flex items-center justify-between">
            <span className="uppercase tracking-wider text-muted">Risk envelope</span>
            <span className={
              liveNlvSource === 'broker_live'
                ? 'text-green-400 text-[9px] font-mono-tab'
                : 'text-amber-400 text-[9px] font-mono-tab'
            }>
              NLV ${nlv.toLocaleString()} · {nlvSourceLabel(liveNlvSource)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-subtle">Max loss / trade</span>
            <span className="text-fg font-mono-tab">${envelope.envelope.perTradeMaxLossDollars.toFixed(0)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-subtle">Daily loss cap</span>
            <span className="text-fg font-mono-tab">${envelope.envelope.dailyLossCapDollars.toFixed(0)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-subtle">Weekly loss cap</span>
            <span className="text-fg font-mono-tab">${envelope.envelope.weeklyLossCapDollars.toFixed(0)}</span>
          </div>
        </div>
      )}

      {envelope && !envelope.allowEntry && (
        <div className="bg-amber-950/30 border border-amber-400/40 rounded-lg p-2 text-[11px] text-amber-400 flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{envelope.blockReason}</span>
        </div>
      )}
    </div>
  )
}

function AlertCard({ alert }) {
  const badge = STATUS_BADGE[alert.status] ?? STATUS_BADGE.observed
  const isCall = alert.option_type === 'C'
  const directionIcon = isCall
    ? <ArrowUpCircle size={12} className="text-green-400" />
    : <ArrowDownCircle size={12} className="text-crimson" />
  const filterFailures = Array.isArray(alert.filter_failures) ? alert.filter_failures : []

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {directionIcon}
          <span className="font-semibold text-sm">{alert.ticker}</span>
          <span className="text-subtle text-xs truncate">
            ${Number(alert.strike).toFixed(alert.strike >= 100 ? 0 : 2)} {isCall ? 'Call' : 'Put'}
          </span>
        </div>
        <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${badge.cls} shrink-0`}>
          {badge.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
        <Row label="Premium" value={`$${(Number(alert.premium_dollars) / 1000).toFixed(0)}K`} />
        <Row label="Exp" value={alert.expiry_date} />
        <Row label="DTE" value={`${alert.dte ?? '—'}d`} />
        <Row label="OTM" value={alert.otm_pct != null ? `${Number(alert.otm_pct).toFixed(1)}%` : '—'} />
        <Row label="Vol/OI" value={alert.vol_oi_ratio != null ? `${Number(alert.vol_oi_ratio).toFixed(1)}x` : '—'} />
        <Row label="Mid" value={alert.mid != null ? `$${Number(alert.mid).toFixed(2)}` : '—'} />
      </div>

      {alert.status === 'tailed' && alert.triggered_position_id && (
        <a
          href={`/position/${alert.triggered_position_id}`}
          className="block text-[11px] text-green-400 hover:text-green-300 pt-1 border-t border-border/50"
        >
          <CheckCircle2 size={11} className="inline mr-1" />
          View position →
        </a>
      )}

      {alert.status === 'skipped_filter' && filterFailures.length > 0 && (
        <div className="text-[10px] text-muted pt-1 border-t border-border/50">
          Filter failures: {filterFailures.join(', ')}
        </div>
      )}

      {alert.status === 'skipped_caps' && (
        <div className="text-[10px] text-orange-400 pt-1 border-t border-border/50">
          Skipped: risk envelope full
        </div>
      )}

      {(alert.status === 'rejected_broker' || alert.status === 'failed') && (
        <div className="text-[10px] text-crimson pt-1 border-t border-border/50 flex items-start gap-1">
          <XCircle size={10} className="mt-0.5 shrink-0" />
          <span>Order failed — check admin logs</span>
        </div>
      )}

      <div className="text-[9px] text-muted text-right">
        {formatAgo(alert.received_at)}
      </div>
    </div>
  )
}

function EmptyState({ filterTab, botEnabled }) {
  return (
    <div className="bg-card border border-border rounded-xl p-6 text-center space-y-2">
      <div className="text-xs text-subtle">
        {filterTab === 'all' ? (
          botEnabled
            ? 'No qualifying alerts yet. The scanner runs during RTH; new prints appear here in real time.'
            : 'Bot is disabled. Enable it from Settings → Bot to start scanning.'
        ) : (
          `No alerts matching "${filterTab}" yet.`
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, tone = 'neutral' }) {
  const toneCls =
    tone === 'pos' ? 'text-green-400' :
    tone === 'neg' ? 'text-crimson' : 'text-fg'
  return (
    <div className="bg-bg/40 border border-border/50 rounded-lg p-2 text-center">
      <div className="text-[9px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-sm font-mono-tab font-semibold ${toneCls}`}>{value}</div>
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="contents">
      <span className="text-muted">{label}</span>
      <span className="text-right text-fg font-mono-tab">{value}</span>
    </div>
  )
}

function formatPnl(n) {
  const v = Number(n) || 0
  const sign = v >= 0 ? '+' : '−'
  return `${sign}$${Math.abs(v).toFixed(0)}`
}

function formatAgo(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function nlvSourceLabel(source) {
  switch (source) {
    case 'loading':            return 'loading…'
    case 'broker_live':        return 'live broker'
    case 'broker_paper':       return 'prod paper'
    case 'broker_cert':        return 'cert sandbox'
    case 'broker_fallback':    return 'no account match'
    case 'broker_no_balance':  return 'broker no balance'
    case 'broker_unreachable': return 'profile fallback'
    default:                   return source
  }
}
