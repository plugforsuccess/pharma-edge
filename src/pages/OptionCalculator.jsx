import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import StrikePriceCalculator from '../components/StrikePriceCalculator'
import clsx from 'clsx'

const TABS = [
  { value: 'long_put', label: 'Put Trade', accent: 'red' },
  { value: 'long_call', label: 'Call Trade', accent: 'green' },
]

export default function OptionCalculator() {
  const { profile } = useAuth()
  // Suggested Plays / SignalDetail deep-link here with strikes + expiry
  // already chosen — surface them so the user lands on a pre-filled
  // calculator instead of an empty form.
  const location = useLocation()
  const prefill = location.state?.prefill || {}

  const initialDirection =
    prefill.direction === 'long_call' || prefill.direction === 'long_put'
      ? prefill.direction
      : 'long_put'
  const [direction, setDirection] = useState(initialDirection)

  return (
    <div className="px-4 lg:px-6 pt-6 pb-8 mx-auto lg:max-w-2xl w-full">
      <h1 className="text-white text-xl lg:text-2xl font-bold mb-6">
        Option Calculator
        {prefill.ticker && (
          <span className="ml-2 text-base font-mono-tab text-amber-400">
            {prefill.ticker}
          </span>
        )}
      </h1>

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
        initialStockPrice={
          direction === initialDirection ? prefill.stock_price : undefined
        }
        initialBuyStrike={
          direction === initialDirection ? prefill.long_strike : undefined
        }
        initialSellStrike={
          direction === initialDirection ? prefill.short_strike : undefined
        }
        initialExpiry={
          direction === initialDirection ? prefill.expiration_date : undefined
        }
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
