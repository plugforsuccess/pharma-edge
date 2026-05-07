import { useEffect, useMemo, useState } from 'react'
import {
  Bell,
  X,
  Clock,
  AlertTriangle,
  TrendingUp,
  FileBarChart,
  FileEdit,
  Sparkles,
  CheckCheck,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import clsx from 'clsx'

// Map alert_type → lucide icon + tone. Kept terse: emoji ages poorly
// across platforms (Apple's clock vs Android's clock vs the empty-box
// fallback on Linux Firefox) and breaks visual parity with the rest
// of the app's lucide-only iconography.
const TYPE_META = {
  catalyst_approaching_14d: { Icon: Clock, tone: 'amber', label: 'Catalyst' },
  catalyst_approaching_7d: { Icon: Clock, tone: 'amber', label: 'Catalyst' },
  catalyst_tomorrow: { Icon: Clock, tone: 'red', label: 'Catalyst' },
  stop_loss_triggered: { Icon: AlertTriangle, tone: 'red', label: 'Stop loss' },
  profit_target_hit: { Icon: TrendingUp, tone: 'green', label: 'Profit' },
  daily_digest: { Icon: FileBarChart, tone: 'subtle', label: 'Digest' },
  outcome_reminder: { Icon: FileEdit, tone: 'amber', label: 'Outcome' },
  new_signal: { Icon: Sparkles, tone: 'amber', label: 'Signal' },
}

const TONE_BG = {
  amber: 'bg-amber-400/10 text-amber-400',
  red: 'bg-red-500/10 text-red-400',
  green: 'bg-emerald-500/10 text-emerald-400',
  subtle: 'bg-bg-elev text-subtle',
}

function metaFor(type) {
  return TYPE_META[type] ?? { Icon: Bell, tone: 'subtle', label: 'Alert' }
}

// Relative time labels — keeps the row tight and readable. Anything
// older than a week falls back to a date so users still get a frame
// of reference.
function relTime(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function isToday(iso) {
  if (!iso) return false
  const d = new Date(iso)
  const t = new Date()
  return (
    d.getFullYear() === t.getFullYear() &&
    d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate()
  )
}

export default function NotificationCenter() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [alerts, setAlerts] = useState([])
  const [unread, setUnread] = useState(0)
  const [filter, setFilter] = useState('all') // 'all' | 'unread'

  useEffect(() => {
    if (!user?.id) return
    let mounted = true

    async function load() {
      const { data } = await supabase
        .from('alerts')
        .select('*')
        .eq('user_id', user.id)
        .order('sent_at', { ascending: false })
        .limit(20)
      if (!mounted) return
      const list = data ?? []
      setAlerts(list)
      setUnread(list.filter((a) => !a.read_at).length)
    }
    load()

    // Per-user channel name so multiple sessions don't collide.
    const channel = supabase
      .channel(`alerts:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'alerts',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          if (!mounted) return
          setAlerts((prev) => [payload.new, ...prev].slice(0, 20))
          setUnread((u) => u + 1)
        },
      )
      .subscribe()

    return () => {
      mounted = false
      supabase.removeChannel(channel)
    }
  }, [user?.id])

  async function markRead(id) {
    if (!user?.id || !id) return
    const target = alerts.find((a) => a.id === id)
    if (!target || target.read_at) return
    const now = new Date().toISOString()
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, read_at: now } : a)))
    setUnread((u) => Math.max(0, u - 1))
    await supabase
      .from('alerts')
      .update({ read_at: now })
      .eq('id', id)
      .eq('user_id', user.id)
  }

  async function markAllRead() {
    if (!user?.id) return
    const unreadIds = alerts.filter((a) => !a.read_at).map((a) => a.id)
    if (unreadIds.length === 0) return
    const now = new Date().toISOString()
    setAlerts((prev) => prev.map((a) => (a.read_at ? a : { ...a, read_at: now })))
    setUnread(0)
    await supabase
      .from('alerts')
      .update({ read_at: now })
      .in('id', unreadIds)
      .eq('user_id', user.id)
  }

  function handleRowClick(alert) {
    markRead(alert.id)
    if (alert.signal_id) {
      setOpen(false)
      navigate(`/signal/${alert.signal_id}`)
    }
  }

  const visible = useMemo(
    () => (filter === 'unread' ? alerts.filter((a) => !a.read_at) : alerts),
    [alerts, filter],
  )

  const { todayRows, earlierRows } = useMemo(() => {
    const today = []
    const earlier = []
    for (const a of visible) {
      ;(isToday(a.sent_at) ? today : earlier).push(a)
    }
    return { todayRows: today, earlierRows: earlier }
  }, [visible])

  return (
    <>
      <button
        type="button"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'tap-spring relative w-9 h-9 bg-card border rounded-xl',
          'flex items-center justify-center transition-colors',
          unread > 0
            ? 'border-amber-400/40 text-amber-400 hover:text-amber-300'
            : 'border-border text-muted hover:text-fg',
        )}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 bg-amber-400 rounded-full text-[10px] text-bg flex items-center justify-center font-bold">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60]"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div
            className="absolute top-16 right-4 w-[22rem] max-w-[calc(100vw-2rem)] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Notifications"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <span className="text-fg text-sm font-semibold">Notifications</span>
                {unread > 0 && (
                  <span className="text-[10px] text-amber-400 font-semibold">
                    {unread} new
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={markAllRead}
                  disabled={unread === 0}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-md text-subtle hover:text-fg disabled:opacity-30 disabled:hover:text-subtle"
                  title="Mark all as read"
                >
                  <CheckCheck size={12} />
                  Mark all
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="p-1 text-subtle hover:text-fg"
                  aria-label="Close notifications"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="flex border-b border-border bg-bg-elev/40 px-1.5 py-1.5 gap-1">
              {[
                { id: 'all', label: 'All', count: alerts.length },
                { id: 'unread', label: 'Unread', count: unread },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  className={clsx(
                    'flex-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors',
                    filter === tab.id
                      ? 'bg-card text-fg'
                      : 'text-subtle hover:text-fg',
                  )}
                >
                  {tab.label}
                  {tab.count > 0 && (
                    <span className="ml-1 text-muted">{tab.count}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="max-h-[28rem] overflow-y-auto">
              {visible.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-bg-elev flex items-center justify-center text-muted">
                    <Bell size={16} />
                  </div>
                  <p className="text-subtle text-sm font-medium">
                    {filter === 'unread' ? "You're all caught up" : 'No notifications yet'}
                  </p>
                  <p className="text-muted text-[11px] mt-1">
                    {filter === 'unread'
                      ? 'New alerts will appear here.'
                      : 'Catalyst, stop-loss, and digest alerts land here.'}
                  </p>
                </div>
              ) : (
                <>
                  {todayRows.length > 0 && (
                    <NotificationGroup
                      label="Today"
                      rows={todayRows}
                      onClick={handleRowClick}
                    />
                  )}
                  {earlierRows.length > 0 && (
                    <NotificationGroup
                      label="Earlier"
                      rows={earlierRows}
                      onClick={handleRowClick}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function NotificationGroup({ label, rows, onClick }) {
  return (
    <div>
      <div className="px-4 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted">
        {label}
      </div>
      {rows.map((alert) => (
        <NotificationRow key={alert.id} alert={alert} onClick={onClick} />
      ))}
    </div>
  )
}

function NotificationRow({ alert, onClick }) {
  const meta = metaFor(alert.alert_type)
  const Icon = meta.Icon
  const isUnread = !alert.read_at
  const clickable = Boolean(alert.signal_id)
  return (
    <button
      type="button"
      onClick={() => onClick(alert)}
      className={clsx(
        'w-full text-left px-4 py-3 border-b border-border/60 transition-colors',
        'flex items-start gap-3',
        clickable ? 'hover:bg-bg-elev cursor-pointer' : 'cursor-default',
        isUnread && 'border-l-2 border-l-amber-400',
      )}
    >
      <span
        className={clsx(
          'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0',
          TONE_BG[meta.tone] ?? TONE_BG.subtle,
        )}
        aria-hidden="true"
      >
        <Icon size={14} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted">
            {meta.label}
          </span>
          <span className="text-[10px] text-muted">·</span>
          <span className="text-[10px] text-muted">{relTime(alert.sent_at)}</span>
        </div>
        <p className={clsx('text-xs leading-relaxed', isUnread ? 'text-fg' : 'text-subtle')}>
          {alert.message}
        </p>
      </div>
      {isUnread && (
        <span
          className="w-1.5 h-1.5 bg-amber-400 rounded-full mt-1.5 flex-shrink-0"
          aria-label="Unread"
        />
      )}
    </button>
  )
}
