// Centralized risk-control evaluator for the autonomous whale-tail
// bot. Pure function: takes a snapshot of current state and returns
// whether a new entry is allowed, with structured halt reasons.
//
// Used in three places:
//   1. Server-side scanner (will inline these checks before placing
//      any autonomous order)
//   2. Settings UI (preview "would the bot trade right now?")
//   3. Admin /admin/bot (shows current risk envelope state)
//
// The math here defines the bot's safety envelope. If you change
// these thresholds, the bot can blow up. Touch with care.

/**
 * @typedef {Object} BotConfig
 * @property {boolean} enabled
 * @property {'paper'|'live'} mode
 * @property {number} max_concurrent_positions
 * @property {number} max_concurrent_exposure_pct
 * @property {number} per_trade_max_loss_pct
 * @property {number} max_trades_per_day
 * @property {number} daily_loss_kill_pct
 * @property {number} weekly_loss_kill_pct
 * @property {number} consecutive_loss_pause_count
 * @property {number} consecutive_loss_pause_minutes
 * @property {string[]} event_block_days
 *
 * @typedef {Object} RiskState
 * @property {BotConfig} config
 * @property {number} nlv            — current account NLV
 * @property {number} todayPnl       — realized + unrealized P&L today
 * @property {number} weekPnl        — realized + unrealized P&L this week
 * @property {number} openPositionsCount
 * @property {number} openExposureDollars
 * @property {number} tradesAttemptedToday
 * @property {Array<{ outcome: 'win'|'loss', closed_at: string }>} recentClosedTrades
 * @property {string|null} botPausedUntil  — ISO timestamp; if past, bot resumes
 * @property {string|null} botPausedReason
 * @property {string|null} todayEventBlock — 'FOMC' | 'CPI' | 'NFP' | 'OPEX' | null
 *
 * @typedef {Object} RiskDecision
 * @property {boolean} allowEntry
 * @property {string|null} blockReason
 * @property {string[]} warnings
 * @property {Object} envelope         — derived caps for UI display
 */

/**
 * @param {RiskState} state
 * @returns {RiskDecision}
 */
