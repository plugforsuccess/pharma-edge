import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import clsx from 'clsx'

const RULE_SECTIONS = [
  {
    title: 'Entry',
    border: 'border-red-900/40',
    rules: [
      'Minimum 2 confirmed signals before logging',
      'Never enter when stock is at all-time highs',
      'Never enter under 21 DTE',
      '30–45 days before known catalyst',
      '90–120 days for fuzzy timelines',
    ],
  },
  {
    title: 'Position Sizing',
    border: 'border-yellow-900/40',
    rules: [
      'Max 2% of account per options trade',
      'Max 1% of account per Kalshi trade',
      'Max 20% total biotech sector exposure',
    ],
  },
  {
    title: 'Stop Loss',
    border: 'border-orange-900/40',
    rules: [
      'Option down -50% → exit immediately',
      'Thesis invalidated by new data → exit same day',
      '50% of DTE consumed with no movement → reassess',
    ],
  },
  {
    title: 'Profit Taking',
    border: 'border-green-900/40',
    rules: [
      '+100% → sell 50% of position',
      '+200% → sell 75% of position',
      'Day before catalyst → consider full exit',
      'Sell into IV spike, not after announcement',
    ],
  },
  {
    title: 'DTE',
    border: 'border-blue-900/40',
    rules: [
      'Known catalyst: 30–45 days past event date',
      'Fuzzy timeline: 90–120 days',
      'Hard floor: never under 21 days',
      'Buy more time than you think you need',
    ],
  },
  {
    title: 'Strike Calculator',
    border: 'border-zinc-700',
    rules: [
      'Never pay more than 40% of spread width in premium (caps R/R at 1:1.5; ≤33% for 1:2)',
      'Minimum 1:1.5 risk/reward — target 1:2',
      'Always buy expiry 30–45 days PAST the catalyst date',
    ],
  },
]

export default function Rules() {
  const { profile, fetchProfile } = useAuth()
  const [accountSize, setAccountSize] = useState(
    profile?.account_size != null ? String(profile.account_size) : '',
  )
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const parsed = accountSize === '' ? null : Number(accountSize)
  const valid = parsed != null && Number.isFinite(parsed) && parsed >= 0
  const maxOption = valid ? parsed * 0.02 : null
  const maxKalshi = valid ? parsed * 0.01 : null
  const maxSector = valid ? parsed * 0.2 : null

  async function saveAccountSize() {
    if (!valid || !profile?.id) return
    setError('')
    setSaving(true)
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ account_size: parsed })
      .eq('id', profile.id)
    if (updateError) {
      setError(updateError.message)
    } else {
      await fetchProfile(profile.id)
      setEditing(false)
    }
    setSaving(false)
  }

  return (
    <div className="px-4 pt-6 pb-8 space-y-4">
      <div>
        <h1 className="text-white text-xl font-bold tracking-tight mb-1">Rules</h1>
        <p className="text-subtle text-xs">
          The non-negotiables. Encoded in the pre-trade checklist and stop-loss UI.
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl p-4">
        <p className="text-subtle text-xs font-semibold uppercase tracking-wider mb-3">
          Position Size Calculator
        </p>

        {editing ? (
          <div className="space-y-3">
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-subtle">$</span>
              <input
                type="number"
                step="any"
                min="0"
                value={accountSize}
                onChange={(e) => setAccountSize(e.target.value)}
                placeholder="Account size"
                className="w-full bg-bg border border-red-500 text-white pl-8 pr-4 py-3 rounded-xl text-sm focus:outline-none"
              />
            </div>
            {error && (
              <p className="text-red-400 text-xs" role="alert">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                  setError('')
                  setAccountSize(profile?.account_size != null ? String(profile.account_size) : '')
                }}
                className="flex-1 bg-card border border-border text-zinc-400 font-semibold rounded-xl py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveAccountSize}
                disabled={saving || !valid}
                className="flex-1 bg-red-600 hover:bg-red-500 disabled:bg-red-950 disabled:text-red-900 text-white font-semibold rounded-xl py-2 text-sm transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <CalcRow
              label="Account Size"
              value={
                profile?.account_size != null
                  ? `$${Number(profile.account_size).toLocaleString()}`
                  : 'Set →'
              }
              valueClass="text-white"
              onClick={() => setEditing(true)}
            />
            {profile?.account_size != null && (
              <>
                <CalcRow
                  label="Max per options trade (2%)"
                  value={`$${(profile.account_size * 0.02).toLocaleString()}`}
                  valueClass="text-red-400"
                />
                <CalcRow
                  label="Max per Kalshi trade (1%)"
                  value={`$${(profile.account_size * 0.01).toLocaleString()}`}
                  valueClass="text-blue-400"
                />
                <CalcRow
                  label="Max biotech sector (20%)"
                  value={`$${(profile.account_size * 0.2).toLocaleString()}`}
                  valueClass="text-yellow-400"
                />
              </>
            )}
          </div>
        )}
      </div>

      {RULE_SECTIONS.map((section) => (
        <div
          key={section.title}
          className={clsx('bg-card border rounded-xl p-4', section.border)}
        >
          <h3 className="text-white text-sm font-semibold mb-3">{section.title}</h3>
          <div className="space-y-2 text-xs text-zinc-400">
            {section.rules.map((rule, i) => (
              <p key={i}>• {rule}</p>
            ))}
          </div>
        </div>
      ))}

      <div className="bg-card border border-border rounded-xl p-4">
        <p className="text-subtle text-xs text-center leading-relaxed italic">
          "Price reflects expectations, not reality. Your edge is reading the science better than
          the market. Patience + confirmation + discipline = alpha."
        </p>
      </div>
    </div>
  )
}

function CalcRow({ label, value, valueClass, onClick }) {
  const Inner = (
    <div className="flex items-center justify-between">
      <p className="text-subtle text-xs">{label}</p>
      <p className={clsx('text-xs font-bold', valueClass)}>{value}</p>
    </div>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="w-full text-left">
        {Inner}
      </button>
    )
  }
  return Inner
}
