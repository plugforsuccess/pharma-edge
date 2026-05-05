// Display helpers for signal/catalyst rendering. Color tokens themselves live
// in @theme in src/index.css so the values are reachable from Tailwind classes
// (bg-card, border-border, text-fg, text-subtle, text-muted).

export const signalColor = (direction) => {
  if (direction === 'long_put') return 'text-red-400 bg-red-950 border-red-800'
  if (direction === 'long_call') return 'text-green-400 bg-green-950 border-green-800'
  return 'text-zinc-400 bg-zinc-900 border-zinc-700'
}

// Direction enum stays {long_put, long_call, watch} for hash stability,
// but display labels reflect the actual structure used (spreads only —
// naked options are forbidden by the pre-trade checklist).
export const directionLabel = (direction) =>
  ({ long_put: 'PUT SPREAD', long_call: 'CALL SPREAD', watch: 'WATCH' }[direction] || direction)

export const directionLabelLong = (direction) =>
  ({ long_put: 'BEAR PUT SPREAD', long_call: 'BULL CALL SPREAD', watch: 'WATCH' }[direction] || direction)

export const catalystLabel = (type) =>
  ({
    pdufa: 'PDUFA Date',
    adcomm: 'AdComm Meeting',
    phase2_readout: 'Phase 2 Readout',
    phase3_readout: 'Phase 3 Readout',
    enrollment_end: 'Enrollment End',
    patent_expiry: 'Patent Expiry',
    earnings: 'Earnings',
    other: 'Catalyst',
  }[type] || 'Catalyst')

export function formatMarketCap(value) {
  if (value == null) return '—'
  const n = Number(value)
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toLocaleString()}`
}
