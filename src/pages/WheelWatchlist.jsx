import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Star, ChevronRight, AlertTriangle, Pencil, Trash2, Check, X, Plus } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { WHEEL_CANDIDATES, TICKER_UNIVERSE } from '../lib/tickerUniverse'
import EarningsBadge from '../components/EarningsBadge'

// Wheel Picks — the curated dividend-paying names the owner will
// actually wheel. Source of truth = public.wheel_picks (per-user,
// editable inline). Falls back to the WHEEL_CANDIDATES const when
// the user has no rows (new account / wipeout recovery), so the
// page never blanks out from an empty table.
//
// Sizing is dynamic. max_contracts per row = floor( (account × 20%)
// / (live_price × 100) ). Rows where max_contracts < 1 are filtered.
//
// Edit mode (pencil icon in header):
//   * Each row gains a tier selector (T1 / T2 / T3) + delete button.
//   * "Add ticker" input at top — type a symbol, hit add, drops in as
//     T3 by default. Symbol validated against TICKER_UNIVERSE; if it
//     isn't a known ticker the add is allowed but flagged.
//   * Changes save live (debounced via per-row mutation), no global
//     "Save" button.
//   * Toggle pencil again to exit edit mode.
//
// Replaces /leaderboard in the mobile bottom nav per owner.

const CONCENTRATION_CAP_PCT = 0.20

const TIER_LABEL = {
  1: 'T1 · highest conviction',
  2: 'T2 · solid with caveats',
  3: 'T3 · higher risk / backfill',
}

const TIER_TONE = {
  1: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  2: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  3: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/40',
}

const UNIVERSE_BY_SYMBOL = new Map(TICKER_UNIVERSE.map((t) => [t.symbol, t]))

