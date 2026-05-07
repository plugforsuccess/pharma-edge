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
        'surface rounded-2xl p-4 mb-5 relative overflow-hidden',
        readyForReal && 'border-green-500/30',
      )}
    >
      {readyForReal && (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(closest-side at 90% 0%, rgba(34,197,94,0.10), transparent 60%)',
          }}
        />
      )}

      <div className="flex items-center justify-between mb-3 relative">
        <div>
          <p className="eyebrow">
            {readyForReal ? '✓ Phase Complete' : 'Paper Trading Period'}
          </p>
          <p className="font-display text-base text-fg mt-1 leading-tight">
            {readyForReal ? 'Ready for real capital' : `Day ${daysElapsed} of ${TARGET_DAYS}`}
          </p>
        </div>
        <div className="text-right">
          <p
            className={clsx(
              'font-display text-3xl leading-none num-tab',
              readyForReal ? 'text-green-400' : 'text-fg',
            )}
          >
            {daysRemaining}
          </p>
          <p className="eyebrow text-[10px] mt-1">
            {daysRemaining > 0 ? 'days left' : 'cleared'}
          </p>
        </div>
      </div>

      <div
        className="h-[3px] rounded-full overflow-hidden mb-4 relative"
        style={{ background: 'rgba(255,255,255,0.05)' }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${progress}%`,
            background: readyForReal
              ? 'linear-gradient(90deg, #00a304, #00c805, #1de851)'
              : 'linear-gradient(90deg, #b88830, #e8b558, #f4cf8e)',
            boxShadow: readyForReal
              ? '0 0 12px rgba(0,200,5,0.5)'
              : '0 0 12px rgba(232,181,88,0.45)',
          }}
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
        <p className="text-green-400 text-[11px] text-center mt-3 font-semibold tracking-wide">
          All gates cleared — proceed at your discretion
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
    <div
      className={clsx(
        'rounded-xl py-2 border transition-colors',
        met
          ? 'border-green-500/30 bg-green-500/5'
          : 'border-border bg-white/[0.015]',
      )}
    >
      <p
        className={clsx(
          'font-display text-base num-tab leading-none',
          met ? 'text-green-400' : 'text-fg',
        )}
      >
        {met ? '✓' : value}
      </p>
      <p className="eyebrow text-[10px] mt-1.5">{label}</p>
    </div>
  )
}
