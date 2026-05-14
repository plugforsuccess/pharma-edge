// Cash Moves — monitor-positions edge function.
//
// Iterates every public.open_positions row with status='open', fetches
// the current spread mid, computes P&L %, fires alerts when thresholds
// hit (Cash Moves rules: -50% stop, +50/+100/+200 profit ladder, DTE
// < 21, expiring tomorrow). Idempotent on triggers_fired so we never
// double-alert.
//
// Called by the monitor-positions GHA cron every 5 min during US RTH.
//
// Auth model: this is a service-role-only function (cron calls it with
// the service role JWT). Refuses anything else.
//
// Price source order:
//   1. Polygon /v3/snapshot/options REST — primary. Real-time, every
//      US options ticker, unlimited under the Massive plan. Single
//      source of truth that works for every position regardless of
//      strike / expiration / ticker.
//   2. dxlink_quotes — secondary fallback. Real-time stream the
//      dxlink-worker keeps subscribed for a curated universe; used
//      when Polygon hiccups (rate-limit retry, network glitch).

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildOccSymbol, tastytradeFetch, TastytradeError, type TtEnv } from '../_shared/tastytrade.ts'
import { fetchPolygonOptionQuote } from '../_shared/optionPricing.ts'
import { computeThesisVerdict, type VerdictState } from './thesisVerdict.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const APP_URL = Deno.env.get('APP_URL') || 'https://pharma-edge.vercel.app'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Read both legs from dxlink_quotes and return the spread mid. The
// dxlink-worker keeps front-2-expirations × ATM±25% subscribed in real
// time, so for positions that fall inside that window this delivers
// sub-second-fresh mids instead of Yahoo's 15-min delay. Returns null
// when either leg is missing, all rows >30s stale (worker stalled), or
// the net is non-positive (data glitch).
async function fetchDxlinkSpreadMid(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
  expiration: string,
  longStrike: number,
  shortStrike: number,
  optionType: 'C' | 'P',
): Promise<{ mid: number | null; source: string; error?: string }> {
  try {
    const { data, error } = await supabase
      .from('dxlink_quotes')
      .select('strike, mid, updated_at')
      .eq('underlying', ticker)
      .eq('kind', 'option')
      .eq('expiration_date', expiration)
      .eq('option_type', optionType)
      .in('strike', [longStrike, shortStrike])
    if (error) return { mid: null, source: 'dxlink', error: error.message }
    if (!Array.isArray(data) || data.length < 2) {
      return { mid: null, source: 'dxlink', error: 'legs not subscribed' }
    }
    const long = data.find((r) => Math.abs(Number(r.strike) - longStrike) < 0.001)
    const short = data.find((r) => Math.abs(Number(r.strike) - shortStrike) < 0.001)
    if (!long || !short) return { mid: null, source: 'dxlink', error: 'strike match miss' }
    const longMid = Number(long.mid)
    const shortMid = Number(short.mid)
    if (!Number.isFinite(longMid) || !Number.isFinite(shortMid)) {
      return { mid: null, source: 'dxlink', error: 'null mids' }
    }
    const newest = Math.max(
      new Date(long.updated_at).getTime(),
      new Date(short.updated_at).getTime(),
    )
    if (Date.now() - newest > 5 * 60_000) {
      return { mid: null, source: 'dxlink', error: 'both legs stale' }
    }
    const mid = longMid - shortMid
    if (!(mid > 0)) return { mid: null, source: 'dxlink', error: 'non-positive net' }
    return { mid, source: 'dxlink' }
  } catch (e) {
    return { mid: null, source: 'dxlink', error: e instanceof Error ? e.message : 'dxlink threw' }
  }
}

// Polygon REST snapshot for both legs. Real-time, unlimited under our
// plan, covers every US options ticker — picks up everything dxlink
// doesn't stream. Rejects >5min stale quotes (Polygon flags
// last_updated; outside RTH this rapidly goes stale and is correctly
// excluded).
async function fetchPolygonSpreadMid(
  ticker: string,
  expiration: string,
  longStrike: number,
  shortStrike: number,
  optionType: 'C' | 'P',
): Promise<{ mid: number | null; source: string; error?: string }> {
  try {
    const [longQ, shortQ] = await Promise.all([
      fetchPolygonOptionQuote(ticker, expiration, optionType, longStrike),
      fetchPolygonOptionQuote(ticker, expiration, optionType, shortStrike),
    ])
    if (!longQ || !shortQ) {
      return { mid: null, source: 'polygon', error: 'leg quote unavailable' }
    }
    if (longQ.age_seconds > 300 || shortQ.age_seconds > 300) {
      return { mid: null, source: 'polygon', error: `stale quote: long ${longQ.age_seconds}s short ${shortQ.age_seconds}s` }
    }
    const mid = longQ.mid - shortQ.mid
    if (!(mid > 0)) return { mid: null, source: 'polygon', error: 'non-positive net' }
    return { mid, source: 'polygon' }
  } catch (e) {
    return { mid: null, source: 'polygon', error: e instanceof Error ? e.message : 'polygon threw' }
  }
}

interface Position {
  id: string
  user_id: string
  signal_id: string | null
  ticker: string
  strategy_type: string
  long_strike: number
  short_strike: number
  expiration: string
  contracts: number
  entry_debit_per_spread: number
  triggers_fired: Record<string, string>
  thesis: string | null
  last_regime: 'A' | 'B' | 'mixed' | null
  last_verdict: VerdictState | null
  last_verdict_reasons: string[] | null
}

