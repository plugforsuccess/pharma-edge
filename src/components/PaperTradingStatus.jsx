import { useEffect, useState } from 'react'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import clsx from 'clsx'

// Paper-trading 90-day clock. Start date is stored in localStorage on first
// render; this is per-device (resetting if the user reinstalls or signs in
// from another device). When multi-device support is needed, persist this
// to profiles.paper_trading_started_at.

const STORAGE_KEY = 'pharmaEdge:paperTradingStartedAt'
const TARGET_DAYS = 90
const MIN_RESOLVED = 10
const MIN_WIN_RATE = 55

export default function PaperTradingStatus({ stats }) {
  const [daysElapsed, setDaysElapsed] = useState(0)

  useEffect(() => {
    let stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) {
      stored = new Date().toISOString().slice(0, 10)
      localStorage.setItem(STORAGE_KEY, stored)
    }
    try {
      setDaysElapsed(differenceInCalendarDays(new Date(), parseISO(stored)))
    } catch {
      setDaysElapsed(0)
    }
  }, [])

  const total = stats?.total ?? 0
  const winRate = stats?.winRate ?? 0
  const daysRemaining = Math.max(0, TARGET_DAYS - daysElapsed)
  const progress = Math.min((daysElapsed / TARGET_DAYS) * 100, 100)
  const readyForReal =
    daysElapsed >= TARGET_DAYS && total >= MIN_RESOLVED && winRate >= MIN_WIN_RATE

  return (
    <div
      className={clsx(
        'border rounded-xl p-4 mb-4',
        readyForReal ? 'bg-green-950/20 border-green-900/40' : 'bg-card border-border',
      )}
    >
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-subtle text-xs font-semibold uppercase tracking-wider">
            {readyForReal ? '✓ Paper Trading Complete' : 'Paper Trading Period'}
          </p>
          <p className="text-white text-sm font-bold mt-0.5">
            {readyForReal ? 'Ready for real capital' : `Day ${daysElapsed} of ${TARGET_DAYS}`}
          </p>
        </div>
        <div className="text-right">
          <p
            className={clsx(
              'text-2xl font-bold',
              readyForReal ? 'text-green-400' : 'text-white',
            )}
          >
            {daysRemaining}
          </p>
          <p className="text-muted text-[10px]">
            {daysRemaining > 0 ? 'days left' : 'days ago ✓'}
          </p>
        </div>
      </div>

      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden mb-3">
        <div
          className={clsx(
            'h-full rounded-full transition-all',
            readyForReal ? 'bg-green-500' : 'bg-red-500',
          )}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Requirement
          label={`${TARGET_DAYS} days`}
          met={daysElapsed >= TARGET_DAYS}
          value={`${daysElapsed}d`}
        />
        <Requirement
          label={`≥${MIN_RESOLVED} signals`}
          met={total >= MIN_RESOLVED}
          value={`${total}`}
        />
        <Requirement
          label={`≥${MIN_WIN_RATE}% win rate`}
          met={winRate >= MIN_WIN_RATE}
          value={`${winRate}%`}
        />
      </div>

      {readyForReal && (
        <p className="text-green-400 text-xs text-center mt-3 font-semibold">
          All requirements met — proceed with real capital at your discretion
        </p>
      )}
    </div>
  )
}

function Requirement({ label, met, value }) {
  return (
    <div className={clsx('rounded-lg p-2', met ? 'bg-green-950/30' : 'bg-zinc-900/50')}>
      <p
        className={clsx(
          'text-sm font-bold',
          met ? 'text-green-400' : 'text-zinc-400',
        )}
      >
        {met ? '✓' : value}
      </p>
      <p className="text-muted text-[10px] mt-0.5">{label}</p>
    </div>
  )
}
