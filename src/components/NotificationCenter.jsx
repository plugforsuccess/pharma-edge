import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import clsx from 'clsx'

const ICON = (type = '') => {
  if (type.includes('catalyst')) return '⏰'
  if (type.includes('stop_loss')) return '⚠️'
  if (type.includes('profit')) return '✅'
  if (type.includes('digest')) return '📊'
  if (type.includes('outcome')) return '📝'
  return '🔔'
}

export default function NotificationCenter() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [alerts, setAlerts] = useState([])
  const [unread, setUnread] = useState(0)

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

  async function markAllRead() {
    if (!user?.id) return
    const unreadIds = alerts.filter((a) => !a.read_at).map((a) => a.id)
    if (unreadIds.length === 0) return

    const now = new Date().toISOString()
    await supabase
      .from('alerts')
      .update({ read_at: now })
      .in('id', unreadIds)
      .eq('user_id', user.id)

    setAlerts((prev) => prev.map((a) => (a.read_at ? a : { ...a, read_at: now })))
    setUnread(0)
  }

  return (
    <>
      <button
        type="button"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        onClick={() => {
          setOpen((o) => !o)
          if (!open) markAllRead()
        }}
        className="relative w-9 h-9 bg-card border border-border rounded-xl
                   flex items-center justify-center text-zinc-400 hover:text-white
                   transition-colors"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-[9px] text-white flex items-center justify-center font-bold">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div
            className="absolute top-16 right-4 w-80 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Notifications"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-white text-sm font-semibold">Notifications</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-subtle hover:text-white"
                aria-label="Close notifications"
              >
                <X size={14} />
              </button>
            </div>

            <div className="max-h-96 overflow-y-auto">
              {alerts.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-muted text-sm">No notifications yet</p>
                </div>
              ) : (
                alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={clsx(
                      'px-4 py-3 border-b border-border',
                      !alert.read_at ? 'bg-red-950/10' : '',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-lg" aria-hidden="true">
                        {ICON(alert.alert_type)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-zinc-300 text-xs leading-relaxed">
                          {alert.message}
                        </p>
                        <p className="text-muted text-[10px] mt-1">
                          {new Date(alert.sent_at).toLocaleDateString()} · {alert.sent_via}
                        </p>
                      </div>
                      {!alert.read_at && (
                        <div className="w-1.5 h-1.5 bg-red-500 rounded-full mt-1.5 flex-shrink-0" />
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