// Regime classification — same A/B/mixed taxonomy used in suggest-plays
// and the /reasoning route. Derived deterministically from spot vs flip
// and net GEX sign so we never need an LLM call to detect a shift.
//
// 'A' = positive gamma + above flip → vol-suppressed
// 'B' = negative gamma + below flip → vol-amplified
// 'mixed' = transition / disagreement
type Regime = 'A' | 'B' | 'mixed'

// Black-Scholes vanna (∂delta/∂σ) — used to compute live net VEX from
// dxlink rows. dxFeed delivers gamma + delta + vega but NOT vanna, so
// we recompute inline. Mirrors compute-gex/greeks.ts bsVanna; keep the
// formula identical or net VEX will diverge between sources.
// q = 0 (no dividend), r = 4.5% (same as compute-gex's RISK_FREE).
const VANNA_R = 0.045
function normPdfV(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}
function bsVanna(spot: number, strike: number, t: number, sigma: number): number {
  if (!(spot > 0 && strike > 0 && t > 0 && sigma > 0)) return 0
  const sqrtT = Math.sqrt(t)
  const d1 = (Math.log(spot / strike) + (VANNA_R + 0.5 * sigma * sigma) * t) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  return -normPdfV(d1) * d2 / sigma
}

// Inline regime + snapshot computation from dxlink_quotes. Mirrors
// compute-gex's dxlink path — sums OI × gamma × spot² across calls
// (positive) and puts (negative) for the strikes near spot, then
// walks the cumulative to find the zero-gamma flip strike. Returns
// null when the data is stale, missing, or insufficient (the caller
// treats null as "skip this position's regime check, try again next
// tick").
//
// Returns the trimmed fields the verdict logic needs (spot, net_gex,
// largest_wall) plus the derived regime label so callers don't have
// to recompute it. We intentionally don't shell out to compute-gex
// over HTTP here — the gateway's verify_jwt rejects service-role
// calls with UNAUTHORIZED_INVALID_JWT_FORMAT, and reusing
// dxlink_quotes directly is cheaper anyway.
export interface LiveSnapshotForVerdict {
  spot: number
  net_gex: number
  // Signed dealer-book net delta. Calls contribute positively (positive
  // delta × OI), puts negatively (negative delta × OI), then scaled by
  // spot. Same convention compute-gex's MatrixOutput uses. Drives the
  // DEX-flip drift check in thesisVerdict.
  net_dex: number
  // Signed dealer-book net vanna exposure: sum of OI × vanna × spot²
  // across calls (positive) and puts (negative). Vanna inferred from
  // BS using the dxFeed-supplied IV per row. Drives the VEX-flip
  // drift check in thesisVerdict.
  net_vex: number
  // Per-strike net GEX for the front expiration. Used to compute the
  // trade-specific `wall_gex_at_short_strike` value passed to the
  // verdict module (each position has its own short strike, so the
  // lookup happens at the call site, not here).
  gex_by_strike: Map<number, number>
  largest_wall: { strike: number; expiration: string; gex_net: number } | null
  regime: Regime
}

