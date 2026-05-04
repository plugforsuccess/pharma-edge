import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import StrikePriceCalculator from '../components/StrikePriceCalculator'
import clsx from 'clsx'

const TABS = [
  { value: 'long_put', label: 'Put Trade', accent: 'red' },
  { value: 'long_call', label: 'Call Trade', accent: 'green' },
]

export default function OptionCalculator() {
  const { profile } = useAuth()
  const [direction, setDirection] = useState('long_put')

  return (
    <div className="px-4 pt-6 pb-8">
      <h1 className="text-white text-xl font-bold mb-6">Option Calculator</h1>

      <div className="flex gap-2 mb-4">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setDirection(tab.value)}
            className={clsx(
              'flex-1 py-2.5 rounded-xl border text-sm font-semibold transition-colors',
              direction === tab.value
                ? tab.accent === 'red'
                  ? 'border-red-500 bg-red-950/30 text-red-400'
                  : 'border-green-500 bg-green-950/30 text-green-400'
                : 'border-border text-subtle',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <StrikePriceCalculator
        key={direction}
        direction={direction}
        accountSize={profile?.account_size}
      />

      <div className="bg-card border border-border rounded-xl p-4 mt-4">
        <p className="text-muted text-xs text-center leading-relaxed">
          Always verify premiums against your broker's live options chain. This calculator
          uses theoretical defaults — actual bid/ask spreads will vary.
        </p>
      </div>
    </div>
  )
}