export function evaluateRisk(state) {
  const { config, nlv } = state
  const warnings = []

  // Pre-flight: bot enabled at all?
  if (!config.enabled) {
    return decision(false, 'Bot disabled (Settings → enable to activate)', warnings, envelopeFor(state))
  }

  // Kill switch tripped?
  if (state.botPausedUntil) {
    const pausedUntil = new Date(state.botPausedUntil).getTime()
    if (Number.isFinite(pausedUntil) && pausedUntil > Date.now()) {
      return decision(
        false,
        `Halted: ${state.botPausedReason ?? 'paused'} (until ${state.botPausedUntil})`,
        warnings,
        envelopeFor(state),
      )
    }
  }

  // Event block (FOMC / CPI / NFP / OPEX)
  if (state.todayEventBlock && config.event_block_days?.includes(state.todayEventBlock)) {
    return decision(
      false,
      `Event-block day (${state.todayEventBlock}) — bot off per config`,
      warnings,
      envelopeFor(state),
    )
  }

  // Daily loss kill — bot self-halts when today's P&L breaches the cap.
  const dailyLossCap = nlv * (config.daily_loss_kill_pct / 100)
  if (state.todayPnl <= -dailyLossCap) {
    return decision(
      false,
      `Daily loss cap hit: ${formatPct(state.todayPnl / nlv * 100)} of NLV (cap ${config.daily_loss_kill_pct}%)`,
      warnings,
      envelopeFor(state),
    )
  }

  // Weekly loss kill — broader circuit breaker.
  const weeklyLossCap = nlv * (config.weekly_loss_kill_pct / 100)
  if (state.weekPnl <= -weeklyLossCap) {
    return decision(
      false,
      `Weekly loss cap hit: ${formatPct(state.weekPnl / nlv * 100)} of NLV (cap ${config.weekly_loss_kill_pct}%)`,
      warnings,
      envelopeFor(state),
    )
  }

  // Concurrent positions cap
  if (state.openPositionsCount >= config.max_concurrent_positions) {
    return decision(
      false,
      `Max concurrent positions (${config.max_concurrent_positions}) — no slot available`,
      warnings,
      envelopeFor(state),
    )
  }

  // Concurrent exposure cap (in dollars relative to NLV)
  const maxExposureDollars = nlv * (config.max_concurrent_exposure_pct / 100)
  if (state.openExposureDollars >= maxExposureDollars) {
    return decision(
      false,
      `Concurrent exposure cap: ${formatPct(state.openExposureDollars / nlv * 100)} of NLV (cap ${config.max_concurrent_exposure_pct}%)`,
      warnings,
      envelopeFor(state),
    )
  }

  // Daily trade count cap
  if (state.tradesAttemptedToday >= config.max_trades_per_day) {
    return decision(
      false,
      `Daily trade cap (${config.max_trades_per_day}) — done for today`,
      warnings,
      envelopeFor(state),
    )
  }

  // Consecutive losses pause — looks at the most recent N closed
  // trades. If they're all losses AND the most recent one closed
  // within the cooldown window, pause new entries.
  const recent = state.recentClosedTrades.slice(0, config.consecutive_loss_pause_count)
  if (
    recent.length === config.consecutive_loss_pause_count &&
    recent.every((t) => t.outcome === 'loss')
  ) {
    const mostRecent = recent[0].closed_at
    const ageMs = Date.now() - new Date(mostRecent).getTime()
    const cooldownMs = config.consecutive_loss_pause_minutes * 60 * 1000
    if (ageMs < cooldownMs) {
      const minutesLeft = Math.ceil((cooldownMs - ageMs) / 60000)
      return decision(
        false,
        `${config.consecutive_loss_pause_count} consecutive losses — cooldown ${minutesLeft} min left`,
        warnings,
        envelopeFor(state),
      )
    }
  }

  // ── Soft warnings (allow entry but flag) ────────────────────────

  if (state.todayPnl < 0) {
    const lossPct = Math.abs(state.todayPnl / nlv * 100)
    if (lossPct > config.daily_loss_kill_pct * 0.7) {
      warnings.push(`Within ${(config.daily_loss_kill_pct - lossPct).toFixed(1)}% of daily loss cap`)
    }
  }

  if (state.openPositionsCount === config.max_concurrent_positions - 1) {
    warnings.push('One slot left before concurrent cap')
  }

  return decision(true, null, warnings, envelopeFor(state))
}

function decision(allowEntry, blockReason, warnings, envelope) {
  return { allowEntry, blockReason, warnings, envelope }
}

function envelopeFor(state) {
  const { config, nlv } = state
  return {
    nlv,
    perTradeMaxLossDollars: nlv * (config.per_trade_max_loss_pct / 100),
    maxConcurrentExposureDollars: nlv * (config.max_concurrent_exposure_pct / 100),
    dailyLossCapDollars: nlv * (config.daily_loss_kill_pct / 100),
    weeklyLossCapDollars: nlv * (config.weekly_loss_kill_pct / 100),
    openExposureDollars: state.openExposureDollars,
    todayPnl: state.todayPnl,
    weekPnl: state.weekPnl,
    openPositionsCount: state.openPositionsCount,
    tradesAttemptedToday: state.tradesAttemptedToday,
  }
}

function formatPct(n) {
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

/**
 * Convenience: compute contract count for a new entry given the
 * per-trade max-loss cap and the option's ask price.
 * Returns { contracts, skipReason } — skipReason is set when even
 * 1 contract would exceed the cap.
 */
export function sizeContracts(perTradeMaxLossDollars, optionAsk) {
  if (!Number.isFinite(optionAsk) || optionAsk <= 0) {
    return { contracts: 0, skipReason: 'invalid_ask_price' }
  }
  const oneContractCost = optionAsk * 100
  if (oneContractCost > perTradeMaxLossDollars) {
    return { contracts: 0, skipReason: 'option_too_expensive_for_cap' }
  }
  const contracts = Math.floor(perTradeMaxLossDollars / oneContractCost)
  // Hard cap at 10 contracts regardless of math — prevents
  // concentration in a single low-priced lottery ticket.
  return { contracts: Math.min(contracts, 10), skipReason: null }
}
