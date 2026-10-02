"""Allocator — the annual buy (and re-entry) plan for one user.

Core: the top-tier sectors split ``core.allocation_pct`` of account value
equally; each sector's budget is reduced by what's already held there.
Satellites: only for tiers that allow them, only candidates that passed
the satellite hard rejects + score floor, each sized to the per-name and
total caps. Every buy goes through the same contract filters.

Cash: buys never exceed the sweep balance. Whatever isn't deployed
stays in the sweep — the engine does not trade idle cash.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Mapping, Sequence

from .cadence import may_buy
from .config import LDPConfig
from .contracts import FilterResult, select_contract
from .models import Account, OptionQuote, Position, Sleeve
from .risk import Permission, RiskProfile, permission
from .satellite import SatelliteEvaluation, rank
from .scoring import SectorScore, top_tier
from .sizing import SizingResult, size_core, size_satellite


@dataclass(frozen=True)
class PlannedTrade:
    sleeve: Sleeve
    ticker: str
    contract: FilterResult
    sizing: SizingResult
    permission: Permission
    score: float | None
    score_components: dict | None
    thesis: str | None = None
    sources: tuple[str, ...] = ()


@dataclass(frozen=True)
class Skip:
    sleeve: Sleeve
    ticker: str
    reason: str
    contract_results: tuple[FilterResult, ...] = ()
    sizing: SizingResult | None = None


@dataclass
class BuyPlan:
    allowed: bool
    reason: str
    trades: list[PlannedTrade] = field(default_factory=list)
    skips: list[Skip] = field(default_factory=list)
    cash_start: float = 0.0
    cash_after: float = 0.0


def plan_buys(
    *,
    today: date,
    cfg: LDPConfig,
    account: Account,
    risk: RiskProfile,
    sector_scores: Sequence[SectorScore],
    satellite_evals: Sequence[SatelliteEvaluation],
    chains: Mapping[str, Sequence[OptionQuote]],
    positions: Sequence[Position],
    last_annual_buy: date | None,
    user_window_start: str | None = None,
    reentry: bool = False,
) -> BuyPlan:
    ok, why = may_buy(today, cfg.cadence, last_annual_buy=last_annual_buy,
                      user_window_start=user_window_start, reentry=reentry)
    plan = BuyPlan(ok, why, cash_start=account.cash, cash_after=account.cash)
    if not ok:
        return plan

    cash = account.cash
    held = [p for p in positions if p.contracts_open > 0]

    # ── Core ────────────────────────────────────────────────────────
    core_perm = permission("core", risk.tier, account.tier)
    tier1 = top_tier(sector_scores, cfg.core)
    per_sector = account.value * cfg.core.allocation_pct / cfg.core.top_n_sectors
    for s in tier1:
        existing = sum(p.basis for p in held if p.sleeve == "core" and p.sector == s.ticker)
        budget = round(per_sector - existing, 2)
        if budget <= 0:
            plan.skips.append(Skip("core", s.ticker, "sector already at its core allocation"))
            continue
        best, results = select_contract(chains.get(s.ticker, ()), "core", today, cfg.contracts)
        if best is None:
            plan.skips.append(Skip("core", s.ticker, "no contract passes the filters", tuple(results)))
            continue
        sz = size_core(budget_dollars=budget, contract_cost=best.quote.contract_cost or 0, available_cash=cash)
        if sz.skipped:
            plan.skips.append(Skip("core", s.ticker, sz.reason or "sizing", (best,), sz))
            continue
        plan.trades.append(PlannedTrade("core", s.ticker, best, sz, core_perm, s.score, s.components))
        cash -= sz.cost

    # ── Satellites ──────────────────────────────────────────────────
    sat_perm = permission("satellite", risk.tier, account.tier)
    if sat_perm.mode == "blocked":
        # Never traded or suggested at this tier.
        plan.cash_after = round(cash, 2)
        return plan

    sat_total = sum(p.basis for p in held if p.sleeve == "satellite")
    for ev in satellite_evals:
        if not ev.passed:
            plan.skips.append(Skip("satellite", ev.candidate.ticker, "; ".join(ev.rejects)))
    for ev in rank(satellite_evals):
        c = ev.candidate
        best, results = select_contract(chains.get(c.ticker, ()), "satellite", today, cfg.contracts)
        if best is None:
            plan.skips.append(Skip("satellite", c.ticker, "no contract passes the filters", tuple(results)))
            continue
        in_name = sum(p.basis for p in held if p.sleeve == "satellite" and p.ticker == c.ticker)
        sz = size_satellite(
            requested_dollars=cfg.satellite.max_per_name * account.value,
            contract_cost=best.quote.contract_cost or 0,
            account_value=account.value,
            existing_satellite_total=sat_total,
            existing_in_name=in_name,
            available_cash=cash,
            cfg=cfg.satellite,
        )
        if sz.skipped:
            plan.skips.append(Skip("satellite", c.ticker, sz.reason or "sizing", (best,), sz))
            continue
        plan.trades.append(PlannedTrade("satellite", c.ticker, best, sz, sat_perm, ev.score, ev.components,
                                        c.thesis, c.sources))
        cash -= sz.cost
        sat_total += sz.cost

    plan.cash_after = round(cash, 2)
    return plan
