// Feature switches for surfaces hidden from the MVP (2026-10-02).
//
// LEAPS drives the product now: Home · Positions · Simulator · Research
// · Pulse. These surfaces are hidden indefinitely but their code is
// kept so they can come back as upsells. Flip a flag to true to restore
// the route and every entry point that links to it.
//
//   wheel        — /wheel, /picks and the suggested-wheel card on Pulse
//   logMove      — /log (Log a Move) and every "Log Signal" button
//   signalDetail — /signal/:id (and notification deep links to it)
//   playDetail   — /play/:id (Claude play detail)
//   flow         — /flow (old whale-tail bot feed, admin only)
//   leaderboard  — /leaderboard (ranks spread trades logged via /log)
export const FEATURES = Object.freeze({
  wheel: false,
  logMove: false,
  signalDetail: false,
  playDetail: false,
  flow: false,
  leaderboard: false,
})