// AUDIT #5: deriveSnapshotForTicker is now position-aware. The trade's
// own expiration (passed as `targetExpiration`) is the anchor for
// net_gex, largest_wall, regime, and the per-strike GEX lookup. A
// 30-DTE position no longer compares its entry's 30-DTE snapshot
// against a live front-expiration snapshot — both sides anchored to
// the same expiration.
//
// Returns null when:
//   * dxlink_quotes has no rows for the ticker / no equity row
//   * equity row is older than 30s (existing check)
//   * AUDIT #6: median option `updated_at` for the target expiration
//     is older than 5 minutes (option chains can stop updating after-
//     hours or during quiet periods even when the equity tick is
//     fresh; the median gates that out)
//   * no option rows for the trade's expiration (worker isn't
//     subscribed to it, or it's already expired) — verdict downstream
//     will read not_evaluable, which is the safer default than
//     auto-executing on the wrong expiration's positioning.
async function deriveSnapshotForTicker(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
  targetExpiration: string,
): Promise<LiveSnapshotForVerdict | null> {
  const { data: rows } = await supabase
    .from('dxlink_quotes')
    .select('kind, expiration_date, strike, option_type, gamma, delta, iv, open_interest, mid, bid, ask, updated_at')
    .or(`symbol.eq.${ticker},underlying.eq.${ticker}`)
  if (!rows || rows.length === 0) return null

  const equity = rows.find((r: any) => r.kind === 'equity')
  if (!equity) return null
  const spot = equity.mid ?? equity.bid ?? equity.ask
  if (!spot || spot <= 0) return null
  // 30s freshness gate on the equity row.
  const equityAge = Date.now() - new Date(equity.updated_at).getTime()
  if (equityAge > 30_000) return null

  // AUDIT #5: filter to the trade's expiration only. The verdict for
  // this position is about ITS expiration's positioning, not the
  // front month's.
  const optionRows = (rows as any[]).filter(
    (r) => r.kind === 'option' && r.expiration_date === targetExpiration,
  )
  if (optionRows.length === 0) return null

  // AUDIT #6: median option freshness gate. Equity ticks every few
  // seconds during RTH but option chains can stale out (after-hours,
  // illiquid expirations, dxfeed subscription gap). If the median
  // option `updated_at` is older than 5 minutes, the verdict would
  // be reading positioning that no longer reflects the live book.
  const optionAges = optionRows
    .map((r) => Date.now() - new Date(r.updated_at).getTime())
    .filter((a) => Number.isFinite(a))
    .sort((a, b) => a - b)
  if (optionAges.length === 0) return null
  const medianAge = optionAges[Math.floor(optionAges.length / 2)]
  if (medianAge > 5 * 60 * 1000) return null

  // Aggregate per-strike net GEX + cumulative net DEX from rows at the
  // trade's expiration. Same formulas as compute-gex's dxlink path.
  // calls contribute positively, puts negatively.
  const dN = spot * spot
  const byStrike = new Map<number, number>()
  let netDex = 0
  let netVex = 0
  // Convert YYYY-MM-DD to year fraction for the vanna calc. dxlink
  // doesn't deliver vanna; we compute it inline from IV + spot +
  // strike + DTE. Recomputing per-row is fine — bsVanna is cheap.
  const dteOf = (exp: string): number => {
    const ms = new Date(exp + 'T16:00:00Z').getTime() - Date.now()
    return Math.max(ms / (365 * 86_400_000), 1 / 365)
  }
  for (const r of optionRows) {
    if (r.strike == null) continue
    const oi = r.open_interest ?? 0
    const g = r.gamma ?? 0
    const d = r.delta ?? 0
    const iv = r.iv ?? 0
    if (oi === 0) continue
    if (Number.isFinite(g) && g > 0) {
      const sign = r.option_type === 'C' ? 1 : -1
      byStrike.set(r.strike, (byStrike.get(r.strike) ?? 0) + sign * oi * g * dN)
    }
    // DEX uses the dxFeed-supplied delta directly (already signed for
    // puts). Same recipe as compute-gex's MatrixOutput.
    if (Number.isFinite(d)) {
      netDex += oi * d * spot
    }
    // VEX accumulation: vanna is ∂delta/∂σ (gamma's vol cousin).
    // Calls contribute positively, puts negatively — same dealer-
    // hedging convention as GEX. Skip rows missing IV (dxFeed
    // occasionally ships partial frames).
    if (Number.isFinite(iv) && iv > 0 && r.expiration_date) {
      const t = dteOf(r.expiration_date as string)
      const v = bsVanna(spot, r.strike, t, iv)
      const sign = r.option_type === 'C' ? 1 : -1
      netVex += sign * oi * v * dN
    }
  }
  if (byStrike.size === 0) return null

  // Net GEX: sum across all strikes at the target expiration.
  let netGex = 0
  for (const v of byStrike.values()) netGex += v

  // Zero-gamma flip at the trade's expiration: walk strikes ascending,
  // find where cumulative crosses zero.
  const strikesSorted = Array.from(byStrike.keys()).sort((a, b) => a - b)
  let cumulative = 0
  let flip: number | null = null
  for (const k of strikesSorted) {
    const prev = cumulative
    cumulative += byStrike.get(k)!
    if ((prev <= 0 && cumulative > 0) || (prev >= 0 && cumulative < 0)) {
      flip = k
      break
    }
  }

  // Largest wall in the trade's expiration. Same definition as the
  // entry-side recipe in LogSignal (largest |gex_net| at the target
  // expiration column).
  let largestStrike: number | null = null
  let largestAbs = 0
  let largestNet = 0
  for (const k of strikesSorted) {
    const v = byStrike.get(k)!
    if (Math.abs(v) > largestAbs) {
      largestAbs = Math.abs(v)
      largestStrike = k
      largestNet = v
    }
  }

  // Regime decision — same rules as Reasoning.jsx's deriveRegime(),
  // applied to the trade's expiration.
  const aboveFlip = flip == null || spot >= flip
  const positiveGex = netGex >= 0
  let regime: Regime
  if (aboveFlip && positiveGex) regime = 'A'
  else if (!aboveFlip && !positiveGex) regime = 'B'
  else regime = 'mixed'

  return {
    spot,
    net_gex: netGex,
    net_dex: netDex,
    net_vex: netVex,
    gex_by_strike: byStrike,
    largest_wall: largestStrike != null
      ? { strike: largestStrike, expiration: targetExpiration, gex_net: largestNet }
      : null,
    regime,
  }
}

// Triggers that fire real broker close orders (real money, no
// sandbox gate per the v1 product spec). The +50% trigger is alert-
// only — it's a heads-up for the user, not a Cash Moves rule.
const AUTO_CLOSE_TRIGGERS = new Set([
  'position_stop_loss',
  'position_profit_100',
  'position_profit_200',
])

// Pct of ORIGINAL contracts to close at each trigger. Cumulative
// across triggers — by the time profit_200 fires, profit_100 has
// already closed 50%, so this 25% gets us to 75% closed total.
// Stop loss closes everything still open.
function targetClosePct(triggerType: string): number {
  if (triggerType === 'position_stop_loss') return 1.0      // close everything
  if (triggerType === 'position_profit_100') return 0.5     // close 50% of original
  if (triggerType === 'position_profit_200') return 0.25    // close another 25% (75% total)
  return 0
}

// Map our internal strategy enum to the place-order `structure`
// param. Currently we only auto-close debit verticals — credit
// spreads + iron condors are alert-only because their close-order
// shape needs different leg actions (Buy/Sell to Close the
// originally-sold leg). Add support if real-money credit auto-
// close becomes a need.
function structureFor(strategy: string): 'bull_call_spread' | 'bear_put_spread' | null {
  if (strategy === 'BULL_CALL') return 'bull_call_spread'
  if (strategy === 'BEAR_PUT') return 'bear_put_spread'
  return null
}

function isCallSpread(strategy: string): boolean {
  return strategy === 'BULL_CALL' || strategy === 'BEAR_CALL_CREDIT'
}

