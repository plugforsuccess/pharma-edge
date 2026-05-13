// Shared LogSignal prefill builder.
//
// Used by:
//   * SuggestedPlays (per-ticker Claude card) — passes ticker + spot
//     + regime + claudeCallId + the other plays from the same call.
//   * TodaysPlaysFeed (cross-ticker scanner feed) — passes ticker
//     (attached to each play by the scanner), spot (from the play
//     row), regime (null — different per ticker), claudeCallId
//     (also per play), and the rest of the feed as otherPlays.
//
// LogSignal reads location.state.prefill exclusively, so the shape
// below is the contract.

const PLAY_TYPE_TO_PREFILL = {
  BULL_CALL:        { direction: 'long_call', structure: 'bull_call_spread' },
  BEAR_PUT:         { direction: 'long_put',  structure: 'bear_put_spread' },
  IRON_CONDOR:      { direction: 'watch',     structure: 'iron_condor' },
  BULL_PUT_CREDIT:  { direction: 'long_call', structure: 'bull_put_credit' },
  BEAR_CALL_CREDIT: { direction: 'long_put',  structure: 'bear_call_credit' },
}

export function logAsSignal(navigate, play, ticker, spot, regime, attribution = {}) {
  const { claudeCallId = null, otherPlays = [] } = attribution
  const mapped = PLAY_TYPE_TO_PREFILL[play.type] || PLAY_TYPE_TO_PREFILL.BEAR_PUT
  const isDebit = play.type === 'BULL_CALL' || play.type === 'BEAR_PUT'
  const dollarBasis = isDebit
    ? Number(play.max_loss_per_spread)
    : Number(play.max_profit_per_spread)
  const premiumPerShare =
    Number.isFinite(dollarBasis) && dollarBasis > 0
      ? (dollarBasis / 100).toFixed(2)
      : null
  navigate('/log', {
    state: {
      prefill: {
        signal_source: 'gex_flow',
        ticker,
        stock_price_at_signal: spot != null ? String(spot) : '',
        catalyst_type: 'other',
        direction: mapped.direction,
        structure: mapped.structure,
        suggested_play_type: play.type,
        entry_pop_bp: play.entry_pop_bp ?? null,
        thesis: play.rationale ? `GEX-driven setup: ${play.rationale}` : '',
        long_strike: play.long_strike,
        short_strike: play.short_strike,
        expiry_date: play.expiration,
        premium: premiumPerShare,
        target_king_node: play.target_king_node ?? null,
        target_strike: play.target_strike ?? null,
        target_expiration: play.target_expiration ?? null,
        target_thesis_kind: play.target_thesis_kind ?? null,
        regime_at_entry: regime ?? null,
        originating_claude_call_id: claudeCallId,
        claude_chosen_play: play,
        claude_other_plays: otherPlays,
      },
    },
  })
}