export default function WheelWatchlist() {
  const { user, profile } = useAuth()
  const accountSize = Number(profile?.account_size) || 0
  const maxPerTicker = accountSize * CONCENTRATION_CAP_PCT

  const [picks, setPicks] = useState(null)         // null = loading; [] = empty; [{…}] = loaded
  const [quotes, setQuotes] = useState(new Map())
  const [editing, setEditing] = useState(false)
  const [addInput, setAddInput] = useState('')
  const [addError, setAddError] = useState('')

  // Load picks. If the user has rows in wheel_picks, use those.
  // Otherwise fall back to the WHEEL_CANDIDATES const so the page
  // is never blank (new accounts get a sensible default view).
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('wheel_picks')
        .select('id, ticker, tier, label, sort_order')
        .eq('user_id', user.id)
        .order('tier', { ascending: true })
        .order('sort_order', { ascending: true })
      if (cancelled) return
      if (error) {
        console.error('[picks] load failed', error)
        setPicks([])
        return
      }
      setPicks(data ?? [])
    })()
    return () => { cancelled = true }
  }, [user?.id])

  // Resolved picks: DB rows if any, else const fallback.
  const resolved = useMemo(() => {
    if (picks == null) return []
    if (picks.length > 0) return picks.map((p) => ({
      id: p.id,
      ticker: p.ticker,
      tier: p.tier,
      label: p.label || UNIVERSE_BY_SYMBOL.get(p.ticker)?.label || p.ticker,
      fromDb: true,
    }))
    return WHEEL_CANDIDATES.map((c) => ({
      id: `const:${c.symbol}`,
      ticker: c.symbol,
      tier: c.tier,
      label: c.label,
      fromDb: false,
    }))
  }, [picks])

  // Live price fetch — same as before. Triggered on resolved-list
  // change so newly-added tickers get priced on the next render.
  useEffect(() => {
    if (resolved.length === 0) return
    let cancelled = false
    ;(async () => {
      const symbols = resolved.map((c) => c.ticker)
      const { data, error } = await supabase
        .from('dxlink_quotes')
        .select('symbol, mid, bid, ask, prev_close, updated_at')
        .in('symbol', symbols)
        .eq('kind', 'equity')
      if (cancelled || error) return
      const map = new Map()
      for (const r of data ?? []) {
        map.set(String(r.symbol).toUpperCase(), r)
      }
      setQuotes(map)
    })()
    return () => { cancelled = true }
  }, [resolved])

  const decorated = useMemo(() => {
    return resolved.map((c) => {
      const q = quotes.get(c.ticker)
      const price = q?.mid ?? q?.bid ?? null
      const prev = q?.prev_close ?? null
      const pct = price != null && prev != null && prev > 0
        ? ((price - prev) / prev) * 100
        : null
      const maxContracts = price != null && maxPerTicker > 0
        ? Math.floor(maxPerTicker / (price * 100))
        : null
      return { ...c, price, pct, maxContracts }
    })
  }, [resolved, quotes, maxPerTicker])

  const filtered = accountSize > 0 && !editing
    ? decorated.filter((c) => c.maxContracts == null || c.maxContracts >= 1)
    : decorated

  const hiddenCount = decorated.length - filtered.length

  const byTier = [1, 2, 3].map((tier) => ({
    tier,
    items: filtered.filter((c) => c.tier === tier),
  })).filter((g) => g.items.length > 0 || editing)

  // ── Mutations ───────────────────────────────────────────────────

  async function changeTier(pick, newTier) {
    if (!user?.id || !pick.fromDb) return
    // Optimistic update so the tier change feels instant.
    setPicks((cur) => (cur ?? []).map((p) => p.id === pick.id ? { ...p, tier: newTier } : p))
    const { error } = await supabase
      .from('wheel_picks')
      .update({ tier: newTier })
      .eq('id', pick.id)
    if (error) {
      console.error('[picks] tier update failed', error)
      // Revert
      setPicks((cur) => (cur ?? []).map((p) => p.id === pick.id ? { ...p, tier: pick.tier } : p))
    }
  }

  async function removePick(pick) {
    if (!user?.id || !pick.fromDb) return
    const prev = picks
    setPicks((cur) => (cur ?? []).filter((p) => p.id !== pick.id))
    const { error } = await supabase
      .from('wheel_picks')
      .delete()
      .eq('id', pick.id)
    if (error) {
      console.error('[picks] delete failed', error)
      setPicks(prev)
    }
  }

  async function addPick(symbol) {
    if (!user?.id || !symbol) return
    const upper = String(symbol).toUpperCase().trim()
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(upper)) {
      setAddError('Invalid symbol')
      return
    }
    if (picks?.some((p) => p.ticker === upper)) {
      setAddError(`${upper} is already in your picks`)
      return
    }
    setAddError('')
    const label = UNIVERSE_BY_SYMBOL.get(upper)?.label || upper
    const maxSort = (picks ?? []).filter((p) => p.tier === 3).reduce((m, p) => Math.max(m, p.sort_order || 0), 0)
    const { data, error } = await supabase
      .from('wheel_picks')
      .insert({
        user_id: user.id,
        ticker: upper,
        tier: 3,
        label,
        sort_order: maxSort + 10,
      })
      .select()
      .single()
    if (error) {
      console.error('[picks] insert failed', error)
      setAddError(error.message)
      return
    }
    setPicks((cur) => [...(cur ?? []), data])
    setAddInput('')
  }

  // ── Render ──────────────────────────────────────────────────────

  const usingFallback = picks != null && picks.length === 0

  return (
    <div className="px-4 py-4 pb-24 max-w-2xl mx-auto">
      <header className="mb-4">
        <div className="flex items-center gap-2 mb-1">
          <Star size={16} className="text-amber-400 fill-amber-400" />
          <h1 className="text-lg font-semibold flex-1">Wheel Picks</h1>
          <button
            type="button"
            onClick={() => { setEditing((v) => !v); setAddError('') }}
            aria-label={editing ? 'Done editing' : 'Edit picks'}
            className={clsx(
              'p-1.5 rounded border transition',
              editing
                ? 'bg-amber-400/10 border-amber-400/40 text-amber-300'
                : 'border-border text-subtle hover:text-fg hover:border-amber-400/40',
            )}
          >
            {editing ? <Check size={14} /> : <Pencil size={14} />}
          </button>
        </div>
        <p className="text-xs text-subtle leading-relaxed">
          Dividend payers curated for three income streams: dividend
          hold + short-put premium + covered-call premium. Max
          contracts per row enforces the 20% per-ticker cap based on
          your account size.{' '}
          {editing
            ? <span className="text-amber-300">Edit mode — changes save live.</span>
            : 'Tap to evaluate GEX + IV before placing.'}
        </p>
      </header>

      {accountSize <= 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-4 mb-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-amber-200 mb-1">
                Set your account size
              </div>
              <p className="text-xs text-subtle leading-relaxed">
                Contract sizing depends on the 20% per-ticker cap.{' '}
                <Link to="/settings" className="text-amber-300 underline">
                  Open Settings →
                </Link>
              </p>
            </div>
          </div>
        </div>
      )}

      {accountSize > 0 && (
        <div className="text-[10px] text-muted mb-4">
          Account size <span className="text-fg font-mono-tab">${accountSize.toLocaleString()}</span>
          {' · '}
          per-ticker cap <span className="text-fg font-mono-tab">${maxPerTicker.toLocaleString()}</span>
          {hiddenCount > 0 && !editing && (
            <>
              {' · '}
              <span className="text-rose-300">{hiddenCount} hidden</span> (too expensive)
            </>
          )}
          {usingFallback && (
            <>
              {' · '}
              <span className="text-muted">showing default list — tap edit to customize</span>
            </>
          )}
        </div>
      )}

      {editing && (
        <div className="mb-4 flex items-center gap-2">
          <input
            type="text"
            value={addInput}
            onChange={(e) => { setAddInput(e.target.value.toUpperCase()); setAddError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') addPick(addInput) }}
            placeholder="Add ticker (e.g. HBAN)"
            className="flex-1 bg-card border border-border rounded px-3 py-2 text-sm font-mono-tab focus:outline-none focus:ring-1 focus:ring-amber-400/40"
            maxLength={10}
          />
          <button
            type="button"
            onClick={() => addPick(addInput)}
            disabled={!addInput.trim()}
            className="px-3 py-2 rounded bg-amber-400/10 border border-amber-400/40 text-amber-300 text-sm font-semibold hover:bg-amber-400/20 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={14} className="inline -mt-0.5" /> Add
          </button>
        </div>
      )}
      {editing && addError && (
        <div className="mb-3 text-xs text-rose-300">{addError}</div>
      )}

      {picks == null ? (
        <div className="text-xs text-muted py-8 text-center">Loading…</div>
      ) : (
        byTier.map(({ tier, items }) => (
          <section key={tier} className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span
                className={clsx(
                  'text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border font-semibold',
                  TIER_TONE[tier],
                )}
              >
                {TIER_LABEL[tier]}
              </span>
              <span className="text-[10px] text-muted">
                {items.length} {items.length === 1 ? 'name' : 'names'}
              </span>
            </div>
            <div className="space-y-1.5">
              {items.length === 0 && editing && (
                <div className="text-xs text-muted italic px-3 py-2 border border-dashed border-border rounded-lg">
                  No {TIER_LABEL[tier].split('·')[0].trim()} picks yet.
                </div>
              )}
              {items.map((c) => (
                <PickRow
                  key={c.id}
                  pick={c}
                  editing={editing}
                  onTierChange={(t) => changeTier(c, t)}
                  onRemove={() => removePick(c)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <div className="mt-6 text-[10px] text-muted leading-relaxed border-t border-border pt-4">
        Live prices come from <code className="text-fg">dxlink_quotes</code>;
        rows without a price haven't streamed recently. Max contracts
        = floor((account × 20%) / (price × 100)) — change account size
        in <Link to="/settings" className="text-amber-300 underline">Settings</Link>.
      </div>
    </div>
  )
}

function PickRow({ pick, editing, onTierChange, onRemove }) {
  const pctTone = pick.pct == null
    ? 'text-muted'
    : pick.pct >= 0 ? 'text-green-400' : 'text-red-400'

  const body = (
    <div className="flex items-center gap-3 px-3 py-3 rounded-lg bg-card border border-border group-hover:border-amber-400/40 transition">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-semibold text-fg font-mono-tab">
            {pick.ticker}
          </span>
          {pick.maxContracts != null && pick.maxContracts > 0 && (
            <span className="text-[10px] text-muted uppercase tracking-wider">
              {pick.maxContracts}c max
            </span>
          )}
          <EarningsBadge ticker={pick.ticker} compact withTime />
        </div>
        <div className="text-xs text-subtle truncate mt-0.5">
          {pick.label}
        </div>
      </div>
      {pick.price != null && (
        <div className="text-right shrink-0">
          <div className="text-sm font-mono-tab tabular-nums text-fg leading-none">
            ${pick.price.toFixed(2)}
          </div>
          {pick.pct != null && (
            <div className={`text-[10px] tabular-nums leading-none mt-1 ${pctTone}`}>
              {pick.pct >= 0 ? '+' : ''}{pick.pct.toFixed(2)}%
            </div>
          )}
        </div>
      )}
      {!editing && (
        <ChevronRight size={14} className="text-muted group-hover:text-amber-400 shrink-0" />
      )}
    </div>
  )

  if (!editing) {
    return (
      <Link to={`/markets?ticker=${pick.ticker}`} className="block group">
        {body}
      </Link>
    )
  }

  // Edit mode: row is not a Link; tier selector + delete control sit
  // alongside. Disabled / hidden when the pick is from the const
  // fallback (read-only — user must enter edit mode AFTER adding
  // their first DB-backed pick).
  return (
    <div className="group">
      {body}
      <div className="flex items-center gap-2 mt-1 px-3">
        <span className="text-[10px] text-muted uppercase tracking-wider">Tier</span>
        {[1, 2, 3].map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTierChange(t)}
            disabled={!pick.fromDb}
            className={clsx(
              'px-2 py-0.5 text-[10px] rounded border font-semibold transition',
              pick.tier === t
                ? 'bg-amber-400/15 border-amber-400/50 text-amber-300'
                : 'border-border text-subtle hover:text-fg hover:border-zinc-500',
              !pick.fromDb && 'opacity-40 cursor-not-allowed',
            )}
          >
            T{t}
          </button>
        ))}
        <button
          type="button"
          onClick={onRemove}
          disabled={!pick.fromDb}
          aria-label={`Remove ${pick.ticker}`}
          className={clsx(
            'ml-auto p-1.5 rounded text-rose-400/60 hover:text-rose-300 hover:bg-rose-500/10 transition',
            !pick.fromDb && 'opacity-40 cursor-not-allowed',
          )}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}