function daysUntil(date: string): number {
  const d = new Date(date + 'T00:00:00Z').getTime()
  return Math.ceil((d - Date.now()) / 86_400_000)
}

interface TriggerCheck {
  type: string
  fired: boolean
  message: string
}

function evaluateTriggers(
  pos: Position,
  pnlPct: number | null,
  dte: number,
): TriggerCheck[] {
  const fired = pos.triggers_fired || {}
  const out: TriggerCheck[] = []

  // Profit ladder + stop loss only fire when we have a current P&L
  if (pnlPct != null) {
    if (pnlPct <= -50 && !fired.position_stop_loss) {
      out.push({
        type: 'position_stop_loss',
        fired: true,
        message: `${pos.ticker} ${pos.strategy_type} hit −50% stop loss (${pnlPct.toFixed(0)}%)`,
      })
    }
    if (pnlPct >= 50 && !fired.position_profit_50) {
      out.push({
        type: 'position_profit_50',
        fired: true,
        message: `${pos.ticker} ${pos.strategy_type} at +50% — sell 50% per Cash Moves rules`,
      })
    }
    if (pnlPct >= 100 && !fired.position_profit_100) {
      out.push({
        type: 'position_profit_100',
        fired: true,
        message: `${pos.ticker} ${pos.strategy_type} at +100% — sell 50% to lock in`,
      })
    }
    if (pnlPct >= 200 && !fired.position_profit_200) {
      out.push({
        type: 'position_profit_200',
        fired: true,
        message: `${pos.ticker} ${pos.strategy_type} at +200% — sell 75% per profit ladder`,
      })
    }
  }

  // 21 DTE trigger retired 2026-05-09. Cash Moves no longer treats
  // 21 DTE as a hard floor — R/R + EV edge are the objective
  // function, DTE is a free parameter. The TimePressureCard on
  // PositionDetail covers the actually-actionable window
  // (sessions ≤ 3) with theta-acceleration copy specific to the day
  // count, which makes a 21-DTE catch-all alert redundant.
  if (dte <= 1 && !fired.position_expiring_tomorrow) {
    out.push({
      type: 'position_expiring_tomorrow',
      fired: true,
      message: `${pos.ticker} ${pos.strategy_type} expires ${dte === 0 ? 'today' : 'tomorrow'} — close before expiry`,
    })
  }

  return out
}

