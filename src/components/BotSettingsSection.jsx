import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, ShieldAlert, Sparkles, Activity, RotateCcw } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { evaluateRisk } from '../utils/botRiskEval'

// Settings panel for the autonomous whale-tail bot.
//
// Owns its own save flow (separate from the main Settings save button)
// because some bot config changes — flipping mode paper → live, raising
// per-trade caps — warrant explicit confirmation. We don't want them
// hiding inside a "Save Settings" button at the bottom of the page.
//
// Three subsections:
//   1. Bot status card (mode toggle, halt-state, kill-switch reset)
//   2. Risk caps (per-trade %, daily/weekly loss caps, concurrent caps)
//   3. Entry filters (premium threshold, OTM range, DTE range, etc.)
//   4. Broker accounts (sandbox + live account numbers)
//
// Every field saves to profiles.bot_config jsonb. Edits are local
// until "Save bot config" is tapped. Live-mode flip requires a typed
// confirmation phrase to prevent accidental activation.

const EVENT_BLOCK_OPTIONS = ['FOMC', 'CPI', 'NFP', 'OPEX']
const LIVE_CONFIRM = 'GO LIVE'

const DEFAULT_STRATEGIES = {
  whale_tail: {
    enabled: true,
    capital_allocation_pct: 50,
    kill_switch: false,
  },
  iv_meanrev: {
    enabled: false,
    capital_allocation_pct: 20,
    kill_switch: false,
    min_iv_percentile: 80,
    target_dte: 30,
    wing_width_pct: 5,
    body_width_pct: 2,
  },
  earnings_crush: {
    enabled: false,
    capital_allocation_pct: 15,
    kill_switch: false,
    min_iv_percentile: 70,
    bmo_only: true,
    skip_if_consensus_eps_estimates_lt: 3,
  },
  opex_pin: {
    enabled: false,
    capital_allocation_pct: 15,
    kill_switch: false,
    regime_a_only: true,
    min_gex_wall_distance_pct: 2,
    max_dte: 5,
  },
}

const DEFAULT_CONFIG = {
  enabled: false,
  mode: 'paper',
  dry_run: false,
  max_concurrent_positions: 3,
  max_concurrent_exposure_pct: 30,
  per_trade_max_loss_pct: 4,
  max_trades_per_day: 5,
  daily_loss_kill_pct: 20,
  weekly_loss_kill_pct: 35,
  consecutive_loss_pause_count: 3,
  consecutive_loss_pause_minutes: 30,
  min_premium_dollars: 500000,
  min_otm_pct: 5,
  max_otm_pct: 30,
  min_dte: 7,
  max_dte: 60,
  min_vol_oi_ratio: 2,
  max_bid_ask_pct: 10,
  entry_window_start: '10:30',
  entry_window_end: '15:30',
  max_iv_rank: 60,
  max_weekly_stock_move_pct: 30,
  min_stock_daily_volume_dollars: 50000000,
  event_block_days: [...EVENT_BLOCK_OPTIONS],
  earnings_skip_window_days: 7,
  sandbox_account_number: null,
  live_account_number: null,
  strategies: DEFAULT_STRATEGIES,
}

const STRATEGY_META = [
  { key: 'whale_tail',     label: 'Whale-tail',      desc: 'Tail UW prints ≥$500K on Polygon options-flow feed.' },
  { key: 'iv_meanrev',     label: 'IV mean-reversion', desc: 'Short iron condors when 30d IV > 80th %ile in Regime A.' },
  { key: 'earnings_crush', label: 'Earnings IV crush', desc: 'Short ICs into BMO earnings; close at the open next morning.' },
  { key: 'opex_pin',       label: 'OPEX pin',         desc: 'Short iron butterflies on Regime A names at monthly/quarterly OPEX.' },
]

