import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import clsx from 'clsx'

const RULE_SECTIONS = [
  {
    title: 'Entry',
    border: 'border-red-900/40',
    rules: [
      'A clear king node thesis: trade is targeting the call wall, the put wall, or a flip break',
      'Regime supports the direction — Regime A for pins / fades, Regime B for directional / breakouts',
      'EV edge ≥ 0: estimated PoP (from IV) beats the breakeven PoP the structure needs',
      'R/R ≥ 1:1.5 — target 1:2',
      'Never enter at vol extremes (regime flip in progress, IV blow-off)',
      'Confirm flow + GEX agree; mismatch = transition signal, reduce conviction',
    ],
  },
  {
    title: 'Position Sizing',
    border: 'border-yellow-900/40',
    rules: [
      'Max 2% of account per spread (max-loss-per-spread × contracts ≤ 2% of NLV)',
      'Manual override allowed but the calculator warns when you breach',
      'Max 20% of account in any single underlying',
    ],
  },
  {
    title: 'Stop Loss',
    border: 'border-orange-900/40',
    rules: [
      'Spread mark down −50% from entry → exit immediately',
      'Thesis invalidated (wall breaks, regime flips, flow flips against you) → exit same day',
      '50% of DTE consumed with no thesis progress → reassess size or close',
    ],
  },
  {
    title: 'Profit Taking',
    border: 'border-green-900/40',
    rules: [
      '+100% on the spread → sell 50% of position',
      '+200% on the spread → sell 75% (keep 25% running into expiry)',
      'Spot reaches the target king node → consider full exit',
      'Sell into IV expansion, not after the move completes',
    ],
  },
  {
    title: 'DTE Discipline',
    border: 'border-blue-900/40',
    rules: [
      'R/R is the objective; DTE is the parameter you optimize for it',
      'No same-day / 1 DTE entries unless it\'s an explicit Regime A pin (spot inside a tight wall cluster, theta is the edge)',
      'No 60+ DTE without a named catalyst — vega exposure dominates the P/L curve',
      'Pick the expiration that produces the cleanest R/R math, not a fixed bucket',
    ],
  },
  {
    title: 'Strike Selection',
    border: 'border-zinc-700',
    rules: [
      'Anchor strikes to king nodes — call wall, put wall, or zero-gamma flip',
      'Debits: net debit ≤ 40% of spread width (caps R/R at 1:1.5; pay ≤33% for the 1:2 target)',
      'Credits: net credit ≥ 60% of spread width (same R/R floor, math inverted)',
      'Estimated PoP must beat Breakeven PoP — the +EV edge is what makes the trade work',
    ],
  },
  {
    title: 'Regime Awareness',
    border: 'border-purple-900/40',
    rules: [
      'Regime A (spot above flip, positive net GEX) — dealers long gamma, sell rallies + buy dips → pin / vol-suppressed environment. Setups: short premium, pin trades, breakout calls AT the call wall.',
      'Regime B (spot below flip, negative net GEX) — dealers short gamma, buy rallies + sell dips → trend / vol-expansion. Setups: long premium, breakdown puts AT the put wall, vol-expansion plays.',
      'Mixed regime / flow contradicting GEX = transition signal — wait for the new regime to settle, or size half',
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
  const maxTicker = valid ? parsed * 0.2 : null

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
    <div className="px-4 lg:px-6 pt-6 pb-8 space-y-4 mx-auto lg:max-w-3xl w-full">
      <div>
        <h1 className="text-white text-xl lg:text-2xl font-bold tracking-tight mb-1">Rules</h1>
        <p className="text-subtle text-xs">
          The non-negotiables. Encoded in the suggest-plays filter, the
          calculator's premium-of-width caps, and the stop-loss UI.
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
              inputMode="decimal"
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
                  label="Max per spread (2%)"
                  value={`$${(profile.account_size * 0.02).toLocaleString()}`}
                  valueClass="text-red-400"
                />
                <CalcRow
                  label="Max per ticker (20%)"
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
          "Dealer positioning is information; flow is intent. Your edge is
          reading the gamma map better than the tape. R/R + EV beats
          conviction. Discipline + walls = alpha."
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
