import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Calculator,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { computeProfitProbabilityBp, formatPopBp } from '../utils/pop'

// Premium cap is 40% of spread width — keeps R/R >= 1:1.5 (the rule).
// Naked options are intentionally absent: the pre-trade checklist requires
// a spread, so the calculator UI shouldn't normalise a rule violation.
const PREMIUM_PCT_CAP = 0.4

// Four vertical-spread structures, two debit and two credit. Iron
// condor is intentionally NOT in the calculator yet — it needs four
// strikes (two short legs + two protective wings) and the calculator
// is built around a two-strike form. Condor support comes when the
// form gets the wing inputs; until then condors live in LogSignal /
// Suggested Plays only.
const STRUCTURE_CONFIG = {
  bull_call_spread: {
    label: 'Bull Call',
    longLabel: 'Bull Call Spread',
    direction: 'long_call',
    accent: 'green',
    isCredit: false,
    optionType: 'C',
    popType: 'BULL_CALL',
    buyLabel: 'Buy Call Strike',
    sellLabel: 'Sell Call Strike',
    buyDefault: (price) => (price * 1.05).toFixed(2), // ~5% OTM
    sellDefault: (price) => (price * 1.25).toFixed(2), // ~25% OTM
    spreadWidth: (buy, sell) => sell - buy,
    breakEven: (buy, _sell, premium) => buy + premium,
    premiumLabel: 'Premium Paid',
    premiumHelp: 'Net debit you pay to open the spread.',
  },
  bear_put_spread: {
    label: 'Bear Put',
    longLabel: 'Bear Put Spread',
    direction: 'long_put',
    accent: 'red',
    isCredit: false,
    optionType: 'P',
    popType: 'BEAR_PUT',
    buyLabel: 'Buy Put Strike',
    sellLabel: 'Sell Put Strike',
    buyDefault: (price) => (price * 0.88).toFixed(2), // ~12% OTM
    sellDefault: (price) => (price * 0.65).toFixed(2), // ~35% OTM
    spreadWidth: (buy, sell) => buy - sell,
    breakEven: (buy, _sell, premium) => buy - premium,
    premiumLabel: 'Premium Paid',
    premiumHelp: 'Net debit you pay to open the spread.',
  },
  bull_put_credit: {
    label: 'Bull Put (cr)',
    longLabel: 'Bull Put Credit Spread',
    direction: 'long_call',
    accent: 'emerald',
    isCredit: true,
    optionType: 'P',
    popType: 'BULL_PUT_CREDIT',
    buyLabel: 'Buy Put Strike (wing)',
    sellLabel: 'Sell Put Strike (short)',
    // Sell ~5% OTM; buy ~10% OTM as the protective wing 5 points further out.
    buyDefault: (price) => (price * 0.90).toFixed(2),
    sellDefault: (price) => (price * 0.95).toFixed(2),
    // Width = short_strike - long_strike (sell side is closer to spot).
    spreadWidth: (buy, sell) => sell - buy,
    // Breakeven on the SHORT strike side: short - credit collected.
    breakEven: (_buy, sell, premium) => sell - premium,
    premiumLabel: 'Premium Collected',
    premiumHelp: 'Net credit you receive when opening (max profit).',
  },
  bear_call_credit: {
    label: 'Bear Call (cr)',
    longLabel: 'Bear Call Credit Spread',
    direction: 'long_put',
    accent: 'rose',
    isCredit: true,
    optionType: 'C',
    popType: 'BEAR_CALL_CREDIT',
    buyLabel: 'Buy Call Strike (wing)',
    sellLabel: 'Sell Call Strike (short)',
    // Sell ~5% OTM call; buy ~10% OTM as the protective wing.
    buyDefault: (price) => (price * 1.10).toFixed(2),
    sellDefault: (price) => (price * 1.05).toFixed(2),
    // Width = long_strike - short_strike (buy side is further OTM).
    spreadWidth: (buy, sell) => buy - sell,
    // Breakeven: short_strike + credit.
    breakEven: (_buy, sell, premium) => sell + premium,
    premiumLabel: 'Premium Collected',
    premiumHelp: 'Net credit you receive when opening (max profit).',
  },
  iron_condor: {
    label: 'Iron Condor',
    longLabel: 'Iron Condor',
    direction: 'watch',
    accent: 'purple',
    isCredit: true,
    isCondor: true,
    popType: 'IRON_CONDOR',
    premiumLabel: 'Premium Collected',
    premiumHelp:
      'Net credit from selling both shorts minus paid for both wings.',
    // Defaults centered ATM ±3% for inner shorts, ±5% for wings —
    // a "5%-wide condor" by spot. The user can edit any strike;
    // these just get the form unstuck so calc has something to chew.
    longPutDefault:    (price) => (price * 0.95).toFixed(2),
    shortPutDefault:   (price) => (price * 0.97).toFixed(2),
    shortCallDefault:  (price) => (price * 1.03).toFixed(2),
    longCallDefault:   (price) => (price * 1.05).toFixed(2),
  },
}