export default function BotSettingsSection({ profile, onProfileChange }) {
  const initial = useMemo(
    () => ({ ...DEFAULT_CONFIG, ...(profile?.bot_config ?? {}) }),
    [profile?.bot_config],
  )
  const [config, setConfig] = useState(initial)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState(null)
  const [liveConfirmText, setLiveConfirmText] = useState('')
  const [resettingKill, setResettingKill] = useState(false)
  const [confirmingLive, setConfirmingLive] = useState(false)

  useEffect(() => { setConfig(initial); setDirty(false) }, [initial])

  const pausedUntil = profile?.bot_paused_until
  const pausedReason = profile?.bot_paused_reason
  const isHalted = pausedUntil && new Date(pausedUntil).getTime() > Date.now()

  // Live broker NLV — same pattern as AccountContextCard on
  // PositionDetail. Calls get-account on mount; falls back to
  // profile.account_size when broker is unreachable OR when the
  // configured endpoint is sandbox (which returns a fake $100K NLV).
  // Live NLV refreshes on profile re-fetch by the parent component
  // (we don't poll continuously — it's a settings page, not live data).
  const [liveNlv, setLiveNlv] = useState(null)
  const [liveNlvSource, setLiveNlvSource] = useState('loading')
  // Pick the account that matches the currently-active bot mode. If the
  // mode is 'paper', the sandbox/paper account_number is the source of
  // truth for the risk envelope (because that's where orders will fire).
  // Falls back to the largest non-paper account if the configured number
  // isn't found, so the display is never blank during initial setup.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, error: err } = await supabase.functions.invoke('get-account')
        if (cancelled) return
        if (err || !data?.success) {
          setLiveNlvSource('broker_unreachable')
          return
        }
        const accounts = (data.accounts ?? []).slice()
        accounts.sort(
          (a, b) =>
            Number(b.net_liquidating_value ?? 0) - Number(a.net_liquidating_value ?? 0),
        )
        const targetNumber = config.mode === 'live'
          ? config.live_account_number
          : config.sandbox_account_number
        const matched = targetNumber
          ? accounts.find((a) => String(a.account_number) === String(targetNumber))
          : null
        const primary = matched || accounts.find((a) => !a.is_paper) || accounts[0]
        const isCertSandbox = Boolean(
          data.is_sandbox ?? primary?.is_sandbox,
        )
        if (isCertSandbox) {
          setLiveNlvSource('sandbox_skipped')
          return
        }
        const nlv = Number(primary?.net_liquidating_value)
        if (Number.isFinite(nlv) && nlv > 0) {
          setLiveNlv(nlv)
          setLiveNlvSource(
            matched
              ? (primary.is_paper ? 'broker_paper' : 'broker_live')
              : 'broker_fallback',
          )
        } else {
          setLiveNlvSource('broker_no_balance')
        }
      } catch {
        if (!cancelled) setLiveNlvSource('broker_unreachable')
      }
    })()
    return () => { cancelled = true }
  }, [profile?.id, config.mode, config.live_account_number, config.sandbox_account_number])

  const manualNlv = Number(profile?.account_size) || 0
  const nlv = liveNlv ?? manualNlv
  const perTradeMaxLossDollars = nlv * (config.per_trade_max_loss_pct / 100)
  const dailyLossCapDollars = nlv * (config.daily_loss_kill_pct / 100)
  const weeklyLossCapDollars = nlv * (config.weekly_loss_kill_pct / 100)
  const maxExposureDollars = nlv * (config.max_concurrent_exposure_pct / 100)

  // The risk preview at the bottom — what the bot would do RIGHT NOW
  // if a qualifying print landed. Helps the user see the consequence
  // of their config edits before saving.
  const preview = useMemo(() => {
    try {
      return evaluateRisk({
        config,
        nlv,
        todayPnl: 0,
        weekPnl: 0,
        openPositionsCount: 0,
        openExposureDollars: 0,
        tradesAttemptedToday: 0,
        recentClosedTrades: [],
        botPausedUntil: pausedUntil,
        botPausedReason: pausedReason,
        todayEventBlock: null,
      })
    } catch { return null }
  }, [config, nlv, pausedUntil, pausedReason])

  function update(key, value) {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  function toggleEventBlock(day) {
    const current = config.event_block_days ?? []
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day]
    update('event_block_days', next)
  }

  async function save() {
    // Live-mode flip requires the typed phrase
    const flippingToLive =
      config.mode === 'live' && initial.mode !== 'live'
    if (flippingToLive && liveConfirmText !== LIVE_CONFIRM) {
      setError(`Type "${LIVE_CONFIRM}" in the confirmation box to enable live mode.`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { error: err } = await supabase
        .from('profiles')
        .update({ bot_config: config })
        .eq('id', profile.id)
      if (err) throw err
      setDirty(false)
      setLiveConfirmText('')
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
      onProfileChange?.()
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setSaving(false)
    }
  }

  // Dedicated handler for the inline "Confirm switch to LIVE" button.
  // Saves ONLY the mode field — separate from the main "Save bot
  // config" button at the bottom of the card so the user doesn't have
  // to scroll past every filter input to commit a mode change.
  // Validates the typed phrase, persists, then resets the local
  // confirm state.
  async function confirmLiveMode() {
    if (liveConfirmText !== LIVE_CONFIRM) {
      setError(`Type "${LIVE_CONFIRM}" exactly to confirm.`)
      return
    }
    setConfirmingLive(true)
    setError(null)
    try {
      // Build a merged config that respects any other unsaved edits
      // the user has made — we save the entire current config, just
      // with the new mode overlay. Mirrors what save() does without
      // the dirty-flag dance.
      const next = { ...config, mode: 'live' }
      const { error: err } = await supabase
        .from('profiles')
        .update({ bot_config: next })
        .eq('id', profile.id)
      if (err) throw err
      setConfig(next)
      setDirty(false)
      setLiveConfirmText('')
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
      onProfileChange?.()
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setConfirmingLive(false)
    }
  }

  async function resetKillSwitch() {
    if (!confirm('Resume the bot? Make sure the underlying problem that triggered the halt is resolved before re-enabling.')) return
    setResettingKill(true)
    setError(null)
    try {
      const { error: err } = await supabase
        .from('profiles')
        .update({ bot_paused_until: null, bot_paused_reason: null })
        .eq('id', profile.id)
      if (err) throw err
      onProfileChange?.()
    } catch (e) {
      setError(e.message ?? String(e))
    } finally {
      setResettingKill(false)
    }
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-subtle text-xs font-semibold uppercase tracking-wider">Bot</h3>
        <BotStatusBadge config={config} isHalted={isHalted} />
      </div>

      {/* Top-of-card pending-changes banner — surfaces the save state
          without making the user scroll past every filter input to
          find the bottom Save button. Shows only when there are
          unsaved edits AND we're NOT in the middle of the Live-flip
          dance (which has its own dedicated Confirm button). */}
      {dirty && config.mode === initial.mode && (
        <div className="bg-amber-400/10 border border-amber-400/40 rounded-lg p-2.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-amber-400 font-medium">
            Unsaved changes
          </span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => { setConfig(initial); setDirty(false); setLiveConfirmText('') }}
              disabled={saving}
              className="text-[11px] text-subtle hover:text-fg px-2 py-1 transition disabled:opacity-50"
            >
              Revert
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="text-[11px] font-semibold bg-amber-400 hover:bg-amber-300 text-bg px-2.5 py-1 rounded transition disabled:opacity-50"
            >
              {saving ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* ─── Kill-switch state ─────────────────────────────── */}
      {isHalted && (
        <div className="bg-crimson/10 border border-crimson/40 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <ShieldAlert size={14} className="text-crimson" />
            <span className="text-crimson text-xs font-semibold">Bot is halted</span>
          </div>
          {pausedReason && (
            <p className="text-[11px] text-crimson">Reason: {pausedReason}</p>
          )}
          <button
            type="button"
            onClick={resetKillSwitch}
            disabled={resettingKill}
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-crimson hover:text-red-300 border border-crimson/30 rounded px-2 py-1 transition disabled:opacity-50"
          >
            <RotateCcw size={11} />
            {resettingKill ? 'Resetting…' : 'Reset kill switch'}
          </button>
        </div>
      )}

      {/* ─── Enable / Mode ─────────────────────────────────── */}
      <Subsection title="Operation">
        <ToggleRow
          label="Bot enabled"
          help="Master switch. When off, scanner does not write alerts and the entry orchestrator skips everything."
          value={config.enabled}
          onChange={(v) => update('enabled', v)}
        />
        <ModeRow
          mode={config.mode}
          onChange={(v) => update('mode', v)}
          flippingToLive={config.mode === 'live' && initial.mode !== 'live'}
          liveConfirmText={liveConfirmText}
          setLiveConfirmText={setLiveConfirmText}
          onConfirmLive={confirmLiveMode}
          confirmingLive={confirmingLive}
        />
        <ToggleRow
          label="Dry-run"
          help="Log proposed entries to auto_triggers without calling the broker. Use for paper-paper validation."
          value={!!config.dry_run}
          onChange={(v) => update('dry_run', v)}
        />
      </Subsection>

      {/* ─── Strategies ────────────────────────────────────── */}
      <Subsection title="Strategies">
        <StrategyAllocationSummary strategies={config.strategies ?? {}} />
        {STRATEGY_META.map(({ key, label, desc }) => (
          <StrategyRow
            key={key}
            label={label}
            desc={desc}
            value={config.strategies?.[key] ?? DEFAULT_STRATEGIES[key]}
            onChange={(next) => update('strategies', { ...(config.strategies ?? {}), [key]: next })}
          />
        ))}
      </Subsection>

      {/* ─── Risk caps ─────────────────────────────────────── */}
      <Subsection title="Risk caps">
        <NlvIndicator nlv={nlv} source={liveNlvSource} liveNlv={liveNlv} manualNlv={manualNlv} />
        <PercentRow
          label="Per-trade max loss"
          help={`${formatDollars(perTradeMaxLossDollars)} at current NLV`}
          value={config.per_trade_max_loss_pct}
          onChange={(v) => update('per_trade_max_loss_pct', v)}
          suffix="% of NLV"
        />
        <PercentRow
          label="Daily loss cap (kill switch)"
          help={`${formatDollars(dailyLossCapDollars)} — bot auto-halts at this loss`}
          value={config.daily_loss_kill_pct}
          onChange={(v) => update('daily_loss_kill_pct', v)}
          suffix="% of NLV"
        />
        <PercentRow
          label="Weekly loss cap (kill switch)"
          help={`${formatDollars(weeklyLossCapDollars)} — broader circuit breaker`}
          value={config.weekly_loss_kill_pct}
          onChange={(v) => update('weekly_loss_kill_pct', v)}
          suffix="% of NLV"
        />
        <NumberRow
          label="Max concurrent positions"
          value={config.max_concurrent_positions}
          onChange={(v) => update('max_concurrent_positions', v)}
          min={1}
          max={20}
        />
        <PercentRow
          label="Max concurrent exposure"
          help={`${formatDollars(maxExposureDollars)} across all open positions`}
          value={config.max_concurrent_exposure_pct}
          onChange={(v) => update('max_concurrent_exposure_pct', v)}
          suffix="% of NLV"
        />
        <NumberRow
          label="Max trades per day"
          value={config.max_trades_per_day}
          onChange={(v) => update('max_trades_per_day', v)}
          min={1}
          max={50}
        />
        <NumberRow
          label="Consecutive loss pause"
          help={`After this many losses in a row, pause new entries for ${config.consecutive_loss_pause_minutes} minutes`}
          value={config.consecutive_loss_pause_count}
          onChange={(v) => update('consecutive_loss_pause_count', v)}
          min={1}
          max={20}
        />
        <NumberRow
          label="Cooldown duration"
          value={config.consecutive_loss_pause_minutes}
          onChange={(v) => update('consecutive_loss_pause_minutes', v)}
          min={5}
          max={240}
          suffix="min"
        />
      </Subsection>

      {/* ─── Entry filters ─────────────────────────────────── */}
      <Subsection title="Entry filters">
        <DollarRow
          label="Min premium"
          help="Whale prints below this are filtered out"
          value={config.min_premium_dollars}
          onChange={(v) => update('min_premium_dollars', v)}
        />
        <NumberRangeRow
          label="OTM range"
          minValue={config.min_otm_pct}
          maxValue={config.max_otm_pct}
          onChangeMin={(v) => update('min_otm_pct', v)}
          onChangeMax={(v) => update('max_otm_pct', v)}
          suffix="%"
        />
        <NumberRangeRow
          label="DTE range"
          minValue={config.min_dte}
          maxValue={config.max_dte}
          onChangeMin={(v) => update('min_dte', v)}
          onChangeMax={(v) => update('max_dte', v)}
          suffix="d"
        />
        <NumberRow
          label="Min Vol/OI ratio"
          help="≥2 = likely opening position, not closing"
          value={config.min_vol_oi_ratio}
          onChange={(v) => update('min_vol_oi_ratio', v)}
          min={0.1}
          max={20}
          step={0.5}
        />
        <NumberRow
          label="Max bid-ask spread"
          help="Wider spreads = worse fills"
          value={config.max_bid_ask_pct}
          onChange={(v) => update('max_bid_ask_pct', v)}
          min={1}
          max={50}
          suffix="% of mid"
        />
        <NumberRow
          label="Max IV rank"
          help="Avoid chasing expensive vol"
          value={config.max_iv_rank}
          onChange={(v) => update('max_iv_rank', v)}
          min={0}
          max={100}
          suffix="%"
        />
        <NumberRow
          label="Max stock 7-day move"
          help="Skip names that already ran"
          value={config.max_weekly_stock_move_pct}
          onChange={(v) => update('max_weekly_stock_move_pct', v)}
          min={5}
          max={100}
          suffix="%"
        />
        <NumberRow
          label="Earnings skip window"
          help="Skip names with earnings within N days"
          value={config.earnings_skip_window_days}
          onChange={(v) => update('earnings_skip_window_days', v)}
          min={0}
          max={30}
          suffix="d"
        />
        <TimeRangeRow
          label="Entry time window (ET)"
          start={config.entry_window_start}
          end={config.entry_window_end}
          onChangeStart={(v) => update('entry_window_start', v)}
          onChangeEnd={(v) => update('entry_window_end', v)}
        />
        <DollarRow
          label="Min stock daily $ volume"
          help="Liquidity floor — skip illiquid underlyings"
          value={config.min_stock_daily_volume_dollars}
          onChange={(v) => update('min_stock_daily_volume_dollars', v)}
        />
        <EventBlocksRow
          selected={config.event_block_days ?? []}
          onToggle={toggleEventBlock}
        />
      </Subsection>

      {/* ─── Broker accounts ───────────────────────────────── */}
      <Subsection title="Broker accounts">
        <Input
          label="Sandbox account number"
          help="Tastytrade cert (api.cert.tastyworks.com). Used in paper mode."
          value={config.sandbox_account_number ?? ''}
          onChange={(v) => update('sandbox_account_number', v || null)}
          placeholder="5WX12345"
        />
        <Input
          label="Live account number"
          help="Tastytrade production. Used in live mode."
          value={config.live_account_number ?? ''}
          onChange={(v) => update('live_account_number', v || null)}
          placeholder="5WV87654"
        />
      </Subsection>

      {/* ─── Risk envelope preview ─────────────────────────── */}
      {preview && (
        <Subsection title="Preview">
          <p className="text-[11px] text-subtle mb-2">
            What the bot would do if a qualifying print landed right now (assuming no open positions, no P&L today).
          </p>
          {preview.allowEntry ? (
            <div className="flex items-start gap-2 text-[11px] text-green-400 bg-green-950/20 border border-green-400/30 rounded p-2">
              <Sparkles size={12} className="mt-0.5 shrink-0" />
              <span>Entry would proceed. Per-trade risk: {formatDollars(perTradeMaxLossDollars)}.</span>
            </div>
          ) : (
            <div className="flex items-start gap-2 text-[11px] text-amber-400 bg-amber-950/20 border border-amber-400/30 rounded p-2">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>Entry would be blocked: {preview.blockReason}</span>
            </div>
          )}
        </Subsection>
      )}

      {error && (
        <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-3 text-[11px] text-red-400">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className={clsx(
            'flex-1 font-semibold rounded-lg py-2.5 text-sm transition',
            dirty
              ? 'bg-amber-400 hover:bg-amber-300 text-bg disabled:opacity-50'
              : 'bg-bg/60 border border-border text-muted cursor-not-allowed',
          )}
        >
          {saving ? 'Saving…' : savedFlash ? 'Saved ✓' : dirty ? 'Save bot config' : 'No changes'}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => { setConfig(initial); setDirty(false); setLiveConfirmText('') }}
            className="px-3 py-2 border border-border text-subtle hover:text-fg text-sm rounded-lg transition"
          >
            Revert
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Sub-components ────────────────────────────────────────

function BotStatusBadge({ config, isHalted }) {
  let label, cls, icon
  if (isHalted) {
    label = 'HALTED'
    cls = 'text-crimson border-crimson/40 bg-crimson/10'
    icon = <ShieldAlert size={11} />
  } else if (!config.enabled) {
    label = 'DISABLED'
    cls = 'text-muted border-border bg-bg/60'
    icon = <Activity size={11} />
  } else if (config.mode === 'paper') {
    label = 'PAPER · ACTIVE'
    cls = 'text-amber-400 border-amber-400/40 bg-amber-400/10'
    icon = <Sparkles size={11} />
  } else {
    label = 'LIVE · ACTIVE'
    cls = 'text-green-400 border-green-400/40 bg-green-400/10'
    icon = <Sparkles size={11} />
  }
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded border ${cls}`}>
      {icon}
      {label}
    </span>
  )
}

// Surfaces the NLV value the bot is computing risk caps against,
// and where that number came from. The bot's server-side risk math
// (bot-execute-entry → resolveLiveNlv) follows the same priority
// order this indicator displays:
//   1. broker_live        — Tastytrade /accounts/:id/balances NLV
//   2. sandbox_skipped    — broker reachable but on cert endpoint;
//                           fake $100K NLV ignored, fall back to manual
//   3. broker_unreachable — broker call failed, using manual fallback
//   4. broker_no_balance  — broker returned no usable balance
//   5. loading            — get-account call still in flight
function NlvIndicator({ nlv, source, liveNlv, manualNlv }) {
  const isLive = source === 'broker_live' || source === 'broker_paper'
  const isFallback = !isLive && source !== 'loading'
  return (
    <div
      className={clsx(
        'flex items-baseline justify-between gap-2 -mt-1 mb-1 px-2 py-1.5 rounded border',
        isLive
          ? 'bg-green-950/20 border-green-400/30'
          : isFallback
          ? 'bg-amber-950/30 border-amber-400/40'
          : 'bg-bg/40 border-border/50',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-muted">Computed against NLV</div>
        <div className={clsx('text-xs font-mono-tab', isLive ? 'text-green-400' : 'text-fg')}>
          ${Number(nlv).toLocaleString()}
        </div>
      </div>
      <div className="text-[10px] text-right shrink-0 max-w-[55%]">
        {source === 'loading' && <span className="text-muted">syncing broker…</span>}
        {source === 'broker_live' && (
          <span className="text-green-400">live broker NLV ✓</span>
        )}
        {source === 'broker_paper' && (
          <span className="text-green-400">paper account NLV ✓</span>
        )}
        {source === 'broker_fallback' && (
          <span className="text-amber-400">account # not found · using largest</span>
        )}
        {source === 'sandbox_skipped' && (
          <span className="text-amber-400">cert sandbox · using manual</span>
        )}
        {source === 'broker_unreachable' && (
          <span className="text-amber-400">broker unreachable · using manual</span>
        )}
        {source === 'broker_no_balance' && (
          <span className="text-amber-400">no broker balance · using manual</span>
        )}
        {isFallback && manualNlv > 0 && (
          <div className="text-muted mt-0.5">Manual: ${manualNlv.toLocaleString()}</div>
        )}
      </div>
    </div>
  )
}

function Subsection({ title, children }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div className="space-y-2.5 bg-bg/40 border border-border/50 rounded-lg p-3">
        {children}
      </div>
    </div>
  )
}

function ToggleRow({ label, help, value, onChange }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-fg">{label}</div>
        {help && <div className="text-[10px] text-muted mt-0.5">{help}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={clsx(
          'relative w-9 h-5 rounded-full transition shrink-0',
          value ? 'bg-amber-400' : 'bg-zinc-700',
        )}
        aria-pressed={value}
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
            value && 'translate-x-4',
          )}
        />
      </button>
    </div>
  )
}

function ModeRow({ mode, onChange, flippingToLive, liveConfirmText, setLiveConfirmText, onConfirmLive, confirmingLive }) {
  const phraseValid = liveConfirmText === LIVE_CONFIRM
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-fg">Mode</div>
      <div className="flex gap-2">
        <ModeButton active={mode === 'paper'} onClick={() => onChange('paper')} label="Paper" subLabel="Sandbox" tone="amber" />
        <ModeButton active={mode === 'live'} onClick={() => onChange('live')} label="Live" subLabel="Real money" tone="crimson" />
      </div>
      {flippingToLive && (
        <div className="bg-crimson/10 border border-crimson/40 rounded p-2 space-y-2">
          <p className="text-[11px] text-crimson font-medium">
            ⚠ Flipping to LIVE mode. The bot will submit real orders against your live account.
            Type the phrase below, then tap Confirm.
          </p>
          <input
            value={liveConfirmText}
            onChange={(e) => setLiveConfirmText(e.target.value)}
            placeholder={`Type ${LIVE_CONFIRM} to confirm`}
            className="w-full bg-card border border-crimson/30 rounded px-2 py-1.5 text-xs font-mono"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck="false"
          />
          <button
            type="button"
            onClick={onConfirmLive}
            disabled={!phraseValid || confirmingLive}
            className={clsx(
              'w-full text-xs font-semibold rounded py-2 transition',
              phraseValid && !confirmingLive
                ? 'bg-crimson hover:bg-red-500 text-white'
                : 'bg-bg/60 border border-border text-muted cursor-not-allowed',
            )}
          >
            {confirmingLive ? 'Flipping to live…' : phraseValid ? 'Confirm switch to LIVE' : 'Type GO LIVE to enable'}
          </button>
          <button
            type="button"
            onClick={() => { setLiveConfirmText(''); onChange('paper') }}
            disabled={confirmingLive}
            className="w-full text-[11px] text-subtle hover:text-fg py-1 transition disabled:opacity-50"
          >
            Cancel — stay on paper
          </button>
        </div>
      )}
    </div>
  )
}

function ModeButton({ active, onClick, label, subLabel, tone }) {
  const activeClasses = tone === 'amber'
    ? 'bg-amber-400/15 border-amber-400/50 text-amber-400'
    : 'bg-crimson/15 border-crimson/50 text-crimson'
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex-1 px-3 py-2 rounded border transition text-left',
        active ? activeClasses : 'bg-bg/60 border-border text-subtle hover:text-fg',
      )}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="text-[10px] opacity-80">{subLabel}</div>
    </button>
  )
}

function PercentRow({ label, help, value, onChange, suffix = '%' }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-fg">{label}</div>
        {help && <div className="text-[10px] text-muted mt-0.5">{help}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          min={0}
          max={100}
          step={0.5}
          className="w-16 bg-card border border-border rounded px-2 py-1 text-xs font-mono-tab text-right"
        />
        <span className="text-[10px] text-muted">{suffix}</span>
      </div>
    </div>
  )
}

function NumberRow({ label, help, value, onChange, min, max, step = 1, suffix }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-fg">{label}</div>
        {help && <div className="text-[10px] text-muted mt-0.5">{help}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          min={min}
          max={max}
          step={step}
          className="w-16 bg-card border border-border rounded px-2 py-1 text-xs font-mono-tab text-right"
        />
        {suffix && <span className="text-[10px] text-muted">{suffix}</span>}
      </div>
    </div>
  )
}

function NumberRangeRow({ label, minValue, maxValue, onChangeMin, onChangeMax, suffix = '' }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-fg">{label}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <input
          type="number"
          value={minValue}
          onChange={(e) => onChangeMin(Number(e.target.value))}
          className="w-14 bg-card border border-border rounded px-2 py-1 text-xs font-mono-tab text-right"
        />
        <span className="text-[10px] text-muted">to</span>
        <input
          type="number"
          value={maxValue}
          onChange={(e) => onChangeMax(Number(e.target.value))}
          className="w-14 bg-card border border-border rounded px-2 py-1 text-xs font-mono-tab text-right"
        />
        <span className="text-[10px] text-muted">{suffix}</span>
      </div>
    </div>
  )
}

function DollarRow({ label, help, value, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-fg">{label}</div>
        {help && <div className="text-[10px] text-muted mt-0.5">{help}</div>}
        <div className="text-[10px] text-subtle font-mono-tab mt-0.5">
          {formatDollars(Number(value))}
        </div>
      </div>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={0}
        step={50000}
        className="w-28 bg-card border border-border rounded px-2 py-1 text-xs font-mono-tab text-right shrink-0"
      />
    </div>
  )
}

function TimeRangeRow({ label, start, end, onChangeStart, onChangeEnd }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-fg">{label}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <input
          type="time"
          value={start}
          onChange={(e) => onChangeStart(e.target.value)}
          className="bg-card border border-border rounded px-2 py-1 text-xs font-mono-tab"
        />
        <span className="text-[10px] text-muted">to</span>
        <input
          type="time"
          value={end}
          onChange={(e) => onChangeEnd(e.target.value)}
          className="bg-card border border-border rounded px-2 py-1 text-xs font-mono-tab"
        />
      </div>
    </div>
  )
}

function EventBlocksRow({ selected, onToggle }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-fg">Event-block days</div>
      <div className="text-[10px] text-muted">Bot pauses entries on these days.</div>
      <div className="flex flex-wrap gap-1">
        {EVENT_BLOCK_OPTIONS.map((d) => {
          const isOn = selected.includes(d)
          return (
            <button
              key={d}
              type="button"
              onClick={() => onToggle(d)}
              className={clsx(
                'text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition',
                isOn
                  ? 'bg-amber-400/15 border-amber-400/40 text-amber-400'
                  : 'bg-bg/60 border-border text-subtle hover:text-fg',
              )}
            >
              {isOn ? <Check size={9} className="inline mr-0.5" /> : null}
              {d}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Input({ label, help, value, onChange, placeholder }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <label className="text-xs font-medium text-fg">{label}</label>
      </div>
      {help && <div className="text-[10px] text-muted">{help}</div>}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-card border border-border rounded px-2 py-1.5 text-xs font-mono-tab"
      />
    </div>
  )
}

function formatDollars(n) {
  if (!Number.isFinite(n)) return '$0'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function StrategyAllocationSummary({ strategies }) {
  const enabled = Object.entries(strategies).filter(([, v]) => v?.enabled && !v?.kill_switch)
  const total = enabled.reduce((s, [, v]) => s + (Number(v.capital_allocation_pct) || 0), 0)
  if (enabled.length === 0) {
    return (
      <div className="text-[10px] text-muted bg-card/50 border border-dashed border-border rounded px-2 py-1.5">
        No strategies active. Enable at least one to let the bot place trades.
      </div>
    )
  }
  const over = total > 100
  return (
    <div className={clsx(
      'text-[10px] rounded px-2 py-1.5 border',
      over ? 'text-amber-300 bg-amber-400/10 border-amber-400/30' : 'text-subtle bg-card/50 border-border',
    )}>
      Active: <span className="font-mono-tab">{enabled.map(([k]) => k).join(', ')}</span>
      {' · '}allocation <span className="font-mono-tab">{total}%</span>
      {over && ' · overallocated (sum > 100%)'}
    </div>
  )
}

function StrategyRow({ label, desc, value, onChange }) {
  const enabled = !!value?.enabled
  const kill = !!value?.kill_switch
  return (
    <div className="space-y-1.5 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-fg">{label}</div>
          <div className="text-[10px] text-muted">{desc}</div>
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...value, enabled: !enabled })}
          className={clsx(
            'text-[10px] px-2 py-1 rounded border font-semibold transition shrink-0',
            enabled
              ? 'bg-green-500/15 text-green-300 border-green-500/40'
              : 'bg-card text-subtle border-border hover:text-fg'
          )}
        >
          {enabled ? 'ON' : 'OFF'}
        </button>
      </div>
      {enabled && (
        <div className="flex items-center gap-2 pl-1">
          <label className="text-[10px] text-subtle">Allocation</label>
          <input
            type="number"
            value={Number(value?.capital_allocation_pct ?? 0)}
            onChange={(e) => onChange({ ...value, capital_allocation_pct: Number(e.target.value) })}
            min={0}
            max={100}
            step={5}
            className="w-16 bg-card border border-border rounded px-1.5 py-0.5 text-[11px] font-mono-tab text-right"
          />
          <span className="text-[10px] text-muted">% of NLV</span>
          <button
            type="button"
            onClick={() => onChange({ ...value, kill_switch: !kill })}
            className={clsx(
              'ml-auto text-[10px] px-1.5 py-0.5 rounded border transition',
              kill
                ? 'bg-crimson/15 text-crimson border-crimson/40'
                : 'bg-card text-subtle border-border hover:text-amber-300 hover:border-amber-400/40'
            )}
          >
            {kill ? 'Killed — restore' : 'Kill switch'}
          </button>
        </div>
      )}
    </div>
  )
}
