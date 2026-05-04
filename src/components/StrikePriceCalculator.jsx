import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Calculator,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import clsx from 'clsx'

// Premium cap is 40% of spread width — keeps R/R >= 1:1.5 (the rule).
// Naked options are intentionally absent: the pre-trade checklist requires
// a spread, so the calculator UI shouldn't normalise a rule violation.
const PREMIUM_PCT_CAP = 0.4

const STRUCTURE_CONFIG = {
  bear_put_spread: {
    label: 'Bear Put Spread',
    direction: 'long_put',
    accent: 'red',
    buyLabel: 'Buy Put Strike',
    sellLabel: 'Sell Put Strike',
    buyDefault: (price) => (price * 0.88).toFixed(2), // ~12% OTM
    sellDefault: (price) => (price * 0.65).toFixed(2), // ~35% OTM
    spreadWidth: (buy, sell) => buy - sell,
    breakEven: (buy, premium) => buy - premium,
  },
  bull_call_spread: {
    label: 'Bull Call Spread',
    direction: 'long_call',
    accent: 'green',
    buyLabel: 'Buy Call Strike',
    sellLabel: 'Sell Call Strike',
    buyDefault: (price) => (price * 1.05).toFixed(2), // ~5% OTM
    sellDefault: (price) => (price * 1.25).toFixed(2), // ~25% OTM
    spreadWidth: (buy, sell) => sell - buy,
    breakEven: (buy, premium) => buy + premium,
  },
}

const STRUCTURE_FOR_DIRECTION = {
  long_put: 'bear_put_spread',
  long_call: 'bull_call_spread',
  watch: 'bear_put_spread',
}