// Submit a real broker close order for a fraction of the original
// position. Best-effort — failures here only log; the alert still
// fires so the user can intervene manually.
//
// Idempotency: each trigger type fires once per position (idempotent
// via `triggers_fired`), and we re-derive contracts-to-close from
// order_history rather than a separate counter, so duplicate calls
// would be caught by Tastytrade or by the contracts-remaining check.
//
// Limit-pricing rule:
//   - stop loss: bid the current spread mid down 5% to ensure fill
//     in a falling-mid environment. Yahoo mid is 15-min delayed so
//     a market order is too risky.
//   - profit-take: limit AT mid; we have time, the market is paying.
async function submitAutoClose(
  supabase: ReturnType<typeof createClient>,
  pos: Position,
  triggerType: string,
  currentMid: number,
): Promise<{ submitted: boolean; reason?: string }> {
  if (!AUTO_CLOSE_TRIGGERS.has(triggerType)) return { submitted: false, reason: 'not an auto-close trigger' }
  if (!pos.signal_id) return { submitted: false, reason: 'no signal_id (manual position)' }
  const structure = structureFor(pos.strategy_type)
  if (!structure) return { submitted: false, reason: `unsupported strategy: ${pos.strategy_type}` }

  // Pull broker account from the linked signal. If the signal was
  // never wired to a Tastytrade account (paper trade or older signal),
  // we can't auto-close.
  const { data: signal } = await supabase
    .from('signals')
    .select('id, tastytrade_account_number, status')
    .eq('id', pos.signal_id)
    .maybeSingle()
  if (!signal?.tastytrade_account_number) {
    return { submitted: false, reason: 'signal has no broker account number' }
  }
  if (signal.status !== 'active') {
    return { submitted: false, reason: `signal not active (${signal.status})` }
  }

  // Sum already-auto-closed contracts so we don't over-close.
  const { data: existingCloses } = await supabase
    .from('order_history')
    .select('contracts, status, auto_close_strategy')
    .eq('signal_id', pos.signal_id)
    .eq('order_type', 'close')
    .eq('auto_executed', true)
    .in('status', ['submitted', 'pending', 'filled', 'partial_fill'])
  const alreadyAutoClosed = (existingCloses ?? [])
    .reduce((s, r) => s + (Number(r.contracts) || 0), 0)
  const remaining = pos.contracts - alreadyAutoClosed
  if (remaining <= 0) {
    return { submitted: false, reason: 'no contracts remaining to auto-close' }
  }

  // Compute target contracts to close in THIS trigger.
  let target: number
  if (triggerType === 'position_stop_loss') {
    target = remaining
  } else {
    // profit_100 / profit_200 — fraction of original, rounded down,
    // capped to remaining. Round down so we never close more than the
    // rules call for.
    const pct = targetClosePct(triggerType)
    target = Math.min(remaining, Math.floor(pos.contracts * pct))
  }
  if (target <= 0) {
    return { submitted: false, reason: 'rounded contract count is zero' }
  }

  // Limit price.
  const isProfitTake = triggerType !== 'position_stop_loss'
  const limitPrice = isProfitTake
    ? Math.max(0.01, currentMid)               // at mid, we have time
    : Math.max(0.01, currentMid * 0.95)        // 5% below mid for stop, ensure fill
  const limitRounded = Math.round(limitPrice * 100) / 100

  // Build OCC symbols. Same convention place-order uses.
  const optionType: 'C' | 'P' = isCallSpread(pos.strategy_type) ? 'C' : 'P'
  const longSymbol = buildOccSymbol(pos.ticker, pos.expiration, optionType, pos.long_strike)
  const shortSymbol = buildOccSymbol(pos.ticker, pos.expiration, optionType, pos.short_strike)

  // Closing a debit spread: Sell the long, Buy back the short.
  // Tastytrade convention: positive `price` paired with `price-effect: Credit`
  // (closing a debit spread is net Credit when in profit, but you can
  // also close at break-even / loss; we model it as Credit here since
  // the only auto-close cases hit a meaningful mid > 0).
  const orderPayload = {
    'order-type': 'Limit',
    'time-in-force': 'Day',
    'price': limitRounded.toFixed(2),
    'price-effect': 'Credit',
    'legs': [
      { 'instrument-type': 'Equity Option', 'symbol': longSymbol, 'quantity': target, 'action': 'Sell to Close' },
      { 'instrument-type': 'Equity Option', 'symbol': shortSymbol, 'quantity': target, 'action': 'Buy to Close' },
    ],
  }

  let orderResp: Response
  try {
    // Default to 'live' for legacy auto-close path (catalyst-driven
     // closes). The fill-reconciliation loop below reads env per row.
     const closeEnv: TtEnv = 'live'
     orderResp = await tastytradeFetch(
      supabase,
      `/accounts/${encodeURIComponent(signal.tastytrade_account_number)}/orders`,
      { method: 'POST', body: JSON.stringify(orderPayload) },
      closeEnv,
    )
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    await supabase.from('order_history').insert({
      signal_id: pos.signal_id,
      user_id: pos.user_id,
      account_number: signal.tastytrade_account_number,
      order_type: 'close',
      action: 'sell_to_close',
      structure,
      ticker: pos.ticker,
      buy_strike: pos.long_strike,
      sell_strike: pos.short_strike,
      expiry_date: pos.expiration,
      contracts: target,
      limit_price: limitRounded,
      status: 'rejected',
      auto_executed: true,
      auto_close_strategy: triggerType,
      api_response: { error: reason },
    })
    return { submitted: false, reason }
  }

  const orderData = await orderResp.json().catch(() => ({}))
  if (!orderResp.ok) {
    await supabase.from('order_history').insert({
      signal_id: pos.signal_id,
      user_id: pos.user_id,
      account_number: signal.tastytrade_account_number,
      order_type: 'close',
      action: 'sell_to_close',
      structure,
      ticker: pos.ticker,
      buy_strike: pos.long_strike,
      sell_strike: pos.short_strike,
      expiry_date: pos.expiration,
      contracts: target,
      limit_price: limitRounded,
      status: 'rejected',
      auto_executed: true,
      auto_close_strategy: triggerType,
      api_response: orderData,
    })
    return { submitted: false, reason: `tastytrade ${orderResp.status}` }
  }

  const orderId = orderData?.data?.order?.id ?? null
  const tastyStatus = String(orderData?.data?.order?.status ?? 'submitted').toLowerCase()
  const normalised = ['pending', 'submitted', 'filled', 'cancelled', 'rejected', 'partial_fill']
    .includes(tastyStatus) ? tastyStatus : 'submitted'

  await supabase.from('order_history').insert({
    signal_id: pos.signal_id,
    user_id: pos.user_id,
    tastytrade_order_id: orderId,
    account_number: signal.tastytrade_account_number,
    order_type: 'close',
    action: 'sell_to_close',
    structure,
    ticker: pos.ticker,
    buy_strike: pos.long_strike,
    sell_strike: pos.short_strike,
    expiry_date: pos.expiration,
    contracts: target,
    limit_price: limitRounded,
    status: normalised,
    auto_executed: true,
    auto_close_strategy: triggerType,
    api_response: orderData,
  })

  console.log(
    `[auto-close] ${pos.ticker} ${pos.long_strike}/${pos.short_strike} ` +
    `${triggerType} → ${target} contracts @ $${limitRounded} (order ${orderId ?? '?'})`,
  )
  return { submitted: true }
}

