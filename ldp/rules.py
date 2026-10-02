"""Daily sell rules — priority order, first match wins.

  1. Stop / thesis broken → sell now, regardless of holding period or
     tax. Triggers: price stop, a "broken" thesis flag from the research
     tool, or a satellite hard-reject condition appearing (runway under
     the minimum; a binary event inside the blackout when the user
     hasn't allowed catalyst plays).
  2. Roll window: under ``exits.roll_dte_days`` to expiration → roll to
     a new contract that passes contract selection; if none passes, sell.
  3. Profit target hit at the rate that applies today → sell that rung.
  4. Hold for long-term: short-term, in profit, thesis intact, and within
     ``exits.ltcg_wait_days`` of turning long-term → hold, showing days
     until long-term and tax saved by waiting
     (= gain × (short_term_rate − long_term_rate)).
  5. Rotation: core position whose sector dropped out of the top tier at
     the annual review → sell and rotate.

Risk always beats tax: rules 1 and 2 run before any tax consideration,
so a broken position is never held to reach long-term rates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Callable, Literal, Sequence

from . import ladder as ladder_mod
from .config import LDPConfig, rung_fractions
from .contracts import FilterResult, select_contract
from .models import OptionQuote, Position
from .satellite import SatelliteCandidate, binary_events_in_blackout, runway_months
from .tax import Character, character, days_until_long_term, long_term_start

Action = Literal["sell_all", "roll", "sell_rung", "hold_for_long_term", "rotate", "hold"]

# rate_source(gain, character) → blended tax rate on that gain.
RateSource = Callable[[float, Character], float]


@dataclass(frozen=True)
class SellDecision:
    action: Action
    rule: int                      # 1–5, 0 = no rule fired (plain hold)
    rule_name: str
    contracts: int                 # contracts to sell (0 for holds)
    reason: str
    character_today: Character
    rates: dict
    ladder: list[dict]
    rungs: tuple[int, ...] = ()
    replacement: FilterResult | None = None
    days_until_long_term: int | None = None
    long_term_date: date | None = None
    tax_saved_by_waiting: float | None = None
    details: dict = field(default_factory=dict)

    def to_record(self) -> dict:
        return {
            "action": self.action,
            "rule": self.rule,
            "rule_name": self.rule_name,
            "contracts": self.contracts,
            "reason": self.reason,
            "character_today": self.character_today,
            "rates": self.rates,
            "ladder": self.ladder,
            "rungs": list(self.rungs),
            "replacement": None if self.replacement is None else self.replacement.to_record(),
            "days_until_long_term": self.days_until_long_term,
            "long_term_date": None if self.long_term_date is None else self.long_term_date.isoformat(),
            "tax_saved_by_waiting": None if self.tax_saved_by_waiting is None else round(self.tax_saved_by_waiting, 2),
            "details": self.details,
        }


def evaluate_position(
    pos: Position,
    *,
    today: date,
    rate_source: RateSource,
    cfg: LDPConfig,
    satellite: SatelliteCandidate | None = None,
    allow_catalyst_plays: bool = False,
    roll_chain: Sequence[OptionQuote] = (),
    annual_review: bool = False,
    top_tier_sectors: frozenset[str] | None = None,
    ladder_targets: Sequence[float] | None = None,
    ladder_fractions: Sequence[float] | None = None,
) -> SellDecision:
    ex = cfg.exits
    char = character(pos.instrument_type, pos.acquired, today)
    gain = pos.gain
    in_profit = gain > 0

    lt_rate = rate_source(max(gain, 0), "long_term")
    st_rate = rate_source(max(gain, 0), "short_term")
    rates = {"long_term": lt_rate, "short_term": st_rate, "today": rate_source(max(gain, 0), char)}

    targets = tuple(ladder_targets or ex.ladder)
    fractions = tuple(ladder_fractions or rung_fractions(ex))
    rungs = ladder_mod.build_ladder(
        basis=pos.basis_per_contract * pos.original_contracts,
        targets=targets,
        fractions=fractions,
        original_contracts=pos.original_contracts,
        rate_at_gain=lambda g: rate_source(g, char),
    )
    ladder = [r.to_record() for r in rungs]

    lt_info: dict = {}
    if char != "section_1256":
        days = days_until_long_term(pos.acquired, today)
        lt_info = {"days_until_long_term": days, "long_term_date": long_term_start(pos.acquired)}
        if char == "short_term" and in_profit:
            lt_info["tax_saved_by_waiting"] = gain * (st_rate - lt_rate)

    def decide(action: Action, rule: int, name: str, contracts: int, reason: str, **kw) -> SellDecision:
        return SellDecision(action, rule, name, contracts, reason, char, rates, ladder, **lt_info, **kw)

    # ── 1. Stop / thesis broken ─────────────────────────────────────
    stop_price = pos.entry_price * (1 - ex.stop_loss_pct)
    if pos.mark <= stop_price:
        return decide("sell_all", 1, "price_stop", pos.contracts_open,
                      f"mark {pos.mark:.2f} ≤ stop {stop_price:.2f} ({ex.stop_loss_pct:.0%} below entry)")
    if pos.thesis_status == "broken":
        return decide("sell_all", 1, "thesis_broken", pos.contracts_open, "research tool flagged the thesis as broken")
    if pos.sleeve == "satellite" and satellite is not None:
        sc = cfg.satellite
        rw = runway_months(satellite.cash, satellite.quarterly_burn)
        if rw < sc.min_runway_months:
            return decide("sell_all", 1, "satellite_hard_reject", pos.contracts_open,
                          f"cash runway fell to {rw:.1f} mo (< {sc.min_runway_months:g})")
        if sc.sell_on_blackout_catalyst and not allow_catalyst_plays:
            events = binary_events_in_blackout(satellite, today, sc)
            if events:
                k = events[0]
                return decide("sell_all", 1, "satellite_hard_reject", pos.contracts_open,
                              f"binary {k.kind} on {k.on.isoformat()} inside {sc.catalyst_blackout_days}d blackout; "
                              "catalyst plays not allowed")

    # ── 2. Roll window ──────────────────────────────────────────────
    dte = pos.dte(today)
    if dte is not None and dte < ex.roll_dte_days:
        best, results = select_contract(roll_chain, pos.sleeve, today, cfg.contracts)
        if best is not None:
            return decide("roll", 2, "roll", pos.contracts_open,
                          f"{dte} DTE < {ex.roll_dte_days}; rolling to {best.quote.symbol}",
                          replacement=best, details={"dte": dte, "candidates_checked": len(results)})
        return decide("sell_all", 2, "roll_no_contract", pos.contracts_open,
                      f"{dte} DTE < {ex.roll_dte_days} and no replacement passes contract filters",
                      details={"dte": dte, "candidates_checked": len(results),
                               "rejects": [r.to_record() for r in results[:20]]})

    # ── 3. Profit target ────────────────────────────────────────────
    hit = ladder_mod.rungs_hit(rungs, pos.multiple, pos.rungs_filled)
    if hit:
        n = min(pos.contracts_open, sum(r.contracts for r in hit))
        idx = tuple(r.index for r in hit)
        return decide("sell_rung", 3, "profit_target", n,
                      f"{pos.multiple:.2f}x ≥ rung exit {hit[-1].exit_multiple:.2f}x at {rates['today']:.2%} ({char})",
                      rungs=idx)

    # ── 4. Hold for long-term ───────────────────────────────────────
    if (char == "short_term" and in_profit and pos.thesis_status == "intact"
            and lt_info["days_until_long_term"] <= ex.ltcg_wait_days):
        return decide("hold_for_long_term", 4, "hold_for_long_term", 0,
                      f"{lt_info['days_until_long_term']} days until long-term; waiting saves "
                      f"${lt_info['tax_saved_by_waiting']:,.0f} (estimate)")

    # ── 5. Rotation ─────────────────────────────────────────────────
    if pos.sleeve == "core" and annual_review and top_tier_sectors is not None and pos.sector not in top_tier_sectors:
        return decide("rotate", 5, "rotation", pos.contracts_open,
                      f"sector {pos.sector} dropped out of the top tier at the annual review")

    return decide("hold", 0, "hold", 0, "no sell rule fired")


def fixed_rates(long_term: float, short_term: float) -> RateSource:
    """Rate source for CPA-provided flat rates (and tests)."""
    def src(_gain: float, char: Character) -> float:
        if char == "section_1256":
            return 0.6 * long_term + 0.4 * short_term
        return long_term if char == "long_term" else short_term
    return src


def profile_rates(profile, tax_year) -> RateSource:
    from .tax import tax_on_gain

    def src(gain: float, char: Character) -> float:
        g = max(gain, 1.0)
        return tax_on_gain(profile, tax_year, g, char).blended_rate
    return src
