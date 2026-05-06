import { useEffect, useMemo, useState } from 'react'
import { Search, X, Star, Lock } from 'lucide-react'

// Bottom-sheet ticker picker for /markets. Opens on tap of the ticker
// name in the stats card; closes on backdrop click, Escape, or any
// row selection. Two sections — Your Watchlist (gated to Pro) and
// Curated — with a single search box that filters both by symbol or
// company label substring.
//
// We always mount the wrapper so the slide-up transition has a stable
// DOM target; visibility is gated by `open`. ESC + outside-click
// dismiss are wired here so the parent doesn't have to repeat them.

export default function TickerDrawer({
  open,
  onClose,
  curated,        // [{ symbol, label }]
  watchlist,      // [string] (uppercase)
  gatedSet,       // Set<string> — symbols locked behind Pro
  selected,
  onSelect,       // (symbol) => void
  onUpgrade,      // () => void — invoked when a locked ticker is tapped
}) {
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // reset search when reopening
    setQuery('')
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const q = query.trim().toUpperCase()
  const filteredCurated = useMemo(
    () =>
      curated.filter(
        (t) =>
          !q ||
          t.symbol.includes(q) ||
          (t.label || '').toUpperCase().includes(q),
      ),
    [curated, q],
  )
  const filteredWatchlist = useMemo(
    () => watchlist.filter((s) => !q || s.includes(q)),
    [watchlist, q],
  )

  return (
    <div
      className={`fixed inset-0 z-50 flex items-end justify-center transition ${
        open ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
    >
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />

      <div
        className={`relative w-full max-w-md bg-bg-elev border-t border-border
                    rounded-t-2xl max-h-[85vh] flex flex-col
                    transition-transform duration-200 ease-out ${
                      open ? 'translate-y-0' : 'translate-y-full'
                    }`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Drag handle for affordance — not draggable, just a visual cue */}
        <div className="pt-2 pb-1 flex justify-center">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        <div className="flex items-center justify-between px-4 pb-2">
          <h2 className="text-base font-semibold">Pick ticker</h2>
          <button
            onClick={onClose}
            className="p-1 -mr-1 text-subtle hover:text-fg"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-4 pb-3">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              type="text"
              autoFocus={open}
              placeholder="Search by symbol or name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-card border border-border rounded-lg
                         pl-9 pr-3 py-2 text-sm placeholder:text-muted
                         focus:outline-none focus:border-amber-400/40
                         transition-colors"
            />
          </div>
        </div>

        <div className="overflow-y-auto px-2 pb-3 flex-1">
          {filteredWatchlist.length > 0 && (
            <Section label="Your Watchlist">
              {filteredWatchlist.map((sym) => (
                <Row
                  key={`wl-${sym}`}
                  symbol={sym}
                  label="Tracked from your scanner queue"
                  starred
                  active={selected === sym}
                  onClick={() => {
                    onSelect(sym)
                    onClose()
                  }}
                />
              ))}
            </Section>
          )}

          {/* Hot tickers — the worker streams these in real-time, so
              they get a green pulse dot. Anything else falls back to
              Yahoo's 15-min delayed feed. */}
          {filteredCurated.filter((t) => t.isHot).length > 0 && (
            <Section label="Live · Real-time stream">
              {filteredCurated
                .filter((t) => t.isHot)
                .map((t) => {
                  const gated = gatedSet?.has(t.symbol)
                  return (
                    <Row
                      key={t.symbol}
                      symbol={t.symbol}
                      label={t.label}
                      live
                      locked={gated}
                      active={selected === t.symbol}
                      onClick={() => {
                        if (gated) onUpgrade?.()
                        else onSelect(t.symbol)
                        onClose()
                      }}
                    />
                  )
                })}
            </Section>
          )}

          {filteredCurated.filter((t) => !t.isHot).length > 0 && (
            <Section label="S&P 500 · 15-min delayed">
              {filteredCurated
                .filter((t) => !t.isHot)
                .map((t) => {
                  const gated = gatedSet?.has(t.symbol)
                  return (
                    <Row
                      key={t.symbol}
                      symbol={t.symbol}
                      label={t.label}
                      locked={gated}
                      active={selected === t.symbol}
                      onClick={() => {
                        if (gated) onUpgrade?.()
                        else onSelect(t.symbol)
                        onClose()
                      }}
                    />
                  )
                })}
            </Section>
          )}

          {filteredCurated.length === 0 && filteredWatchlist.length === 0 && (
            <p className="px-4 py-8 text-center text-subtle text-sm">
              No matches for "{query}"
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ label, children }) {
  return (
    <div className="mb-1">
      <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function Row({ symbol, label, starred, locked, live, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg transition border ${
        active
          ? 'bg-card border-amber-400/40'
          : 'hover:bg-card border-transparent'
      }`}
    >
      <div className="w-3 flex justify-center">
        {starred && <Star size={11} className="fill-amber-400 text-amber-400" />}
        {!starred && live && (
          <span
            className="block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"
            aria-label="Real-time"
          />
        )}
        {locked && <Lock size={11} className="text-muted" />}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={`text-sm font-mono-tab font-medium ${
            locked ? 'text-subtle' : 'text-fg'
          }`}
        >
          {symbol}
        </div>
        <div className="text-xs text-muted truncate">{label}</div>
      </div>
      {active && (
        <span className="text-amber-400 text-xs leading-none" aria-hidden>
          ●
        </span>
      )}
    </button>
  )
}