// Poll Tastytrade for the latest status of every recently-submitted
// auto-close order. When a status change includes a fill, fire a
// position_filled push so the user knows their stop-loss / profit-
// take actually hit. Ran once per cron invocation BEFORE the trigger
// pass — so a fill from the previous tick lands an alert before any
// new triggers go off.
async function pollOpenOrders(
  supabase: ReturnType<typeof createClient>,
): Promise<{ checked: number; updated: number; filled: number }> {
  // Look back 24h. Anything older that's still 'submitted' is almost
  // certainly stale (Tastytrade Day orders expire at EOD) — but we
  // still poll once so the row reflects reality.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: orders } = await supabase
    .from('order_history')
    .select('id, signal_id, position_id, order_type, user_id, tastytrade_order_id, account_number, env, status, contracts, ticker, auto_executed, auto_close_strategy, limit_price')
    .gte('submitted_at', since)
    .in('status', ['submitted', 'pending', 'partial_fill'])
    .not('tastytrade_order_id', 'is', null)
    .limit(100)

  let updated = 0
  let filled = 0
  for (const o of orders ?? []) {
    try {
      // Each order_history row carries its open env, so the fill
       // reconciliation hits the correct base URL (cert vs prod).
       const env: TtEnv = (o.env === 'cert' || o.env === 'live') ? o.env : 'live'
       const resp = await tastytradeFetch(
        supabase,
        `/accounts/${encodeURIComponent(o.account_number)}/orders/${encodeURIComponent(o.tastytrade_order_id)}`,
        {},
        env,
      )
      if (!resp.ok) continue
      const body = await resp.json().catch(() => ({}))
      const tastyStatus = String(body?.data?.order?.status ?? '').toLowerCase()
      const normalised = ['pending', 'submitted', 'filled', 'cancelled', 'rejected', 'partial_fill']
        .includes(tastyStatus) ? tastyStatus : null
      if (!normalised || normalised === o.status) continue

      const updates: Record<string, unknown> = { status: normalised, api_response: body }
      if (normalised === 'filled') {
        const filledPrice = Number(body?.data?.order?.['avg-fill-price'] ?? body?.data?.order?.['filled-price'])
        if (Number.isFinite(filledPrice)) updates.filled_price = filledPrice
        updates.filled_at = new Date().toISOString()
      }
      await supabase.from('order_history').update(updates).eq('id', o.id)
      updated++

      // CLOSE-order reconciliation: when a close order transitions
      // to 'filled', decrement the position's contracts_remaining
      // by however many contracts this order represents. The DB
      // trigger open_positions_close_on_zero_remaining auto-flips
      // status='closed' when remaining hits 0, so no extra status
      // update needed here.
      //
      // Idempotent by construction: the surrounding `normalised ===
      // o.status → continue` check above only runs this block on the
      // first poll that sees the transition. Subsequent polls of the
      // same order short-circuit before reaching here.
      //
      // For partial_fill we deliberately do NOTHING — the order
      // hasn't terminated yet. Tastytrade Day orders eventually
      // resolve to filled or cancelled, and the decrement happens
      // on that terminal state. (A user who cancels mid-partial-fill
      // is a phase-2 edge case to wire up via filled-quantity.)
      if (
        o.order_type === 'close' &&
        normalised === 'filled' &&
        o.position_id &&
        Number.isFinite(Number(o.contracts)) &&
        Number(o.contracts) > 0
      ) {
        const { data: posRow, error: posReadErr } = await supabase
          .from('open_positions')
          .select('contracts_remaining')
          .eq('id', o.position_id)
          .maybeSingle()
        if (posReadErr) {
          console.warn('[poll-orders] position read failed:', posReadErr.message)
        } else if (posRow) {
          const next = Math.max(0, Number(posRow.contracts_remaining) - Number(o.contracts))
          const { error: posUpdErr } = await supabase
            .from('open_positions')
            .update({ contracts_remaining: next })
            .eq('id', o.position_id)
          if (posUpdErr) {
            console.warn('[poll-orders] contracts_remaining decrement failed:', posUpdErr.message)
          }
        }
      }

      // Fire fill alert for auto-executed orders that just filled.
      if (normalised === 'filled' && o.auto_executed) {
        filled++
        const alertRow = {
          user_id: o.user_id,
          alert_type: 'position_filled',
          payload: {
            order_id: o.id,
            tastytrade_order_id: o.tastytrade_order_id,
            ticker: o.ticker,
            contracts: o.contracts,
            limit_price: o.limit_price,
            filled_price: updates.filled_price ?? null,
            auto_close_strategy: o.auto_close_strategy,
            message: `Auto-close filled: ${o.contracts} contracts of ${o.ticker} (${o.auto_close_strategy?.replace('position_', '') ?? 'close'})`,
            url: `${APP_URL}/position/${o.signal_id}`,
          },
          sent_at: new Date().toISOString(),
        }
        await supabase.from('alerts').insert(alertRow)
        await fetch(`${SUPABASE_URL}/functions/v1/send-alerts`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user_id: o.user_id,
            alert_type: 'position_filled',
            payload: alertRow.payload,
          }),
        }).catch((e) => console.warn('[poll-orders] send-alerts failed:', e))
      }
    } catch (e) {
      console.warn('[poll-orders] fetch failed:', e instanceof Error ? e.message : e)
    }
  }
  return { checked: orders?.length ?? 0, updated, filled }
}

