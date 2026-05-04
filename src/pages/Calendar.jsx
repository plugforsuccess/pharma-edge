import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  eachDayOfInterval,
  endOfMonth,
  format,
  isSameDay,
  parseISO,
  startOfMonth,
} from 'date-fns'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { daysUntil } from '../utils/dates'
import clsx from 'clsx'

export default function Calendar() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [signals, setSignals] = useState([])
  const [month, setMonth] = useState(() => new Date())
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    if (!user) return
    fetchSignals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  async function fetchSignals() {
    const { data } = await supabase
      .from('signals')
      .select('id, ticker, direction, catalyst_date, catalyst_type, status, confidence_score')
      .eq('user_id', user.id)
      .in('status', ['active', 'closed'])
      .order('catalyst_date', { ascending: true })
    setSignals(data ?? [])
  }

  const days = useMemo(() => {
    const start = startOfMonth(month)
    const end = endOfMonth(month)
    const padStart = start.getDay()
    return [...Array(padStart).fill(null), ...eachDayOfInterval({ start, end })]
  }, [month])

  function signalsOnDay(day) {
    if (!day) return []
    return signals.filter((s) => isSameDay(parseISO(s.catalyst_date), day))
  }

  const upcoming = signals
    .map((s) => ({ ...s, _daysTo: daysUntil(s.catalyst_date) ?? -Infinity }))
    .filter((s) => s._daysTo >= 0)
    .sort((a, b) => a._daysTo - b._daysTo)

  const selectedSignals = selected ? signalsOnDay(selected) : []

  return (
    <div className="px-4 pt-6 pb-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-white text-xl font-bold">Calendar</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1))}
            aria-label="Previous month"
            className="w-8 h-8 bg-card border border-border rounded-lg flex items-center justify-center text-zinc-400"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-white text-sm font-medium min-w-24 text-center">
            {format(month, 'MMMM yyyy')}
          </span>
          <button
            type="button"
            onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1))}
            aria-label="Next month"
            className="w-8 h-8 bg-card border border-border rounded-lg flex items-center justify-center text-zinc-400"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 mb-2">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <div key={i} className="text-center text-muted text-[10px] py-1">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1 mb-6">
        {days.map((day, i) => {
          if (!day) return <div key={i} />
          const daySignals = signalsOnDay(day)
          const dt = daysUntil(format(day, 'yyyy-MM-dd')) ?? 0
          const urgency =
            daySignals.length === 0
              ? null
              : dt < 0
                ? 'past'
                : dt <= 7
                  ? 'urgent'
                  : dt <= 14
                    ? 'soon'
                    : 'normal'
          const isToday = isSameDay(day, new Date())
          const isSelected = selected && isSameDay(day, selected)

          return (
            <button
              key={i}
              type="button"
              onClick={() => setSelected(isSelected ? null : day)}
              className={clsx(
                'aspect-square rounded-lg flex flex-col items-center justify-center relative transition-colors',
                isSelected
                  ? 'bg-red-600 text-white'
                  : isToday
                    ? 'bg-border text-white'
                    : 'text-subtle hover:bg-card',
              )}
            >
              <span className="text-xs font-medium">{format(day, 'd')}</span>
              {daySignals.length > 0 && (
                <div className="flex gap-0.5 mt-0.5">
                  {daySignals.slice(0, 3).map((_, j) => (
                    <div
                      key={j}
                      className={clsx(
                        'w-1 h-1 rounded-full',
                        isSelected
                          ? 'bg-white'
                          : urgency === 'urgent'
                            ? 'bg-red-500'
                            : urgency === 'soon'
                              ? 'bg-yellow-500'
                              : urgency === 'past'
                                ? 'bg-zinc-600'
                                : 'bg-blue-500',
                      )}
                    />
                  ))}
                </div>
              )}
            </button>
          )
        })}
      </div>

      {selected && selectedSignals.length > 0 && (
        <div className="mb-6">
          <p className="text-subtle text-xs font-semibold uppercase tracking-wider mb-2">
            {format(selected, 'MMMM d, yyyy')}
          </p>
          <div className="space-y-2">
            {selectedSignals.map((signal) => (
              <CalendarSignalCard
                key={signal.id}
                signal={signal}
                daysTo={daysUntil(signal.catalyst_date) ?? 0}
                onClick={() => navigate(`/signal/${signal.id}`)}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
          Upcoming Catalysts
        </p>
        {upcoming.length === 0 ? (
          <p className="text-muted text-sm">No upcoming catalysts</p>
        ) : (
          <div className="space-y-2">
            {upcoming.slice(0, 10).map((signal) => (
              <CalendarSignalCard
                key={signal.id}
                signal={signal}
                daysTo={signal._daysTo}
                onClick={() => navigate(`/signal/${signal.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function CalendarSignalCard({ signal, daysTo, onClick }) {
  const urgency = daysTo <= 7 ? 'urgent' : daysTo <= 14 ? 'soon' : 'normal'

  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'w-full text-left border rounded-xl px-4 py-3 flex items-center gap-3 transition-all active:scale-[0.98]',
        urgency === 'urgent'
          ? 'bg-red-950/20 border-red-900/40'
          : urgency === 'soon'
            ? 'bg-yellow-950/10 border-yellow-900/30'
            : 'bg-card border-border',
      )}
    >
      <div
        className={clsx(
          'w-2 h-10 rounded-full flex-shrink-0',
          signal.direction === 'long_put'
            ? 'bg-red-500'
            : signal.direction === 'long_call'
              ? 'bg-green-500'
              : 'bg-zinc-600',
        )}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white font-bold text-sm">{signal.ticker}</p>
          <span className="text-[10px] text-muted">
            {signal.catalyst_type?.replace(/_/g, ' ')}
          </span>
        </div>
        <p className="text-subtle text-xs mt-0.5">
          {new Date(signal.catalyst_date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </p>
      </div>

      <div className="text-right flex-shrink-0">
        <p
          className={clsx(
            'font-bold text-sm',
            urgency === 'urgent'
              ? 'text-red-400'
              : urgency === 'soon'
                ? 'text-yellow-400'
                : 'text-zinc-400',
          )}
        >
          {daysTo}d
        </p>
      </div>
    </button>
  )
}
