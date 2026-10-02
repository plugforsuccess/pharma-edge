"""Position sizing — satellite caps and core budget → whole contracts.

Satellite caps (every tier that allows satellites):
  * per name: ``satellite.max_per_name`` × account value at buy
  * total:    ``satellite.max_total``    × account value
A buy that would break either cap is shrunk to fit. If the shrunk order
can't buy one whole contract, the buy is skipped.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .config import SatelliteConfig


@dataclass(frozen=True)
class SizingResult:
    requested_dollars: float
    allowed_dollars: float      # after caps and cash
    contract_cost: float
    contracts: int
    cost: float                 # contracts × contract_cost
    skipped: bool
    reason: str | None
    caps: dict

    def to_record(self) -> dict:
        return dict(self.__dict__)


def _cents(x: float) -> float:
    # Cap arithmetic in cents: 0.05 × 100_000 must be exactly $5,000.
    return round(x + 0.0, 2)


def size_satellite(
    *,
    requested_dollars: float,
    contract_cost: float,
    account_value: float,
    existing_satellite_total: float,
    existing_in_name: float = 0.0,
    available_cash: float | None = None,
    cfg: SatelliteConfig,
) -> SizingResult:
    per_name_cap = _cents(cfg.max_per_name * account_value)
    total_cap = _cents(cfg.max_total * account_value)
    per_name_room = max(0.0, _cents(per_name_cap - existing_in_name))
    total_room = max(0.0, _cents(total_cap - existing_satellite_total))
    limits = {"requested": requested_dollars, "per_name_room": per_name_room, "total_room": total_room}
    if available_cash is not None:
        limits["cash"] = max(0.0, available_cash)
    allowed = _cents(min(limits.values()))
    binding = min(limits, key=limits.get) if allowed < requested_dollars else None
    caps = {
        "per_name_cap": per_name_cap,
        "total_cap": total_cap,
        "per_name_room": per_name_room,
        "total_room": total_room,
        "binding": binding,
    }
    return _to_contracts(requested_dollars, allowed, contract_cost, caps, binding)


def size_core(*, budget_dollars: float, contract_cost: float, available_cash: float | None = None) -> SizingResult:
    allowed = budget_dollars if available_cash is None else min(budget_dollars, max(0.0, available_cash))
    binding = "cash" if allowed < budget_dollars else None
    return _to_contracts(budget_dollars, _cents(allowed), contract_cost, {"binding": binding}, binding)


def _to_contracts(requested: float, allowed: float, contract_cost: float, caps: dict, binding: str | None) -> SizingResult:
    if not (contract_cost > 0):
        return SizingResult(requested, allowed, contract_cost, 0, 0.0, True, "no valid contract price", caps)
    # Small epsilon so $1,000.00 / $1,000.00 is 1 contract, not 0.
    contracts = math.floor(allowed / contract_cost + 1e-9)
    if contracts < 1:
        reason = f"shrunk order ${allowed:,.2f} is under one contract (${contract_cost:,.2f})"
        return SizingResult(requested, allowed, contract_cost, 0, 0.0, True, reason, caps)
    reason = f"shrunk by {binding} cap" if binding else None
    return SizingResult(requested, allowed, contract_cost, contracts, _cents(contracts * contract_cost), False, reason, caps)