async function fireAlert(
  supabase: ReturnType<typeof createClient>,
  pos: Position,
  trigger: TriggerCheck,
  pnlPct: number | null,
): Promise<void> {
  // Insert alert row first (idempotent against unique constraint if any)
  const alertRow = {
    user_id: pos.user_id,
    alert_type: trigger.type,
    payload: {
      position_id: pos.id,
      ticker: pos.ticker,
      strategy: pos.strategy_type,
      long_strike: pos.long_strike,
      short_strike: pos.short_strike,
      expiration: pos.expiration,
      contracts: pos.contracts,
      entry_debit: pos.entry_debit_per_spread,
      pnl_pct: pnlPct,
      message: trigger.message,
      url: `${APP_URL}/position/${pos.id}`,
    },
    sent_at: new Date().toISOString(),
  }
  const { error: alertErr } = await supabase.from('alerts').insert(alertRow)
  if (alertErr) {
    console.error('[monitor] alerts insert failed', alertErr)
    // continue anyway — push/email still useful
  }

  // Fan out via send-alerts (which handles email + web push)
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/send-alerts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: pos.user_id,
        alert_type: trigger.type,
        payload: alertRow.payload,
      }),
    })
  } catch (e) {
    console.error('[monitor] send-alerts call failed', e)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'misconfigured' }, 500)
  }

  // Service-role-only: only the cron should call this. We check that
  // the JWT's role claim is service_role.
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const token = authHeader.slice('Bearer '.length)
  let role: string | undefined
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    role = payload?.role
  } catch { /* fall through */ }
  if (role !== 'service_role') return json({ success: false, error: 'service role required' }, 403)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // First pass: poll Tastytrade for status changes on any auto-close
  // orders that are still pending. Doing this before the trigger pass
  // means a fill from the previous tick lands a push alert before
  // we evaluate new triggers — keeps the audit trail tidy.
  const pollResult = await pollOpenOrders(supabase)

  // Pull every open position. At realistic scale (one user, dozens of
  // positions max) this is fine; if it grows we'd page or filter by
  // last_polled_at older than 4 min.
  const { data: rows, error } = await supabase
    .from('open_positions')
    .select(
      'id, user_id, signal_id, ticker, strategy_type, long_strike, short_strike, expiration, contracts, entry_debit_per_spread, triggers_fired, thesis, last_regime, last_verdict, last_verdict_reasons',
    )
    .eq('status', 'open')
  if (error) return json({ success: false, error: error.message }, 500)

  const positions = (rows ?? []) as Position[]
  let pollSucceeded = 0
  let pollFailed = 0
  let triggersFired = 0

  for (const pos of positions) {
    const optionType: 'C' | 'P' = isCallSpread(pos.strategy_type) ? 'C' : 'P'
    const dte = daysUntil(pos.expiration)

    // Auto-expire if DTE < 0 — option has settled, mark closed.
    if (dte < 0) {
      await supabase
        .from('open_positions')
        .update({
          status: 'expired',
          closed_at: new Date().toISOString(),
          last_polled_at: new Date().toISOString(),
        })
        .eq('id', pos.id)
      continue
    }

    // Fetch current spread mid. Polygon first — it's what we pay for,
    // real-time across every US options ticker, no coverage gaps.
    // dxlink_quotes is the secondary fallback for the curated subset
    // the worker streams; it's a single DB read so it's effectively
    // free if Polygon transient-fails. last_poll_source stamps which
    // one served the row so the UI freshness card labels it honestly.
    let { mid, source, error: fetchErr } = await fetchPolygonSpreadMid(
      pos.ticker,
      pos.expiration,
      pos.long_strike,
      pos.short_strike,
      optionType,
    )
    if (mid == null) {
      ;({ mid, source, error: fetchErr } = await fetchDxlinkSpreadMid(
        supabase,
        pos.ticker,
        pos.expiration,
        pos.long_strike,
        pos.short_strike,
        optionType,
      ))
    }

    if (mid == null) {
      pollFailed++
      console.warn(`[monitor] ${pos.ticker} ${pos.long_strike}/${pos.short_strike}: ${fetchErr}`)
      // still touch last_polled_at so we know we tried
      await supabase
        .from('open_positions')
        .update({ last_polled_at: new Date().toISOString(), last_poll_source: source })
        .eq('id', pos.id)
      continue
    }
    pollSucceeded++

    const pnlPct = pos.entry_debit_per_spread > 0
      ? ((mid - pos.entry_debit_per_spread) / pos.entry_debit_per_spread) * 100
      : null

    // Confidence drift / regime-shift detection — derives the current
    // regime deterministically from dxlink_quotes (no LLM cost) and
    // compares to last_regime stored on the position. First observation
    // just baselines (no alert); every subsequent transition fires a
    // position_regime_shift alert. We track it via triggers_fired with
    // a per-shift timestamp so oscillation still alerts each new
    // transition without spamming on every cron tick within one regime.
    let regimeUpdate: { last_regime?: Regime | null } = {}
    let regimeShiftFired = false
    // Audit #5: each position's snapshot is derived at the trade's
    // own expiration, not the front month. Multiple positions on the
    // same ticker but different expirations get separate derivations.
    const liveSnapshot = await deriveSnapshotForTicker(supabase, pos.ticker, pos.expiration)
    const currentRegime = liveSnapshot?.regime ?? null
    if (currentRegime) {
      regimeUpdate.last_regime = currentRegime
      const prior = pos.last_regime
      if (prior && prior !== currentRegime) {
        const shiftAlert = {
          user_id: pos.user_id,
          alert_type: 'position_regime_shift',
          payload: {
            position_id: pos.id,
            ticker: pos.ticker,
            strategy: pos.strategy_type,
            entry_regime: prior,
            current_regime: currentRegime,
            message: `${pos.ticker} regime shifted ${prior} → ${currentRegime} since you opened the trade`,
            url: `${APP_URL}/position/${pos.id}`,
          },
          sent_at: new Date().toISOString(),
        }
        await supabase.from('alerts').insert(shiftAlert).then(({ error }) => {
          if (error) console.warn('[regime-shift] alert insert failed', error)
        })
        await fetch(`${SUPABASE_URL}/functions/v1/send-alerts`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user_id: pos.user_id,
            alert_type: 'position_regime_shift',
            payload: shiftAlert.payload,
          }),
        }).catch((e) => console.warn('[regime-shift] send-alerts failed:', e))
        regimeShiftFired = true
      }
    }

    // ── Dynamic thesis verdict ─────────────────────────────────────
    // Compares the captured entry_gex_snapshot against the live
    // snapshot we just derived. Persists the verdict on
    // open_positions so the client renders it immediately AND the
    // transition detection here drives push notifications.
    //
    // Push fires only on STATE TRANSITIONS (intact ↔ drifting ↔
    // invalidated) — not on every poll. This is what stops the user
    // from getting 50 pings a day if a wall wiggles back and forth.
    let verdictUpdate: { last_verdict?: VerdictState; last_verdict_reasons?: string[]; last_verdict_at?: string } = {}
    if (pos.signal_id) {
      const { data: sigRow } = await supabase
        .from('signals')
        .select('entry_gex_snapshot, target_king_node, target_strike, target_expiration, target_thesis_kind, regime_at_entry')
        .eq('id', pos.signal_id)
        .maybeSingle()
      const entrySnap = sigRow?.entry_gex_snapshot ?? null
      // Per-position wall-at-strike lookup. liveSnapshot.gex_by_strike
      // is built once per ticker by deriveSnapshotForTicker; each
      // position picks its own short_strike out of it. Returns null
      // when the cache doesn't carry the strike (window too narrow).
      const liveWallAtShort =
        liveSnapshot?.gex_by_strike?.get(pos.short_strike) ?? null
      const verdict = computeThesisVerdict(
        entrySnap,
        liveSnapshot
          ? {
              spot: liveSnapshot.spot,
              net_gex: liveSnapshot.net_gex,
              net_dex: liveSnapshot.net_dex,
              net_vex: liveSnapshot.net_vex,
              wall_gex_at_short_strike: liveWallAtShort,
              largest_wall: liveSnapshot.largest_wall,
            }
          : null,
        {
          long_strike: pos.long_strike,
          short_strike: pos.short_strike,
          strategy_type: pos.strategy_type,
          expiration: pos.expiration,
          // Phase 3a structured thesis fields. When the signal carries
          // these, the verdict takes the structured fast-path.
          target_king_node: sigRow?.target_king_node ?? null,
          target_strike: sigRow?.target_strike ?? null,
          target_expiration: sigRow?.target_expiration ?? null,
          target_thesis_kind: sigRow?.target_thesis_kind ?? null,
          regime_at_entry: sigRow?.regime_at_entry ?? null,
        },
      )
      verdictUpdate = {
        last_verdict: verdict.state,
        last_verdict_reasons: verdict.reasons,
        last_verdict_at: new Date().toISOString(),
      }
      // Transition check. Skip when the prior verdict is null (first
      // observation — baseline only) or when the prior was
      // not_evaluable (no real meaning to "exit not_evaluable").
      const prior = pos.last_verdict
      const transitionedToWorse =
        prior &&
        prior !== 'not_evaluable' &&
        prior !== verdict.state &&
        (verdict.state === 'drifting' || verdict.state === 'invalidated')
      const transitionedToBetter =
        prior &&
        (prior === 'drifting' || prior === 'invalidated') &&
        verdict.state === 'intact'
      const alertType = transitionedToBetter
        ? 'position_thesis_recovered'
        : verdict.state === 'invalidated'
          ? 'position_thesis_invalidated'
          : verdict.state === 'drifting'
            ? 'position_thesis_drifting'
            : null
      if ((transitionedToWorse || transitionedToBetter) && alertType) {
        const verdictAlert = {
          user_id: pos.user_id,
          alert_type: alertType,
          payload: {
            position_id: pos.id,
            ticker: pos.ticker,
            strategy: pos.strategy_type,
            previous_verdict: prior,
            current_verdict: verdict.state,
            reasons: verdict.reasons,
            url: `${APP_URL}/position/${pos.id}`,
          },
          sent_at: new Date().toISOString(),
        }
        await supabase.from('alerts').insert(verdictAlert).then(({ error }) => {
          if (error) console.warn('[thesis-verdict] alert insert failed', error)
        })
        await fetch(`${SUPABASE_URL}/functions/v1/send-alerts`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user_id: pos.user_id,
            alert_type: alertType,
            payload: verdictAlert.payload,
          }),
        }).catch((e) => console.warn('[thesis-verdict] send-alerts failed:', e))
      }
    }

    // Evaluate triggers
    const triggers = evaluateTriggers(pos, pnlPct, dte)
    if (triggers.length > 0) {
      const newFired = { ...pos.triggers_fired }
      if (regimeShiftFired) {
        newFired['position_regime_shift'] = new Date().toISOString()
      }
      for (const t of triggers) {
        newFired[t.type] = new Date().toISOString()
        await fireAlert(supabase, pos, t, pnlPct)
        triggersFired++

        // Auto-execute close orders for stop-loss + profit-take rules.
        // Real money, no sandbox gate. The fireAlert call above means
        // the user always gets a push regardless of whether the auto-
        // close attempt succeeds — no silent failures.
        if (AUTO_CLOSE_TRIGGERS.has(t.type)) {
          const ac = await submitAutoClose(supabase, pos, t.type, mid)
          if (!ac.submitted) {
            console.log(
              `[auto-close] ${pos.ticker} ${t.type}: skipped — ${ac.reason}`,
            )
          }
        }
      }
      await supabase
        .from('open_positions')
        .update({
          last_mid_per_spread: mid,
          last_pnl_pct: pnlPct,
          last_polled_at: new Date().toISOString(),
          last_poll_source: source,
          triggers_fired: newFired,
          ...regimeUpdate,
          ...verdictUpdate,
        })
        .eq('id', pos.id)
    } else {
      await supabase
        .from('open_positions')
        .update({
          last_mid_per_spread: mid,
          last_pnl_pct: pnlPct,
          last_polled_at: new Date().toISOString(),
          last_poll_source: source,
          ...regimeUpdate,
          ...verdictUpdate,
        })
        .eq('id', pos.id)
    }
  }

  return json({
    success: true,
    polled: positions.length,
    pollSucceeded,
    pollFailed,
    triggersFired,
    orderPoll: pollResult,
  })
})