export default function StrikePriceCalculator({
  direction = 'long_put',
  accountSize,
  initialStockPrice,
  catalystDate,
  buyStrikeOtmPct,
  sellStrikeOtmPct,
  onCalculationComplete,
}) {
  const [structure, setStructure] = useState(
    STRUCTURE_FOR_DIRECTION[direction] || 'bear_put_spread',
  )
  const [stockPrice, setStockPrice] = useState(
    initialStockPrice != null ? String(initialStockPrice) : '',
  )
  const [buyStrike, setBuyStrike] = useState('')
  const [sellStrike, setSellStrike] = useState('')
  const [premium, setPremium] = useState('')
  const [expiry, setExpiry] = useState('')
  const [result, setResult] = useState(null)
  const [expanded, setExpanded] = useState(true)
  const [showExplainer, setShowExplainer] = useState(false)

  const config = STRUCTURE_CONFIG[structure]
  const accountNum = toNumOrNull(accountSize)
  const maxPositionDollars = accountNum != null ? accountNum * 0.02 : null

  // Auto-populate strikes + suggest expiry when stock price, structure, or
  // catalyst date change. Only writes empty fields so we don't clobber
  // user-typed values. If Claude supplied OTM% suggestions for this trade,
  // use them in place of the structure defaults; otherwise fall back to
  // STRUCTURE_CONFIG.
  useEffect(() => {
    const price = toNumOrNull(stockPrice)
    if (price == null || price <= 0) return
    const buy = computeStrike(price, structure, 'buy', buyStrikeOtmPct, config)
    const sell = computeStrike(price, structure, 'sell', sellStrikeOtmPct, config)
    setBuyStrike((cur) => cur || buy)
    setSellStrike((cur) => cur || sell)
    if (catalystDate) {
      const target = new Date(`${catalystDate}T00:00:00Z`)
      target.setUTCDate(target.getUTCDate() + 32)
      const day = target.getUTCDay()
      const daysToFriday = day === 5 ? 0 : day < 5 ? 5 - day : 12 - day
      target.setUTCDate(target.getUTCDate() + daysToFriday)
      const iso = target.toISOString().slice(0, 10)
      setExpiry((cur) => cur || iso)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockPrice, structure, catalystDate, buyStrikeOtmPct, sellStrikeOtmPct])

  const inputsReady =
    toNumOrNull(stockPrice) != null &&
    toNumOrNull(buyStrike) != null &&
    toNumOrNull(sellStrike) != null &&
    toNumOrNull(premium) != null

  const liveSpread = liveSpreadWidth(structure, buyStrike, sellStrike)
  const premiumValid =
    liveSpread != null && toNumOrNull(premium) != null
      ? toNumOrNull(premium) <= liveSpread * PREMIUM_PCT_CAP
      : null

  function calculate() {
    const price = toNumOrNull(stockPrice)
    const buy = toNumOrNull(buyStrike)
    const sell = toNumOrNull(sellStrike)
    const prem = toNumOrNull(premium)
    if (price == null || buy == null || sell == null || prem == null) return

    const spreadWidth = config.spreadWidth(buy, sell)
    if (spreadWidth <= 0) return

    const maxGainPerContract = (spreadWidth - prem) * 100
    const maxLossPerContract = prem * 100
    const breakEven = config.breakEven(buy, prem)
    const riskReward =
      maxLossPerContract > 0 ? maxGainPerContract / maxLossPerContract : 0
    const contracts =
      maxPositionDollars != null && maxLossPerContract > 0
        ? Math.floor(maxPositionDollars / maxLossPerContract)
        : null

    const dteWarning = computeDteWarning(catalystDate, expiry)

    const calc = {
      structure,
      direction: config.direction,
      // Inputs surfaced so PlaceOrderPanel can pass them to the order
      // edge function. Server expects positive numbers; we round to 2
      // decimal places to match standard option strike granularity.
      buyStrike: buy.toFixed(2),
      sellStrike: sell.toFixed(2),
      premium: prem.toFixed(2),
      expiry,
      stockPrice: price.toFixed(2),
      spreadWidth: spreadWidth.toFixed(2),
      maxGainPerContract: maxGainPerContract.toFixed(2),
      maxLossPerContract: maxLossPerContract.toFixed(2),
      breakEven: breakEven.toFixed(2),
      riskReward: riskReward.toFixed(2),
      contracts,
      totalCost:
        contracts != null ? (contracts * maxLossPerContract).toFixed(2) : null,
      totalMaxGain:
        contracts != null ? (contracts * maxGainPerContract).toFixed(2) : null,
      premiumValid: prem <= spreadWidth * PREMIUM_PCT_CAP,
      premiumCap: (spreadWidth * PREMIUM_PCT_CAP).toFixed(2),
      profitTargets: {
        exit100pct: {
          spreadValue: Math.min(prem * 2, spreadWidth).toFixed(2),
        },
        exit200pct: {
          spreadValue: Math.min(prem * 3, spreadWidth).toFixed(2),
        },
      },
      stopLoss: { triggerValue: (prem * 0.5).toFixed(2) },
      dteWarning,
    }
    setResult(calc)
    onCalculationComplete?.(calc)
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden mb-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <Calculator size={14} className="text-red-400" />
          <span className="text-white text-sm font-semibold">Strike Price Calculator</span>
        </div>
        {expanded ? (
          <ChevronUp size={14} className="text-subtle" />
        ) : (
          <ChevronDown size={14} className="text-subtle" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          <div>
            <label className="text-muted text-[10px] uppercase tracking-wider block mb-2">
              Trade Structure
            </label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(STRUCTURE_CONFIG).map(([key, cfg]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setStructure(key)
                    setResult(null)
                  }}
                  className={clsx(
                    'py-2 px-2 rounded-xl border text-xs font-semibold transition-colors text-center',
                    structure === key
                      ? cfg.accent === 'red'
                        ? 'border-red-500 bg-red-950/30 text-red-400'
                        : 'border-green-500 bg-green-950/30 text-green-400'
                      : 'border-border text-subtle',
                  )}
                >
                  {cfg.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <CalcInput
              label="Stock Price"
              value={stockPrice}
              onChange={(v) => {
                setStockPrice(v)
                setResult(null)
              }}
              prefix="$"
              placeholder="4.00"
            />
            <CalcInput
              label="Account Size"
              value={accountNum != null ? String(accountNum) : ''}
              onChange={() => {}}
              prefix="$"
              placeholder="—"
              readOnly
              note={
                maxPositionDollars != null
                  ? `Max trade: $${maxPositionDollars.toFixed(0)}`
                  : 'Set in Settings'
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <CalcInput
              label={config.buyLabel}
              value={buyStrike}
              onChange={(v) => {
                setBuyStrike(v)
                setResult(null)
              }}
              prefix="$"
              placeholder="3.50"
              highlight
            />
            <CalcInput
              label={config.sellLabel}
              value={sellStrike}
              onChange={(v) => {
                setSellStrike(v)
                setResult(null)
              }}
              prefix="$"
              placeholder="2.50"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <CalcInput
              label="Premium Paid"
              value={premium}
              onChange={(v) => {
                setPremium(v)
                setResult(null)
              }}
              prefix="$"
              placeholder="0.50"
              note="Per share (×100 per contract)"
            />
            <CalcInput
              label="Expiry Date"
              value={expiry}
              onChange={(v) => {
                setExpiry(v)
                setResult(null)
              }}
              type="date"
            />
          </div>

          {premiumValid === false && liveSpread != null && (
            <div className="bg-red-950/20 border border-red-900/40 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle size={12} className="text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-red-400 text-[10px] leading-relaxed">
                Premium ${premium} exceeds the 40% spread cap (
                ${(liveSpread * PREMIUM_PCT_CAP).toFixed(2)}). R/R falls below 1:1.5.
                Widen the spread or skip the trade.
              </p>
            </div>
          )}
          {premiumValid === true && (
            <div className="bg-green-950/10 border border-green-900/20 rounded-xl p-2">
              <p className="text-green-600 text-[10px]">
                ✓ Premium within the 40% cap (R/R ≥ 1:1.5)
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={calculate}
            disabled={!inputsReady}
            className="w-full flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500
                       disabled:bg-red-950 disabled:text-red-900
                       text-white text-sm font-semibold rounded-xl py-3 transition-colors"
          >
            <Calculator size={14} />
            Calculate Trade
          </button>

          {result && <ResultPanel result={result} config={config} expiry={expiry} sellStrike={sellStrike} buyStrike={buyStrike} premium={premium} />}

          <button
            type="button"
            onClick={() => setShowExplainer(!showExplainer)}
            className="w-full text-muted text-[10px] hover:text-subtle transition-colors"
          >
            {showExplainer ? '▲ Hide' : '▼ How does this work?'}
          </button>

          {showExplainer && <Explainer />}
        </div>
      )}
    </div>
  )
}

function ResultPanel({ result, config, expiry, sellStrike, buyStrike, premium }) {
  const rr = Number(result.riskReward)
  return (
    <div className="space-y-3 pt-2 border-t border-border">
      <div className="grid grid-cols-2 gap-3">
        <ResultBox
          label="Max Gain / Contract"
          value={`$${result.maxGainPerContract}`}
          color="text-green-400"
          sub="at full profit"
        />
        <ResultBox
          label="Max Loss / Contract"
          value={`$${result.maxLossPerContract}`}
          color="text-red-400"
          sub="if expires worthless"
        />
        <ResultBox
          label="Break-Even"
          value={`$${result.breakEven}`}
          color="text-white"
          sub="stock price needed"
        />
        <ResultBox
          label="Risk / Reward"
          value={`1 : ${rr.toFixed(1)}`}
          color={rr >= 1.5 ? 'text-green-400' : 'text-yellow-400'}
          sub="loss : gain"
        />
      </div>

      {result.contracts != null && (
        <div className="bg-bg border border-border rounded-xl p-4">
          <p className="text-muted text-[10px] uppercase tracking-wider mb-3">
            Your Position (2% rule)
          </p>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-white font-bold text-xl">{result.contracts}</p>
              <p className="text-muted text-[10px]">Contracts</p>
            </div>
            <div>
              <p className="text-red-400 font-bold text-xl">${result.totalCost}</p>
              <p className="text-muted text-[10px]">Total Cost</p>
            </div>
            <div>
              <p className="text-green-400 font-bold text-xl">${result.totalMaxGain}</p>
              <p className="text-muted text-[10px]">Max Gain</p>
            </div>
          </div>
        </div>
      )}

      {result.dteWarning && (
        <div
          className={clsx(
            'rounded-xl p-3 border text-[10px]',
            result.dteWarning.kind === 'warn'
              ? 'bg-yellow-950/20 border-yellow-900/40 text-yellow-400'
              : 'bg-green-950/10 border-green-900/20 text-green-600',
          )}
        >
          {result.dteWarning.text}
        </div>
      )}

      <div className="bg-bg border border-border rounded-xl p-4">
        <p className="text-muted text-[10px] uppercase tracking-wider mb-3">
          Pre-Planned Exit Ladder
        </p>
        <div className="space-y-3">
          <ExitRow
            trigger="+100% on premium"
            value={`Spread worth $${result.profitTargets.exit100pct.spreadValue}`}
            action="Sell 50% of position"
            color="text-green-400"
          />
          <ExitRow
            trigger="+200% on premium"
            value={`Spread worth $${result.profitTargets.exit200pct.spreadValue}`}
            action="Sell 75% of position"
            color="text-green-400"
          />
          <ExitRow
            trigger="Day before catalyst"
            value="Sell into IV spike"
            action="Consider full exit"
            color="text-yellow-400"
          />
          <div className="border-t border-border pt-3">
            <ExitRow
              trigger="-50% on premium"
              value={`Spread worth $${result.stopLoss.triggerValue}`}
              action="EXIT FULL POSITION"
              color="text-red-400"
              isStopLoss
            />
          </div>
        </div>
      </div>

      <div className="bg-bg border border-zinc-800 rounded-xl p-4">
        <p className="text-muted text-[10px] uppercase tracking-wider mb-3">Trade Summary</p>
        <div className="font-mono text-xs space-y-1 text-zinc-400">
          <p>
            Structure: <span className="text-white">{config.label}</span>
          </p>
          <p>
            Buy Strike: <span className="text-white">${buyStrike}</span>
          </p>
          <p>
            Sell Strike: <span className="text-white">${sellStrike}</span>
          </p>
          <p>
            Premium: <span className="text-white">${premium}</span>
          </p>
          <p>
            Expiry: <span className="text-white">{expiry || '—'}</span>
          </p>
          <p>
            Contracts:{' '}
            <span className="text-white">{result.contracts ?? '—'}</span>
          </p>
          <p>
            Break-even: <span className="text-white">${result.breakEven}</span>
          </p>
          <p>
            Stop Loss:{' '}
            <span className="text-red-400">Spread @ ${result.stopLoss.triggerValue}</span>
          </p>
        </div>
      </div>
    </div>
  )
}

function Explainer() {
  return (
    <div className="bg-bg border border-border rounded-xl p-4 space-y-3">
      <ExplainItem
        title="Bear Put Spread"
        body="Buy a put at a higher strike (your profit zone). Sell a put at a lower strike (caps max gain, reduces cost). You profit when the stock falls. Max loss is the premium paid. Max gain is the spread width minus premium."
      />
      <ExplainItem
        title="Strike Selection"
        body="Buy strike: 10–15% below stock for puts. Sell strike: 30–40% below. This gives you a realistic profit zone for a biotech rejection (stocks typically drop 40–70% on a CRL)."
      />
      <ExplainItem
        title="Premium Rule (40%)"
        body="Never pay more than 40% of the spread width in premium. This keeps R/R at minimum 1:1.5; pay ≤33% for the 1:2 target. If the market is pricing it higher, the risk/reward is broken — skip the trade."
      />
      <ExplainItem
        title="DTE Rule"
        body="Always buy expiry 30–45 days PAST the catalyst date. If the PDUFA is March 16, buy April or May expiry — not March. A one-day delay can expire your option worthless."
      />
    </div>
  )
}

function CalcInput({ label, value, onChange, prefix, placeholder, type = 'text', note, readOnly, highlight }) {
  return (
    <div>
      <label className="text-muted text-[10px] uppercase tracking-wider block mb-1">{label}</label>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">
            {prefix}
          </span>
        )}
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          readOnly={readOnly}
          className={clsx(
            'w-full bg-bg border rounded-xl py-2.5 text-sm transition-colors focus:outline-none placeholder-zinc-800',
            prefix ? 'pl-7 pr-3' : 'px-3',
            highlight
              ? 'border-red-900 text-white focus:border-red-500'
              : 'border-border text-white focus:border-red-500',
            readOnly ? 'text-subtle cursor-default' : '',
          )}
        />
      </div>
      {note && <p className="text-muted text-[10px] mt-1">{note}</p>}
    </div>
  )
}

function ResultBox({ label, value, color, sub }) {
  return (
    <div className="bg-bg border border-border rounded-xl p-3 text-center">
      <p className={clsx('font-bold text-lg', color)}>{value}</p>
      <p className="text-subtle text-[10px] uppercase tracking-wider mt-0.5">{label}</p>
      {sub && <p className="text-muted text-[10px]">{sub}</p>}
    </div>
  )
}

function ExitRow({ trigger, value, action, color, isStopLoss }) {
  return (
    <div className={clsx('flex items-start justify-between gap-2', isStopLoss && 'opacity-90')}>
      <div className="flex-1">
        <p className={clsx('text-xs font-semibold', color)}>{trigger}</p>
        {value && <p className="text-muted text-[10px]">{value}</p>}
      </div>
      <p
        className={clsx(
          'text-[10px] font-bold text-right flex-shrink-0',
          isStopLoss ? 'text-red-400' : 'text-zinc-400',
        )}
      >
        {action}
      </p>
    </div>
  )
}

function ExplainItem({ title, body }) {
  return (
    <div>
      <p className="text-zinc-400 text-[10px] font-semibold mb-1">{title}</p>
      <p className="text-muted text-[10px] leading-relaxed">{body}</p>
    </div>
  )
}

function toNumOrNull(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function computeStrike(price, structure, side, suggestedOtmPct, config) {
  const otm = toNumOrNull(suggestedOtmPct)
  if (otm != null && otm > 0) {
    // For puts: buy below stock (lower price), sell further below.
    // For calls: buy above stock (higher price), sell further above.
    const direction = structure === 'bear_put_spread' ? -1 : 1
    return (price * (1 + (direction * otm) / 100)).toFixed(2)
  }
  return side === 'buy' ? config.buyDefault(price) : config.sellDefault(price)
}

function liveSpreadWidth(structure, buy, sell) {
  const b = toNumOrNull(buy)
  const s = toNumOrNull(sell)
  if (b == null || s == null) return null
  const cfg = STRUCTURE_CONFIG[structure]
  const w = cfg.spreadWidth(b, s)
  return w > 0 ? w : null
}

function computeDteWarning(catalystDate, expiryDate) {
  if (!catalystDate || !expiryDate) return null
  const cat = new Date(`${catalystDate}T00:00:00Z`)
  const exp = new Date(`${expiryDate}T00:00:00Z`)
  if (Number.isNaN(cat.getTime()) || Number.isNaN(exp.getTime())) return null
  const daysAfter = Math.floor((exp.getTime() - cat.getTime()) / 86_400_000)
  if (daysAfter < 21) {
    return { kind: 'warn', text: `⚠️ Only ${daysAfter} days past catalyst — buy a longer expiry (rule: 30–45 days past).` }
  }
  return { kind: 'ok', text: `✓ ${daysAfter} days past catalyst` }
}
