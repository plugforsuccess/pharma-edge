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
import CalcGexStrip from './CalcGexStrip'

// Premium-of-width thresholds keeping R/R >= 1:1.5 (the rule):
//
//   Debit spreads:
//     premium PAID ≤ 40% of width → max_loss ≤ 0.4 × width,
//     max_gain ≥ 0.6 × width → R/R ≥ 1.5
//
//   Credit spreads (incl. iron condor):
//     premium COLLECTED ≥ 60% of width → max_gain ≥ 0.6 × width,
//     max_loss ≤ 0.4 × width → R/R ≥ 1.5
//
// The math inverts because for credits the premium IS the max gain
// (not the max loss). Same rule, opposite inequality.
//
// Naked options are intentionally absent: the pre-trade checklist
// requires a spread, so the calculator UI shouldn't normalise a rule
// violation.
const DEBIT_PREMIUM_MAX_PCT = 0.4
const CREDIT_PREMIUM_MIN_PCT = 0.6

// Helper: given a structure config + width + premium, return whether
// the premium passes the rule. Wraps the debit-vs-credit branch so
// callers don't have to reach into config every place they validate.
function premiumWithinRule(config, width, premium) {
  if (!(width > 0) || !(premium > 0)) return null
  if (config.isCredit) return premium >= width * CREDIT_PREMIUM_MIN_PCT
  return premium <= width * DEBIT_PREMIUM_MAX_PCT
}

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
  // Per-share premium prefill — Suggested Plays passes this derived
  // from max_loss_per_spread (debit) or max_profit_per_spread (credit)
  // so the calculator lands on a fully-populated form when the user
  // clicks Log Signal on a suggested play. Without it the user has to
  // re-type the premium that already came from the model.
  initialPremium,
  catalystDate,
  // Optional ticker for live-quote lookups. When set, the calculator
  // can pull bid/ask/mid for each leg from dxlink_quotes and compute
  // the net premium so the user doesn't have to type it. Without a
  // ticker the live-mid affordance is hidden.
  ticker,
  buyStrikeOtmPct,
  sellStrikeOtmPct,
  // Optional: implied volatility at the strike (decimal, e.g. 0.42 = 42%).
  // Suggested Plays passes this so the calculator can render a Probability
  // of Profit alongside the R/R numbers. When absent we skip POP rather
  // than fabricate a number from a default sigma.
  iv,
  // When the calculator is rendered inside a flow that already let
  // the user pick a structure (LogSignal step 1), pass the chosen
  // structure here. The picker is hidden and the calculator is
  // anchored to the chosen value — switching structures has to go
  // back to the upstream picker. Without this prop the calculator
  // shows its own picker and infers from `direction`.
  lockedStructure,
  onCalculationComplete,
}) {
  const [structure, setStructure] = useState(
    lockedStructure || STRUCTURE_FOR_DIRECTION[direction] || 'bear_put_spread',
  )

  // If the upstream picker changes the structure (e.g. user backs to
  // step 1 of LogSignal and switches), keep the calculator in sync
  // and clear strikes/premium so structure-specific defaults rebuild.
  useEffect(() => {
    if (!lockedStructure || lockedStructure === structure) return
    setStructure(lockedStructure)
    setBuyStrike('')
    setSellStrike('')
    setLongPutStrike('')
    setShortPutStrike('')
    setShortCallStrike('')
    setLongCallStrike('')
    setPremium('')
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedStructure])
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
  const [premium, setPremium] = useState(
    initialPremium != null ? String(initialPremium) : '',
  )
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
  // Live-quote prefill state. Holds the per-leg quote payload returned
  // by the last successful fetch so the UI can surface bid/ask + the
  // staleness of the rows. `quoteLoading` gates the button's spinner;
  // `quoteError` holds the most recent failure reason (e.g. "leg not
  // streamed", "row stale", "no rows for ticker").
  const [legQuotes, setLegQuotes] = useState(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState(null)

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

  // Pulls live mid prices for each leg of the configured spread from
  // dxlink_quotes, then computes the net premium and populates the
  // Premium field. Skips when required inputs are missing. Returns
  // early without writing if any leg is unsubscribed/stale so the
  // user knows to type manually instead of trusting a partial fill.
  async function fetchLivePremium() {
    setQuoteLoading(true)
    setQuoteError(null)
    setLegQuotes(null)
    try {
      if (!ticker) throw new Error('No ticker — open the calculator from a signal flow.')
      if (!expiry) throw new Error('Pick an expiry first.')
      const legs = config.isCondor
        ? [
            { side: 'longPut', strike: toNumOrNull(longPutStrike), type: 'P', action: 'BUY' },
            { side: 'shortPut', strike: toNumOrNull(shortPutStrike), type: 'P', action: 'SELL' },
            { side: 'shortCall', strike: toNumOrNull(shortCallStrike), type: 'C', action: 'SELL' },
            { side: 'longCall', strike: toNumOrNull(longCallStrike), type: 'C', action: 'BUY' },
          ]
        : [
            { side: 'long', strike: toNumOrNull(buyStrike), type: config.optionType, action: 'BUY' },
            { side: 'short', strike: toNumOrNull(sellStrike), type: config.optionType, action: 'SELL' },
          ]
      if (legs.some((l) => !(l.strike > 0))) throw new Error('Fill in all strikes first.')

      // One round-trip: pull every option row for this underlying +
      // expiration that matches any of our strikes/types, then fan out
      // locally. Cheaper than N SELECTs and lets us use the upper bound
      // of the strike set as a single IN clause.
      const strikes = legs.map((l) => l.strike)
      const types = Array.from(new Set(legs.map((l) => l.type)))
      const { data, error } = await supabase
        .from('dxlink_quotes')
        .select('symbol, strike, option_type, expiration_date, bid, ask, mid, updated_at')
        .eq('underlying', ticker.toUpperCase())
        .eq('expiration_date', expiry)
        .in('strike', strikes)
        .in('option_type', types)
      if (error) throw new Error(error.message || 'quote query failed')
      const rows = data ?? []
      if (rows.length === 0) {
        throw new Error(
          `No live quotes for ${ticker} ${expiry}. The dxlink-worker may not be streaming this expiry.`,
        )
      }

      const STALE_MS = 60_000
      const now = Date.now()
      const enriched = legs.map((leg) => {
        const match = rows.find(
          (r) =>
            Number(r.strike) === leg.strike &&
            r.option_type === leg.type,
        )
        if (!match) return { ...leg, missing: true }
        const updated = new Date(match.updated_at).getTime()
        const age = now - updated
        const stale = age > STALE_MS
        // Prefer the worker's mid; fall back to (bid+ask)/2 if mid
        // is null but bid/ask are populated. Tastytrade's DXLink
        // sometimes drops Quote.mid frames during low-liquidity
        // intervals.
        let mid = Number(match.mid)
        if (!Number.isFinite(mid) && Number.isFinite(Number(match.bid)) && Number.isFinite(Number(match.ask))) {
          mid = (Number(match.bid) + Number(match.ask)) / 2
        }
        return {
          ...leg,
          symbol: match.symbol,
          bid: Number(match.bid),
          ask: Number(match.ask),
          mid: Number.isFinite(mid) ? mid : null,
          age_ms: age,
          stale,
        }
      })

      const missing = enriched.filter((l) => l.missing)
      if (missing.length > 0) {
        throw new Error(
          `Missing quotes for ${missing.length} leg(s). The strike(s) may not be in the dxlink subscription window.`,
        )
      }
      const stale = enriched.filter((l) => l.stale)
      if (stale.length === enriched.length) {
        throw new Error(
          'All quote rows are stale (> 60s). dxlink-worker may be down — check Markets page status.',
        )
      }

      // Net premium from per-leg mids:
      //   debit  → buy mids − sell mids (we pay)
      //   credit → sell mids − buy mids (we collect)
      //   condor → (sell mids) − (buy mids), always credit
      const buyMids = enriched
        .filter((l) => l.action === 'BUY')
        .reduce((acc, l) => acc + (l.mid ?? 0), 0)
      const sellMids = enriched
        .filter((l) => l.action === 'SELL')
        .reduce((acc, l) => acc + (l.mid ?? 0), 0)
      const net = config.isCondor || config.isCredit ? sellMids - buyMids : buyMids - sellMids
      if (!(net > 0)) {
        throw new Error(
          `Computed net premium is non-positive (${net.toFixed(2)}). Check strike order or wait for fresh quotes.`,
        )
      }

      setLegQuotes(enriched)
      setPremium(net.toFixed(2))
      setResult(null)
    } catch (e) {
      setQuoteError(e.message || 'live-quote pull failed')
    } finally {
      setQuoteLoading(false)
    }
  }

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

  // Auto-fire the calculation once every required field is populated
  // AND the result hasn't been produced yet — so when a user lands
  // on this page from a Suggested Play (full prefill) they see the
  // R/R / position-size / POP output without having to click
  // Calculate manually. Once result exists, edits clear it via the
  // existing onChange→setResult(null) handlers and re-fire here.
  useEffect(() => {
    if (result != null) return
    if (!inputsReady) return
    calculate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    result,
    stockPrice,
    buyStrike,
    sellStrike,
    longPutStrike,
    shortPutStrike,
    shortCallStrike,
    longCallStrike,
    premium,
    expiry,
    structure,
  ])

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
      ? premiumWithinRule(config, liveSpread, toNumOrNull(premium))
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
      const dte = computeDte(expiry)
      const expiryDteWarning = computeExpiryDteWarning(dte)
      const popBp =
        iv != null && Number(iv) > 0 && dte != null
          ? computeProfitProbabilityBp({
              spot: price,
              sigma: Number(iv),
              dte,
              structure: 'IRON_CONDOR',
              innerCallStrike: shortCall,
              innerPutStrike: shortPut,
              netCredit: prem,
            })
          : null
      const breakevenPopBp =
        maxGainPerContract + maxLossPerContract > 0
          ? Math.round(
              (maxLossPerContract / (maxGainPerContract + maxLossPerContract)) * 10000,
            )
          : null
      const evPerContract =
        popBp != null
          ? (popBp / 10000) * maxGainPerContract -
            (1 - popBp / 10000) * maxLossPerContract
          : null
      const evEdgeBp =
        popBp != null && breakevenPopBp != null ? popBp - breakevenPopBp : null
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
        // Condor is credit-style: credit collected ≥ 60% of widest wing.
        premiumValid: prem >= maxWingWidth * CREDIT_PREMIUM_MIN_PCT,
        premiumFloor: (maxWingWidth * CREDIT_PREMIUM_MIN_PCT).toFixed(2),
        profitTargets: {
          // Half-credit = 50% profit target (industry-standard condor exit).
          exit50pct: { spreadValue: (prem * 0.5).toFixed(2) },
          exit75pct: { spreadValue: (prem * 0.25).toFixed(2) },
        },
        // Stop-loss on a condor is typically 2x credit collected as
        // the spread's mark-to-market price (not the underlying).
        stopLoss: { triggerValue: (prem * 2).toFixed(2) },
        dteWarning,
        dte,
        expiryDteWarning,
        entry_pop_bp: popBp,
        breakeven_pop_bp: breakevenPopBp,
        ev_per_contract: evPerContract,
        ev_edge_bp: evEdgeBp,
        premium_per_contract_pct:
          effectiveAccount && effectiveAccount > 0
            ? (maxLossPerContract / effectiveAccount) * 100
            : null,
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
    const dte = expiry ? computeDte(expiry) : null
    const expiryDteWarning = computeExpiryDteWarning(dte)

    // Probability of Profit at Expiration. Only computed when we have
    // an IV from the chain — the calculator never fabricates a default
    // sigma, since a fake POP is worse than no POP for calibration.
    const popBp =
      iv != null && Number(iv) > 0 && dte != null
        ? computeProfitProbabilityBp({
            spot: price,
            sigma: Number(iv),
            dte,
            structure: config.popType,
            longStrike: buy,
            shortStrike: sell,
            netDebit: config.isCredit ? undefined : prem,
            netCredit: config.isCredit ? prem : undefined,
          })
        : null

    // Breakeven PoP — the win-rate the trade needs to be +EV at all.
    //   breakevenPoP = max_loss / (max_loss + max_win)
    // Expected Value (dollars per contract):
    //   EV = PoP × max_win − (1 − PoP) × max_loss
    // PoP comes back in basis points; we divide by 10000 for the
    // probability. EV is null when PoP is null (no IV) — the user
    // shouldn't see a fabricated EV.
    const breakevenPopBp =
      maxGainPerContract + maxLossPerContract > 0
        ? Math.round(
            (maxLossPerContract / (maxGainPerContract + maxLossPerContract)) * 10000,
          )
        : null
    const evPerContract =
      popBp != null
        ? (popBp / 10000) * maxGainPerContract -
          (1 - popBp / 10000) * maxLossPerContract
        : null
    const evEdgeBp =
      popBp != null && breakevenPopBp != null ? popBp - breakevenPopBp : null

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
      // Premium-of-width rule branches by isCredit:
      //   debit  → premium ≤ 40% of width  (cap on cost)
      //   credit → premium ≥ 60% of width  (floor on collected)
      premiumValid: premiumWithinRule(config, spreadWidth, prem),
      // POP gets passed back through onCalculationComplete so LogSignal
      // can stamp it onto the signal at insert time (entry_pop_bp).
      entry_pop_bp: popBp,
      // Sizing-context fields — surfaced so the parent can render the
      // "synced from broker" badge and BP guard rail.
      account_size_source: liveNlv != null ? 'broker' : 'manual',
      account_size_used: effectiveAccount,
      live_buying_power: liveBp,
      bp_insufficient: bpInsufficient,
      // For debits this is a cap (max premium); for credits this is
      // a floor (min credit). UI labels accordingly.
      premiumCap: config.isCredit
        ? (spreadWidth * CREDIT_PREMIUM_MIN_PCT).toFixed(2)
        : (spreadWidth * DEBIT_PREMIUM_MAX_PCT).toFixed(2),
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
      // EV bundle: the +EV calculation is the single most important
      // thing the calculator can tell you. R/R alone is a half-truth —
      // a 1:5 R/R at 10% PoP is −EV, a 1:1 at 60% is +EV.
      dte,
      expiryDteWarning,
      breakeven_pop_bp: breakevenPopBp,
      ev_per_contract: evPerContract,
      ev_edge_bp: evEdgeBp,
      // 2%-rule contract violation — when even 1 contract exceeds 2%
      // of effective account, the rule says skip. UI surfaces a
      // distinct "skip the trade" copy in this case rather than just
      // showing 0 contracts.
      premium_per_contract_pct:
        effectiveAccount && effectiveAccount > 0
          ? (maxLossPerContract / effectiveAccount) * 100
          : null,
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
          {!lockedStructure && (
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
          )}

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
                    'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider transition',
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
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-muted text-[10px] uppercase tracking-wider">
                  {config.premiumLabel}
                </label>
                {ticker && (
                  <button
                    type="button"
                    onClick={fetchLivePremium}
                    disabled={quoteLoading}
                    className={clsx(
                      'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider transition',
                      quoteLoading
                        ? 'text-muted cursor-wait'
                        : legQuotes
                          ? 'text-green-400 hover:text-green-300'
                          : 'text-subtle hover:text-fg',
                    )}
                    title="Pull live mid prices for each leg from dxlink_quotes"
                  >
                    <RefreshCw size={9} className={quoteLoading ? 'animate-spin' : ''} />
                    {legQuotes ? 'Live mid' : 'Live'}
                  </button>
                )}
              </div>
              <CalcInput
                label=""
                value={premium}
                onChange={(v) => {
                  setPremium(v)
                  setResult(null)
                  setLegQuotes(null)
                }}
                prefix="$"
                placeholder="0.50"
                note={
                  quoteError
                    ? quoteError
                    : legQuotes
                      ? legQuotes
                          .map((l) => `${l.action[0]}${l.type}${l.strike}: $${(l.mid ?? 0).toFixed(2)}${l.stale ? ' ⚠' : ''}`)
                          .join('  ')
                      : config.premiumHelp
                }
              />
            </div>
            <CalcInput
              label="Expiry Date"
              value={expiry}
              onChange={(v) => {
                setExpiry(v)
                setResult(null)
                setLegQuotes(null)
              }}
              type="date"
            />
          </div>

          {premiumValid === false && liveSpread != null && (
            <div className="bg-red-950/20 border border-red-900/40 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle size={12} className="text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-red-400 text-[10px] leading-relaxed">
                {config.isCredit ? (
                  <>
                    Credit ${premium} is below the 60% floor (
                    ${(liveSpread * CREDIT_PREMIUM_MIN_PCT).toFixed(2)}).
                    R/R falls below 1:1.5. Move the short strike closer
                    to spot, narrow the wing, or skip the trade.
                  </>
                ) : (
                  <>
                    Premium ${premium} exceeds the 40% spread cap (
                    ${(liveSpread * DEBIT_PREMIUM_MAX_PCT).toFixed(2)}).
                    R/R falls below 1:1.5. Widen the spread or skip the
                    trade.
                  </>
                )}
              </p>
            </div>
          )}
          {premiumValid === true && (
            <div className="bg-green-950/10 border border-green-900/20 rounded-xl p-2">
              <p className="text-green-400 text-[10px]">
                {config.isCredit
                  ? '✓ Credit clears the 60% floor (R/R ≥ 1:1.5)'
                  : '✓ Premium within the 40% cap (R/R ≥ 1:1.5)'}
              </p>
            </div>
          )}

          {ticker && expiry && (
            <CalcGexStrip
              ticker={ticker}
              expiry={expiry}
              shortStrike={
                config.isCondor
                  ? config.isCredit
                    ? shortCallStrike  // worst case for upside breach
                    : shortPutStrike
                  : sellStrike
              }
              longStrike={
                config.isCondor
                  ? config.isCredit
                    ? longCallStrike
                    : longPutStrike
                  : buyStrike
              }
              isCredit={config.isCredit}
              popPct={
                result?.entry_pop_bp != null
                  ? Math.round(Number(result.entry_pop_bp) / 100)
                  : null
              }
            />
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
  const popBp = result.entry_pop_bp
  const bePopBp = result.breakeven_pop_bp
  const evPc = result.ev_per_contract
  const evEdgeBp = result.ev_edge_bp
  const popPct = popBp != null ? Math.round(popBp / 100) : null
  const bePopPct = bePopBp != null ? Math.round(bePopBp / 100) : null
  const evPositive = evPc != null && evPc > 0
  const evNegative = evPc != null && evPc < 0
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

      {/* Probability + EV block — the +EV calculation is the single
          most important thing this calculator can tell you. R/R alone
          is a half-truth: a 1:5 R/R at 10% PoP is −EV; a 1:1 at 60%
          is +EV. We surface PoP, the breakeven PoP the trade needs to
          be neutral, and the dollar EV per contract. */}
      {(popBp != null || bePopBp != null) && (
        <div className="bg-bg border border-border rounded-xl p-4">
          <p className="text-muted text-[10px] uppercase tracking-wider mb-3">
            Probability &amp; expected value
          </p>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p
                className={clsx(
                  'font-bold text-lg',
                  popBp == null
                    ? 'text-muted'
                    : evEdgeBp != null && evEdgeBp >= 0
                      ? 'text-green-400'
                      : 'text-yellow-400',
                )}
              >
                {popPct != null ? `${popPct}%` : '—'}
              </p>
              <p className="text-muted text-[10px]">Estimated PoP</p>
              <p className="text-muted text-[10px] mt-0.5">
                {popPct != null ? 'from IV' : 'no IV available'}
              </p>
            </div>
            <div>
              <p className="text-white font-bold text-lg">
                {bePopPct != null ? `${bePopPct}%` : '—'}
              </p>
              <p className="text-muted text-[10px]">Breakeven PoP</p>
              <p className="text-muted text-[10px] mt-0.5">trade needs</p>
            </div>
            <div>
              <p
                className={clsx(
                  'font-bold text-lg',
                  evPositive ? 'text-green-400' : evNegative ? 'text-red-400' : 'text-muted',
                )}
              >
                {evPc != null ? `${evPc >= 0 ? '+' : '−'}$${Math.abs(evPc).toFixed(0)}` : '—'}
              </p>
              <p className="text-muted text-[10px]">EV / contract</p>
              <p className="text-muted text-[10px] mt-0.5">
                {evPc != null ? (evPositive ? '+EV trade' : '−EV trade') : 'needs PoP'}
              </p>
            </div>
          </div>
          {popBp != null && evEdgeBp != null && (
            <p className="text-[10px] text-muted mt-3 leading-relaxed">
              {evEdgeBp >= 0 ? (
                <>
                  Estimated PoP beats breakeven by{' '}
                  <span className="text-green-400 font-semibold">
                    {(evEdgeBp / 100).toFixed(1)} pts
                  </span>
                  . The market is pricing this trade favourably given the IV.
                </>
              ) : (
                <>
                  Estimated PoP is{' '}
                  <span className="text-red-400 font-semibold">
                    {(Math.abs(evEdgeBp) / 100).toFixed(1)} pts
                  </span>{' '}
                  short of breakeven. R/R looks attractive but the IV says this
                  trade loses money on average — skip or restructure.
                </>
              )}
            </p>
          )}
        </div>
      )}

      <SizingPanel result={result} />

      {result.expiryDteWarning && (
        <div
          className={clsx(
            'rounded-xl p-3 border flex items-start gap-2 text-[10px] leading-relaxed',
            result.expiryDteWarning.kind === 'block'
              ? 'bg-red-950/20 border-red-900/40 text-red-400'
              : 'bg-yellow-950/20 border-yellow-900/40 text-yellow-400',
          )}
        >
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          <span>{result.expiryDteWarning.text}</span>
        </div>
      )}

      {result.dteWarning && (
        <div
          className={clsx(
            'rounded-xl p-3 border text-[10px]',
            result.dteWarning.kind === 'warn'
              ? 'bg-yellow-950/20 border-yellow-900/40 text-yellow-400'
              : 'bg-green-950/10 border-green-900/20 text-green-400',
          )}
        >
          {result.dteWarning.text}
        </div>
      )}

      {/* Pre-Planned Exit Ladder removed: spreads have a capped max
          profit/loss by construction, so the laddered "+100% sell
          half / +200% sell three-quarters / -50% stop" framework
          (built for naked-option position management) doesn't add
          guidance over what max-gain/max-loss already say. The
          stop-loss trigger value still surfaces inline in the Trade
          Summary as a single line, which is the only piece that
          actually matters for spreads. */}

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
            {result.dte != null && (
              <span
                className={clsx(
                  'ml-2',
                  result.dte < 21 ? 'text-yellow-400' : 'text-muted',
                )}
              >
                {result.dte} DTE
              </span>
            )}
          </p>
          <p>
            Contracts:{' '}
            <span className="text-white">{result.contracts ?? '—'}</span>
          </p>
          <p>
            Break-even: <span className="text-white">${result.breakEven}</span>
          </p>
          {result.entry_pop_bp != null && (
            <p>
              Entry POP:{' '}
              <span className="text-amber-400">
                {Math.round(Number(result.entry_pop_bp) / 100)}%
              </span>
              <span className="text-muted"> · hash-locked</span>
            </p>
          )}
          <p>
            Stop Loss:{' '}
            <span className="text-red-400">Spread @ ${result.stopLoss.triggerValue}</span>
          </p>
        </div>
      </div>
    </div>
  )
}

// Sizing panel — replaces the old 3-cell box. Splits behaviour by
// whether the 2% rule lets the user size at all:
//   - violatesRule: per-contract risk > 2% of account → show plain
//     "Skip this trade" copy (no contracts can be entered safely)
//   - contracts === 0: 2% allows nothing without violating, same UX
//   - contracts >= 1: standard breakdown, with a "X% of account" tag
//     so the user always sees how much sizing they're consuming
function SizingPanel({ result }) {
  const acct = result.account_size_used
  const pct = result.premium_per_contract_pct
  const violatesRule = pct != null && pct > 2
  if (acct == null) {
    return (
      <div className="bg-bg border border-border rounded-xl p-4">
        <p className="text-muted text-[10px] uppercase tracking-wider mb-1.5">
          Position sizing
        </p>
        <p className="text-subtle text-xs">
          Set Account Size or sync the broker for 2%-rule contract recommendations.
        </p>
      </div>
    )
  }
  if (violatesRule) {
    return (
      <div className="bg-red-950/20 border border-red-900/40 rounded-xl p-4">
        <p className="text-red-400 text-[10px] uppercase tracking-wider font-bold mb-1.5">
          Skip this trade
        </p>
        <p className="text-red-400 text-xs leading-relaxed">
          One contract risks ${Number(result.maxLossPerContract).toFixed(0)} —{' '}
          <span className="font-semibold">{pct.toFixed(1)}% of your ${Math.round(acct)} account</span>.
          The 2% rule mathematically forbids any size at this strike/premium.
          Widen the spread or wait for a smaller candidate.
        </p>
      </div>
    )
  }
  if (result.contracts === 0 || result.contracts == null) {
    return (
      <div className="bg-yellow-950/20 border border-yellow-900/40 rounded-xl p-4">
        <p className="text-yellow-400 text-[10px] uppercase tracking-wider font-bold mb-1.5">
          0 contracts at 2% rule
        </p>
        <p className="text-yellow-400 text-xs leading-relaxed">
          Account too small for this trade as configured. Reduce premium, widen
          the spread, or pick a cheaper underlying.
        </p>
      </div>
    )
  }
  return (
    <div className="bg-bg border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-muted text-[10px] uppercase tracking-wider">
          Your position (2% rule)
        </p>
        {pct != null && (
          <span className="text-[10px] text-subtle">
            {(pct * result.contracts).toFixed(1)}% of account
          </span>
        )}
      </div>
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
// drives the premium-cap / premium-floor badge and the R/R gate. Returns null
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
    return { kind: 'warn', text: `Only ${daysAfter} days past catalyst — buy a longer expiry (rule: 30–45 days past).` }
  }
  return { kind: 'ok', text: `${daysAfter} days past catalyst` }
}

// DTE = today → expiry, in calendar days. Floors at 1 to keep PoP math
// (which divides by sqrt(t)) finite when the user picks an expiry today
// or in the past.
function computeDte(expiryDate) {
  if (!expiryDate) return null
  const exp = new Date(`${expiryDate}T00:00:00Z`).getTime()
  if (Number.isNaN(exp)) return null
  return Math.max(1, Math.round((exp - Date.now()) / 86_400_000))
}

// "Never enter under 21 DTE" — the rule is about absolute DTE on entry,
// independent of catalyst date. Returns null if DTE is unknown or
// already comfortable (≥ 21).
function computeExpiryDteWarning(dte) {
  if (dte == null) return null
  if (dte < 7) {
    return { kind: 'block', text: `${dte} DTE — far below the 21 DTE rule. Gamma/theta will eat this trade in days.` }
  }
  if (dte < 21) {
    return { kind: 'warn', text: `${dte} DTE violates the 21 DTE rule. Roll out to a later expiry.` }
  }
  return null
}
