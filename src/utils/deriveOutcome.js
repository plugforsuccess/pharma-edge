// Derive an outcome prefill from execution data the system already
// has. Everything the user used to type by hand (P&L, exit price,
// "what happened") is reconstructable from:
//
//   - order_history close fills      → exit_price, pnl_dollars
//   - auto_triggers executed rows    → catalyst_result, thesis_correct
//   - open_positions entry math      → entry_debit_per_spread, contracts
//   - signals.checklist_*            → rules_followed (attested at entry)
//
// The only thing genuinely human is `post_trade_notes` — the
// "lessons learned" reflection. That's the field the modal still
// asks for; everything else gets pre-filled and the user just
// confirms (or taps "Edit details" to fall through to the manual
// 3-step flow if anything looks wrong).
//
// Returns null when the prefill can't be derived with confidence:
//   - No closed position linked to the signal (e.g. watch-only)
//   - No filled close orders (paper trade with no broker record)
//   - Credit spread (entry_debit_per_spread sign convention not yet
//     unified — same as the P&L gap called out in
//     AUTO_TRADE_MANAGEMENT.md §10.2)
//
// Falling back to null is intentional — better to drop into the
// manual flow than auto-fill a guess that might be wrong.

import { supabase } from '../lib/supabase'

// Translates auto_triggers.kind → outcome category + thesis correctness.
// Matches the SPREAD_OUTCOMES list in LogOutcomeModal. Keep in sync.
function categoryFromTriggerKind(kind, lastVerdictReasons) {
  switch (kind) {
    case 'stop_loss_50':
      return { catalyst_result: 'stop_loss', thesis_correct: false }
    case 'profit_take_100':
    case 'profit_take_200':
      return { catalyst_result: 'profit_target_hit', thesis_correct: true }
    case 'thesis_invalidated': {
      // Refine the category using the verdict reasons cached on the
      // position. "Regime flipped" is its own dedicated entry in the
      // outcomes list; everything else falls back to "wall broke
      // against thesis" (the generic invalidation case).
      const reasonsText = (lastVerdictReasons ?? []).join(' ').toLowerCase()
      if (reasonsText.includes('regime flipped')) {
        return { catalyst_result: 'regime_flipped', thesis_correct: false }
      }
      return { catalyst_result: 'wall_broken_against', thesis_correct: false }
    }
    default:
      return { catalyst_result: 'other', thesis_correct: null }
  }
}

export async function deriveOutcomePrefill(signalId) {
  if (!signalId) return null

  // The linked position. We need its id, entry_debit_per_spread,
  // contracts (original), strategy_type, and the cached verdict for
  // the thesis_invalidated → "regime flipped" / "wall broke" refinement.
  const { data: pos, error: posErr } = await supabase
    .from('open_positions')
    .select('id, strategy_type, entry_debit_per_spread, contracts, contracts_remaining, status, closed_at, last_verdict, last_verdict_reasons')
    .eq('signal_id', signalId)
    .maybeSingle()
  if (posErr || !pos) return null

  // Phase 1: debit spreads only. Credit spreads inherit the
  // entry_debit_per_spread sign convention issue from elsewhere in
  // the codebase — until that's unified, defer to the manual flow.
  const strat = (pos.strategy_type ?? '').toLowerCase()
  const isDebit = strat === 'bull_call_spread' || strat === 'bear_put_spread'
  if (!isDebit) return null

  const entry = Number(pos.entry_debit_per_spread)
  if (!Number.isFinite(entry) || entry <= 0) return null

  // Every close-side fill for this position. We aggregate to get
  // the weighted-average exit price + total P&L. Includes BOTH
  // auto-triggered closes AND manual closes the user submitted via
  // PlaceOrderPanel/Tastytrade UI — the table is the system of
  // record either way.
  const { data: closes, error: closesErr } = await supabase
    .from('order_history')
    .select('id, contracts, filled_price, filled_at, status')
    .eq('position_id', pos.id)
    .eq('order_type', 'close')
    .eq('status', 'filled')
    .order('filled_at', { ascending: true })
  if (closesErr) return null

  const filledCloses = (closes ?? []).filter(
    (c) => Number.isFinite(Number(c.filled_price)) && Number(c.contracts) > 0,
  )

  // Weighted-average exit price + total P&L across ALL close fills
  // (covers partial scale-outs). Null when there are no broker
  // fills on record (paper trade, manual entry, etc.) — falls back
  // to the manual modal.
  let exit_price = null
  let pnl_dollars = null
  let total_contracts_closed = 0
  if (filledCloses.length > 0) {
    let weightedSum = 0
    let pnlSum = 0
    for (const c of filledCloses) {
      const p = Number(c.filled_price)
      const n = Number(c.contracts)
      weightedSum += p * n
      pnlSum += (p - entry) * n * 100
      total_contracts_closed += n
    }
    if (total_contracts_closed > 0) {
      exit_price = weightedSum / total_contracts_closed
      pnl_dollars = pnlSum
    }
  }

  const pnl_percent =
    exit_price != null && entry > 0
      ? ((exit_price - entry) / entry) * 100
      : null

  // The most recent executed auto-trigger drives the outcome
  // category. We sort DESC and take the first one — if both a
  // profit_take_100 AND a profit_take_200 fired, the +200% trigger
  // is the more meaningful "what closed me out" signal.
  const { data: trig } = await supabase
    .from('auto_triggers')
    .select('kind, reason, executed_at')
    .eq('position_id', pos.id)
    .eq('status', 'executed')
    .order('executed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let category
  if (trig?.kind) {
    category = categoryFromTriggerKind(trig.kind, pos.last_verdict_reasons)
  } else {
    // No auto-trigger executed — position closed manually via the
    // broker UI or PlaceOrderPanel. We can still pre-fill the P&L
    // numbers, but the user picks the category. Most common manual
    // close = "Other" with no thesis_correct prejudice.
    category = { catalyst_result: 'other', thesis_correct: null }
  }

  // Rules-followed: the user attested to all 10 checklist items at
  // entry. We don't ask them again — pull the checklist columns off
  // the signal and AND them together.
  const { data: sig } = await supabase
    .from('signals')
    .select('checklist_read_sources, checklist_thesis_defined, checklist_invalidation_known, checklist_position_sized, checklist_spread_used, checklist_dte_checked, checklist_two_signals, checklist_not_at_highs, checklist_exit_planned, checklist_loss_accepted')
    .eq('id', signalId)
    .maybeSingle()
  const checklistKeys = sig ? Object.keys(sig) : []
  const rules_followed = checklistKeys.length > 0
    ? checklistKeys.every((k) => sig[k] === true)
    : null

  return {
    catalyst_result: category.catalyst_result,
    thesis_correct: category.thesis_correct,
    exit_price,
    pnl_dollars,
    pnl_percent,
    exit_reason: trig?.kind ? 'auto_trigger' : 'manual',
    rules_followed,
    // Surface the trigger details so the UI can render a
    // "we detected this because…" subtitle without re-fetching.
    _meta: {
      triggered_by_kind: trig?.kind ?? null,
      triggered_by_reason: trig?.reason ?? null,
      total_contracts_closed,
      original_contracts: pos.contracts,
      position_id: pos.id,
      strategy_type: pos.strategy_type,
    },
  }
}
