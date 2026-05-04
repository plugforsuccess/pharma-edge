import { useEffect, useState } from 'react'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Paper-trading 90-day clock.
//
// Source of truth is profiles.paper_trading_started_at (DATE), so progress
// survives device switches and reinstalls. On first render we backfill any
// existing per-device localStorage value into the DB once, then unconditionally
// read from profile thereafter. If neither exists, today is set as the start.

const LEGACY_STORAGE_KEY = 'pharmaEdge:paperTradingStartedAt'
const TARGET_DAYS = 90
const MIN_RESOLVED = 10
const MIN_WIN_RATE = 55

export default function PaperTradingStatus({ stats }) {
  const { user, profile, fetchProfile } = useAuth()
  const [daysElapsed, setDaysElapsed] = useState(0)

  useEffect(() => {
    if (!user?.id) return
    void resolveStartDate(user.id, profile, fetchProfile).then((startIso) => {
      if (!startIso) return
      try {
        setDaysElapsed(differenceInCalendarDays(new Date(), parseISO(startIso)))
      } catch {
        setDaysElapsed(0)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, profile?.paper_trading_started_at])

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

async function resolveStartDate(userId, profile, fetchProfile) {
  // Already in DB — no-op.
  if (profile?.paper_trading_started_at) {
    return profile.paper_trading_started_at
  }

  // Pull from legacy localStorage if present, else fall back to today.
  let startIso = null
  try {
    const stored = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (stored) {
      // Stored value historically was an ISO datetime; coerce to a date.
      startIso = stored.length >= 10 ? stored.slice(0, 10) : null
    }
  } catch {
    /* localStorage unavailable */
  }
  if (!startIso) {
    startIso = new Date().toISOString().slice(0, 10)
  }

  const { error } = await supabase
    .from('profiles')
    .update({ paper_trading_started_at: startIso })
    .eq('id', userId)
  if (error) {
    console.warn('paper_trading_started_at backfill failed:', error.message)
    return startIso
  }
  // Drop the legacy key on successful migration so we don't keep doing this.
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  await fetchProfile?.(userId)
  return startIso
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
