"""After-tax exit ladder — per user, per position.

Each rung is an after-tax gain target as a multiple of basis (default
1.0x, 2.0x, 3.0x — 1.0x = double after tax):

    after_tax_gain_target = basis × target
    rate                  = rate that applies if sold today (LT, ST, or §1256)
    required_gain         = after_tax_gain_target ÷ (1 − rate)
    exit_value            = basis + required_gain
    exit_multiple         = exit_value ÷ basis

Recomputed daily: the applicable rate changes when the position crosses
into long-term, and with income or gain size (bracket stacking). Because
the rate depends on the gain and the gain on the rate, the required gain
is solved to a fixed point; on a bracket-boundary oscillation the larger
gain wins (conservative).

Each rung sells its assigned share of the ORIGINAL position (default
equal thirds), allocated in whole contracts by largest remainder so the
rungs always add up to the full position.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Sequence


@dataclass(frozen=True)
class Rung:
    index: int
    target: float
    fraction: float
    contracts: int
    after_tax_gain_target: float
    rate: float
    required_gain: float
    exit_value: float
    exit_multiple: float

    def to_record(self) -> dict:
        return {
            "index": self.index,
            "target": self.target,
            "fraction": round(self.fraction, 6),
            "contracts": self.contracts,
            "after_tax_gain_target": round(self.after_tax_gain_target, 2),
            "rate": round(self.rate, 6),
            "required_gain": round(self.required_gain, 2),
            "exit_value": round(self.exit_value, 2),
            "exit_multiple": round(self.exit_multiple, 4),
        }


def solve_required_gain(after_tax_target: float, rate_at_gain: Callable[[float], float]) -> tuple[float, float]:
    gain = after_tax_target
    worst = 0.0
    for _ in range(50):
        rate = rate_at_gain(gain)
        if not (0 <= rate < 1):
            raise ValueError(f"tax rate {rate} out of range")
        nxt = after_tax_target / (1 - rate)
        worst = max(worst, nxt)
        if abs(nxt - gain) < 0.005:
            return nxt, rate
        gain = nxt
    return worst, 1 - after_tax_target / worst


def allocate_contracts(total: int, fractions: Sequence[float]) -> list[int]:
    raw = [total * f for f in fractions]
    base = [math.floor(x + 1e-9) for x in raw]
    left = total - sum(base)
    order = sorted(range(len(raw)), key=lambda i: (-(raw[i] - base[i]), i))
    for i in order[:left]:
        base[i] += 1
    return base


def build_ladder(
    *,
    basis: float,
    targets: Sequence[float],
    fractions: Sequence[float],
    original_contracts: int,
    rate_at_gain: Callable[[float], float],
) -> list[Rung]:
    """``rate_at_gain(gain)`` returns the blended rate that applies if the
    position were sold today with that gain (whole-position gain — the
    conservative choice, since a larger gain never lowers the rate)."""
    if basis <= 0:
        raise ValueError("basis must be > 0")
    contracts = allocate_contracts(original_contracts, fractions)
    rungs: list[Rung] = []
    for i, (t, f) in enumerate(zip(targets, fractions)):
        target_gain = basis * t
        required, rate = solve_required_gain(target_gain, rate_at_gain)
        exit_value = basis + required
        rungs.append(Rung(i, t, f, contracts[i], target_gain, rate, required, exit_value, exit_value / basis))
    return rungs


def rungs_hit(rungs: Sequence[Rung], current_multiple: float, filled: frozenset[int]) -> list[Rung]:
    return [r for r in rungs if r.index not in filled and r.contracts > 0 and current_multiple >= r.exit_multiple - 1e-9]
