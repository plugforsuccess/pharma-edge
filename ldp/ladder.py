"""Exit ladder — the LEAPS playbook, per position.

Targets are gains on the OPTION before tax (taxes come after the plan):

    exit_multiple = 1 + target          (target 1.0 = +100% → 2.0x basis)
    exit_value    = basis × exit_multiple

Each target sells its share of the ORIGINAL position (default 70% at
+100%, then 15% — half of what's left — at +200%). The shares may total
less than 1; the rest is the runner, which trails (see rules.py). Shares
are allocated in whole contracts by largest remainder across the targets
AND the runner, so everything always adds up to the full position.

For the audit and the UI each rung also carries what the sale would keep
after tax at the rate that applies if sold today:

    realized_gain      = (rung contracts ÷ original) × (exit_value − basis)
    estimated_tax      = realized_gain × rate_at_gain(realized_gain)
    after_tax_proceeds = rung share × exit_value − estimated_tax
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Sequence


@dataclass(frozen=True)
class Rung:
    index: int
    target: float              # pre-tax gain multiple of basis (1.0 = +100%)
    fraction: float            # share of the original position this rung sells
    contracts: int
    exit_value: float          # whole-position value at the target
    exit_multiple: float
    rate: float                # tax rate on this sale if sold today
    estimated_tax: float
    after_tax_proceeds: float

    def to_record(self) -> dict:
        return {
            "index": self.index,
            "target": self.target,
            "fraction": round(self.fraction, 6),
            "contracts": self.contracts,
            "exit_value": round(self.exit_value, 2),
            "exit_multiple": round(self.exit_multiple, 4),
            "rate": round(self.rate, 6),
            "estimated_tax": round(self.estimated_tax, 2),
            "after_tax_proceeds": round(self.after_tax_proceeds, 2),
        }


def allocate_contracts(total: int, fractions: Sequence[float]) -> list[int]:
    """Largest remainder; ties go to the earlier entry (remainders are
    rounded so float noise never decides a tie)."""
    raw = [total * f for f in fractions]
    base = [math.floor(x + 1e-9) for x in raw]
    left = total - sum(base)
    order = sorted(range(len(raw)), key=lambda i: (-round(raw[i] - base[i], 9), i))
    for i in order[:left]:
        base[i] += 1
    return base


def runner_fraction(fractions: Sequence[float]) -> float:
    return max(0.0, 1.0 - sum(fractions))


def allocate_with_runner(total: int, fractions: Sequence[float]) -> tuple[list[int], int]:
    """Whole contracts per rung, plus the runner's contracts. The runner
    is last, so a tie sells rather than holds (holding winners too long
    is the weak spot the playbook guards against)."""
    runner = runner_fraction(fractions)
    if runner <= 1e-9:
        return allocate_contracts(total, fractions), 0
    alloc = allocate_contracts(total, [*fractions, runner])
    return alloc[:-1], alloc[-1]


def build_ladder(
    *,
    basis: float,
    targets: Sequence[float],
    fractions: Sequence[float],
    original_contracts: int,
    rate_at_gain: Callable[[float], float],
) -> list[Rung]:
    """``rate_at_gain(gain)`` returns the blended rate that applies if the
    sale happened today with that realized gain."""
    if basis <= 0:
        raise ValueError("basis must be > 0")
    if original_contracts < 1:
        raise ValueError("original_contracts must be ≥ 1")
    contracts, _runner = allocate_with_runner(original_contracts, fractions)
    rungs: list[Rung] = []
    for i, (t, f) in enumerate(zip(targets, fractions)):
        exit_multiple = 1 + t
        exit_value = basis * exit_multiple
        share = contracts[i] / original_contracts
        realized = share * (exit_value - basis)
        rate = rate_at_gain(realized) if realized > 0 else 0.0
        if not (0 <= rate < 1):
            raise ValueError(f"tax rate {rate} out of range")
        tax = realized * rate if realized > 0 else 0.0
        rungs.append(Rung(i, t, f, contracts[i], exit_value, exit_multiple, rate, tax, share * exit_value - tax))
    return rungs


def rungs_hit(rungs: Sequence[Rung], current_multiple: float, done: frozenset[int]) -> list[Rung]:
    """Rungs at or past their target that still need selling. ``done`` =
    rungs already filled or with a resting broker order (e.g. the GTC
    Target 1 order placed at entry) — the broker fills those itself."""
    return [r for r in rungs if r.index not in done and r.contracts > 0 and current_multiple >= r.exit_multiple - 1e-9]


def all_targets_done(rungs: Sequence[Rung], filled: frozenset[int]) -> bool:
    """Every rung that sells something has filled — only the runner is left."""
    return all(r.index in filled for r in rungs if r.contracts > 0)