const STRUCTURE_FOR_DIRECTION = {
  long_put: 'bear_put_spread',
  long_call: 'bull_call_spread',
  watch: 'bear_put_spread',
}

// Tailwind doesn't include arbitrary class names so we map accent
// keys to the actual selected/border classes. Adding a new accent
// here means adding rows to this map.
const ACCENT_CLASSES = {
  red: 'border-red-500 bg-red-950/30 text-red-400',
  green: 'border-green-500 bg-green-950/30 text-green-400',
  emerald: 'border-emerald-500 bg-emerald-950/30 text-emerald-400',
  rose: 'border-rose-500 bg-rose-950/30 text-rose-400',
  purple: 'border-purple-500 bg-purple-950/30 text-purple-400',
}

export default function StrikePriceCalculator({
  direction = 'long_put',
  accountSize,
  initialStockPrice,
  initialBuyStrike,
  initialSellStrike,
  initialExpiry,
  catalystDate,
  buyStrikeOtmPct,
  sellStrikeOtmPct,
  // Optional: implied volatility at the strike (decimal, e.g. 0.42 = 42%).
  // Suggested Plays passes this so the calculator can render a Probability
  // of Profit alongside the R/R numbers. When absent we skip POP rather
  // than fabricate a number from a default sigma.
  iv,
  onCalculationComplete,
}) {
  const [structure, setStructure] = useState(
    STRUCTURE_FOR_DIRECTION[direction] || 'bear_put_spread',
  )
  const [stockPrice, setStockPrice] = useState(
    initialStockPrice != null ? String(initialStockPrice) : '',
  )
  const [buyStrike, setBuyStrike] = useState(
    initialBuyStrike != null ? String(initialBuyStrike) : '',
  )
  const [sellStrike, setSellStrike] = useState(
    initialSellStrike != null ? String(initialSellStrike) : '',
  )
  // Iron condor needs 4 strikes — verticals only use buy/sell above.
  // Stored separately so switching back to a vertical doesn't carry
  // condor wing values into the 2-strike form.
  const [longPutStrike, setLongPutStrike] = useState('')
  const [shortPutStrike, setShortPutStrike] = useState('')
  const [shortCallStrike, setShortCallStrike] = useState('')
  const [longCallStrike, setLongCallStrike] = useState('')
  const [premium, setPremium] = useState('')
  const [expiry, setExpiry] = useState(
    initialExpiry ? String(initialExpiry) : '',
  )
  const [result, setResult] = useState(null)
  const [expanded, setExpanded] = useState(true)
  const [showExplainer, setShowExplainer] = useState(false)
  // Live broker NLV sync. Calls get-account on mount; if a connection
  // is healthy and the user hasn't typed into accountSize, the
  // calculator's 2% basis switches to live NLV. nlvSynced=true
  // stamps the source so the parent (LogSignal) sees we're using
  // live data, not the manual profile.account_size value.
  const [liveNlv, setLiveNlv] = useState(null)
  const [liveBp, setLiveBp] = useState(null)
  const [liveAcctNumber, setLiveAcctNumber] = useState(null)
  const [nlvSyncedAt, setNlvSyncedAt] = useState(null)
  const [nlvSyncError, setNlvSyncError] = useState(null)
  const [nlvLoading, setNlvLoading] = useState(false)

  const config = STRUCTURE_CONFIG[structure]
  // Manual accountSize from props is the fallback. If we successfully
  // pulled a live NLV, prefer that — sizing should track the actual
  // account, not a manually-entered number that drifts over time.
  const effectiveAccount = liveNlv != null ? liveNlv : toNumOrNull(accountSize)
  const maxPositionDollars =
    effectiveAccount != null ? effectiveAccount * 0.02 : null

  async function fetchBrokerAccount() {
    setNlvLoading(true)
    setNlvSyncError(null)
    try {
      const { data, error } = await supabase.functions.invoke('get-account')
      if (error) {
        let detail = error.message || 'request failed'
        try {
          const ctx = error.context
          if (ctx && typeof ctx.json === 'function') {
            const body = await ctx.json()
            if (body?.error) detail = body.error
          }
        } catch { /* keep generic */ }
        throw new Error(detail)
      }
      if (!data?.success) throw new Error(data?.error || 'no broker data')
      // Prefer the largest non-paper account. If only paper is
      // available, use that (sandbox testing). NLV is the basis for
      // 2% sizing; BP is shown as a guard rail.
      const accounts = (data.accounts || []).slice()
      accounts.sort((a, b) => Number(b.net_liquidating_value ?? 0) - Number(a.net_liquidating_value ?? 0))
      const primary = accounts.find((a) => !a.is_paper) || accounts[0]
      if (!primary) throw new Error('no broker accounts on file')
      const nlv = Number(primary.net_liquidating_value)
      const bp = Number(primary.buying_power)
      setLiveNlv(Number.isFinite(nlv) ? nlv : null)
      setLiveBp(Number.isFinite(bp) ? bp : null)
      setLiveAcctNumber(primary.account_number || null)
      setNlvSyncedAt(Date.now())
    } catch (e) {
      setNlvSyncError(e.message || 'sync failed')
    } finally {
      setNlvLoading(false)
    }
  }

  // One-shot fetch on mount. Subsequent refreshes are user-triggered
  // via the refresh button on the Account Size field.
  useEffect(() => {
    fetchBrokerAccount()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-populate strikes + suggest expiry when stock price, structure, or
  // catalyst date change. Only writes empty fields so we don't clobber
  // user-typed values. If Claude supplied OTM% suggestions for this trade,
  // use them in place of the structure defaults; otherwise fall back to
  // STRUCTURE_CONFIG.
  useEffect(() => {
    const price = toNumOrNull(stockPrice)
    if (price == null || price <= 0) return
    if (config.isCondor) {
      setLongPutStrike((cur) => cur || config.longPutDefault(price))
      setShortPutStrike((cur) => cur || config.shortPutDefault(price))
      setShortCallStrike((cur) => cur || config.shortCallDefault(price))
      setLongCallStrike((cur) => cur || config.longCallDefault(price))
    } else {
      const buy = computeStrike(price, structure, 'buy', buyStrikeOtmPct, config)
      const sell = computeStrike(price, structure, 'sell', sellStrikeOtmPct, config)
      setBuyStrike((cur) => cur || buy)
      setSellStrike((cur) => cur || sell)
    }
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

  const inputsReady = config.isCondor
    ? toNumOrNull(stockPrice) != null &&
      toNumOrNull(longPutStrike) != null &&
      toNumOrNull(shortPutStrike) != null &&
      toNumOrNull(shortCallStrike) != null &&
      toNumOrNull(longCallStrike) != null &&
      toNumOrNull(premium) != null
    : toNumOrNull(stockPrice) != null &&
      toNumOrNull(buyStrike) != null &&
      toNumOrNull(sellStrike) != null &&
      toNumOrNull(premium) != null

  const liveSpread = config.isCondor
    ? condorMaxWidth(longPutStrike, shortPutStrike, shortCallStrike, longCallStrike)
    : liveSpreadWidth(structure, buyStrike, sellStrike)
  const premiumValid =
    liveSpread != null && toNumOrNull(premium) != null
      ? toNumOrNull(premium) <= liveSpread * PREMIUM_PCT_CAP
      : null

  function calculate() {
    const price = toNumOrNull(stockPrice)
    const prem = toNumOrNull(premium)
    if (price == null || prem == null) return

    // Iron condor: 4 strikes, two breakevens, max-loss is the wider
    // of the two wing widths minus the credit. Profit zone is between
    // the two short strikes, adjusted outward by the credit.
    if (config.isCondor) {
      const longPut = toNumOrNull(longPutStrike)
      const shortPut = toNumOrNull(shortPutStrike)
      const shortCall = toNumOrNull(shortCallStrike)
      const longCall = toNumOrNull(longCallStrike)
      if (longPut == null || shortPut == null || shortCall == null || longCall == null) return
      // Strike ordering check: longPut < shortPut < spot < shortCall < longCall
      if (!(longPut < shortPut && shortPut < shortCall && shortCall < longCall)) return

      const putWidth = shortPut - longPut
      const callWidth = longCall - shortCall
      // Risk on a condor = the wider wing minus the credit. If the
      // user built asymmetric wings, the wider side dominates max loss.
      const maxWingWidth = Math.max(putWidth, callWidth)
      if (maxWingWidth <= 0) return

      const maxGainPerContract = prem * 100
      const maxLossPerContract = (maxWingWidth - prem) * 100
      const lowerBe = shortPut - prem
      const upperBe = shortCall + prem
      const riskReward =
        maxLossPerContract > 0 ? maxGainPerContract / maxLossPerContract : 0
      const contracts =
        maxPositionDollars != null && maxLossPerContract > 0
          ? Math.floor(maxPositionDollars / maxLossPerContract)
          : null

      const dteWarning = computeDteWarning(catalystDate, expiry)
      const dte = expiry
        ? Math.max(1, Math.round(
            (new Date(`${expiry}T00:00:00Z`).getTime() - Date.now()) / 86_400_000,
          ))
        : null
      const popBp =
        iv != null && Number(iv) > 0 && dte != null
          ? computeProfitProbabilityBp({
              spot: price,
              sigma: Number(iv),
              dte,
              structure: 'IRON_CONDOR',
              longStrike: shortPut,           // not used by condor branch
              shortStrike: shortCall,          // not used by condor branch
              inner_call_strike: shortCall,
              inner_put_strike: shortPut,
              net_credit: prem,
            })
          : null
      const totalCostNum =
        contracts != null ? contracts * maxLossPerContract : null
      // For condors, BP comparison against max-loss-per-position makes
      // sense (margin requirement ≈ max loss). Same gate as debit
      // spreads, but using max loss instead of total cost.
      const bpInsufficient =
        liveBp != null && totalCostNum != null && totalCostNum > liveBp

      const calc = {
        structure,
        direction: config.direction,
        // Persisted convention for condors: long_strike = inner short
        // put (lower bound of profit zone), short_strike = inner short
        // call (upper bound). The wings live in the calc result for
        // the place-order builder but aren't on the signals row yet.
        buyStrike: shortPut.toFixed(2),
        sellStrike: shortCall.toFixed(2),
        longPutStrike: longPut.toFixed(2),
        shortPutStrike: shortPut.toFixed(2),
        shortCallStrike: shortCall.toFixed(2),
        longCallStrike: longCall.toFixed(2),
        premium: prem.toFixed(2),
        expiry,
        stockPrice: price.toFixed(2),
        spreadWidth: maxWingWidth.toFixed(2),
        putWidth: putWidth.toFixed(2),
        callWidth: callWidth.toFixed(2),
        maxGainPerContract: maxGainPerContract.toFixed(2),
        maxLossPerContract: maxLossPerContract.toFixed(2),
        // Condors have two breakevens — surface both. Existing UI
        // reads `breakEven`; we set it to the upper to keep that
        // working and add `breakEvenLower` for condor-aware UIs.
        breakEven: upperBe.toFixed(2),
        breakEvenLower: lowerBe.toFixed(2),
        breakEvenUpper: upperBe.toFixed(2),
        riskReward: riskReward.toFixed(2),
        contracts,
        totalCost: totalCostNum != null ? totalCostNum.toFixed(2) : null,
        totalMaxGain:
          contracts != null ? (contracts * maxGainPerContract).toFixed(2) : null,
        premiumValid: prem <= maxWingWidth * PREMIUM_PCT_CAP,
        premiumCap: (maxWingWidth * PREMIUM_PCT_CAP).toFixed(2),
        profitTargets: {
          // Half-credit = 50% profit target (industry-standard condor exit).
          exit50pct: { spreadValue: (prem * 0.5).toFixed(2) },
          exit75pct: { spreadValue: (prem * 0.25).toFixed(2) },
        },
        // Stop-loss on a condor is typically 2x credit collected as
        // the spread's mark-to-market price (not the underlying).
        stopLoss: { triggerValue: (prem * 2).toFixed(2) },
        dteWarning,
        entry_pop_bp: popBp,
        account_size_source: liveNlv != null ? 'broker' : 'manual',
        account_size_used: effectiveAccount,
        live_buying_power: liveBp,
        bp_insufficient: bpInsufficient,
      }
      setResult(calc)
      onCalculationComplete?.(calc)
      return
    }

    const buy = toNumOrNull(buyStrike)
    const sell = toNumOrNull(sellStrike)
    if (buy == null || sell == null) return

    const spreadWidth = config.spreadWidth(buy, sell)
    if (spreadWidth <= 0) return

    // Credit and debit spreads have inverted P/L characteristics:
    //   debit  → max gain = width − debit, max loss = debit
    //   credit → max gain = credit, max loss = width − credit
    const maxGainPerContract = config.isCredit
      ? prem * 100
      : (spreadWidth - prem) * 100
    const maxLossPerContract = config.isCredit
      ? (spreadWidth - prem) * 100
      : prem * 100
    const breakEven = config.breakEven(buy, sell, prem)
    const riskReward =
      maxLossPerContract > 0 ? maxGainPerContract / maxLossPerContract : 0
    const contracts =
      maxPositionDollars != null && maxLossPerContract > 0
        ? Math.floor(maxPositionDollars / maxLossPerContract)
        : null

    const dteWarning = computeDteWarning(catalystDate, expiry)

    // Probability of Profit at Expiration. Only computed when we have
    // an IV from the chain — the calculator never fabricates a default
    // sigma, since a fake POP is worse than no POP for calibration.
    const dte = expiry
      ? Math.max(1, Math.round(
          (new Date(`${expiry}T00:00:00Z`).getTime() - Date.now()) / 86_400_000,
        ))
      : null
    const popBp =
      iv != null && Number(iv) > 0 && dte != null
        ? computeProfitProbabilityBp({
            spot: price,
            sigma: Number(iv),
            dte,
            structure: config.popType,
            longStrike: buy,
            shortStrike: sell,
            net_debit: config.isCredit ? undefined : prem,
            net_credit: config.isCredit ? prem : undefined,
            // Calculator doesn't currently model condors, but pass the
            // fields in case popType is ever switched to IRON_CONDOR.
            inner_call_strike: undefined,
            inner_put_strike: undefined,
          })
        : null

    // Buying-power guard: if the broker reports BP and the proposed
    // total cost exceeds it, surface the gap so the user catches it
    // before clicking Place Order. Only meaningful for debit spreads
    // (cost = total_cost). Credit spreads tie up margin in different
    // ways the BP figure already accounts for; comparing total credit
    // to BP isn't right, so we skip.
    const totalCostNum =
      contracts != null ? contracts * maxLossPerContract : null
    const bpInsufficient =
      !config.isCredit &&
      liveBp != null &&
      totalCostNum != null &&
      totalCostNum > liveBp

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
      // POP gets passed back through onCalculationComplete so LogSignal
      // can stamp it onto the signal at insert time (entry_pop_bp).
      entry_pop_bp: popBp,
      // Sizing-context fields — surfaced so the parent can render the
      // "synced from broker" badge and BP guard rail.
      account_size_source: liveNlv != null ? 'broker' : 'manual',
      account_size_used: effectiveAccount,
      live_buying_power: liveBp,
      bp_insufficient: bpInsufficient,
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
                    // Reset strikes + premium so structure-specific
                    // defaults repopulate from useEffect; otherwise
                    // a put-strike from the previous structure would
                    // still show under "Buy Call Strike", confusing.
                    setBuyStrike('')
                    setSellStrike('')
                    setLongPutStrike('')
                    setShortPutStrike('')
                    setShortCallStrike('')
                    setLongCallStrike('')
                    setPremium('')
                    setResult(null)
                  }}
                  className={clsx(
                    'py-2 px-2 rounded-xl border text-xs font-semibold transition-colors text-center',
                    structure === key
                      ? ACCENT_CLASSES[cfg.accent] ?? 'border-amber-500 bg-amber-950/30 text-amber-400'
                      : 'border-border text-subtle',
                  )}
                  title={cfg.longLabel}
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
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-muted text-[10px] uppercase tracking-wider">
                  Account Size
                </label>
                <button
                  type="button"
                  onClick={fetchBrokerAccount}
                  disabled={nlvLoading}
                  className={clsx(
                    'inline-flex items-center gap-1 text-[9px] uppercase tracking-wider transition',
                    nlvLoading
                      ? 'text-muted cursor-wait'
                      : liveNlv != null
                        ? 'text-green-400 hover:text-green-300'
                        : 'text-subtle hover:text-fg',
                  )}
                  title={
                    liveNlv != null
                      ? `Synced from Tastytrade${liveAcctNumber ? ` · ${liveAcctNumber}` : ''}`
                      : 'Pull live NLV from Tastytrade'
                  }
                >
                  <RefreshCw size={9} className={nlvLoading ? 'animate-spin' : ''} />
                  {liveNlv != null ? 'Live' : 'Sync'}
                </button>
              </div>
              <CalcInput
                label=""
                value={effectiveAccount != null ? String(effectiveAccount) : ''}
                onChange={() => {}}
                prefix="$"
                placeholder="—"
                readOnly
                note={
                  nlvSyncError
                    ? `Sync failed: ${nlvSyncError}`
                    : maxPositionDollars != null
                      ? liveBp != null
                        ? `Max trade: $${maxPositionDollars.toFixed(0)} · BP $${liveBp.toFixed(0)}`
                        : `Max trade: $${maxPositionDollars.toFixed(0)}`
                      : 'Set in Settings or sync broker'
                }
              />
            </div>
          </div>

          {config.isCondor ? (
            <div className="space-y-2">
              <p className="text-muted text-[10px] uppercase tracking-wider">
                Strikes (4 legs)
              </p>
              <div className="grid grid-cols-2 gap-3">
                <CalcInput
                  label="Long Put (wing)"
                  value={longPutStrike}
                  onChange={(v) => {
                    setLongPutStrike(v)
                    setResult(null)
                  }}
                  prefix="$"
                  placeholder="—"
                />
                <CalcInput
                  label="Short Put (inner)"
                  value={shortPutStrike}
                  onChange={(v) => {
                    setShortPutStrike(v)
                    setResult(null)
                  }}
                  prefix="$"
                  placeholder="—"
                  highlight
                />
                <CalcInput
                  label="Short Call (inner)"
                  value={shortCallStrike}
                  onChange={(v) => {
                    setShortCallStrike(v)
                    setResult(null)
                  }}
                  prefix="$"
                  placeholder="—"
                  highlight
                />
                <CalcInput
                  label="Long Call (wing)"
                  value={longCallStrike}
                  onChange={(v) => {
                    setLongCallStrike(v)
                    setResult(null)
                  }}
                  prefix="$"
                  placeholder="—"
                />
              </div>
              <p className="text-muted text-[10px] leading-snug">
                Order: long put &lt; short put &lt; short call &lt; long call.
                Profit zone is between the two short strikes; wings cap
                the loss.
              </p>
            </div>
          ) : (
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
          )}

          <div className="grid grid-cols-2 gap-3">
            <CalcInput
              label={config.premiumLabel}
              value={premium}
              onChange={(v) => {
                setPremium(v)
                setResult(null)
              }}
              prefix="$"
              placeholder="0.50"
              note={config.premiumHelp}
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
    // Sign of the OTM offset depends on whether strikes sit above or
    // below spot for this structure:
    //   * bear_put_spread / bull_put_credit  → put strikes BELOW spot (negative)
    //   * bull_call_spread / bear_call_credit → call strikes ABOVE spot (positive)
    const isCallSide = config.optionType === 'C'
    const direction = isCallSide ? 1 : -1
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

// Live max-wing width for a condor while the user is still typing —
// drives the premium-cap badge and PREMIUM_PCT_CAP gate. Returns null
// until all 4 strikes are populated and ordered correctly.
function condorMaxWidth(longPut, shortPut, shortCall, longCall) {
  const lp = toNumOrNull(longPut)
  const sp = toNumOrNull(shortPut)
  const sc = toNumOrNull(shortCall)
  const lc = toNumOrNull(longCall)
  if (lp == null || sp == null || sc == null || lc == null) return null
  if (!(lp < sp && sp < sc && sc < lc)) return null
  return Math.max(sp - lp, lc - sc)
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
