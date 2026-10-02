"""Backtester — replays daily marks through the sell rules.

Feeds one position's daily history (mark, thesis status, optional
satellite fundamentals snapshot, optional roll chain) through
``rules.evaluate_position`` exactly as the live daily check would, fills
sells at the day's mark, and reports realised gains with the tax that
applied on each sale (long-term, short-term, or §1256). Rolls close at
the mark and reopen the replacement at its ask, sized from proceeds,
with a fresh holding period.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from datetime import date
from typing import Sequence

from .config import LDPConfig
from .models import OptionQuote, Position, ThesisStatus
from .rules import RateSource, evaluate_position
from .satellite import SatelliteCandidate
from .tax import character


@dataclass(frozen=True)
class Day:
    on: date
    mark: float
    thesis_status: ThesisStatus = "intact"
    satellite: SatelliteCandidate | None = None
    roll_chain: Sequence[OptionQuote] = ()
    annual_review: bool = False
    top_tier_sectors: frozenset[str] | None = None


@dataclass(frozen=True)
class Fill:
    on: date
    action: str
    rule: str
    symbol: str | None
    contracts: int
    price: float
    gain: float
    character: str
    tax: float


@dataclass
class BacktestResult:
    fills: list[Fill] = field(default_factory=list)
    final_position: Position | None = None

    @property
    def realised_gain(self) -> float:
        return sum(f.gain for f in self.fills)

    @property
    def tax(self) -> float:
        return sum(f.tax for f in self.fills)

    @property
    def after_tax_gain(self) -> float:
        return self.realised_gain - self.tax


def run(position: Position, days: Sequence[Day], *, rate_source: RateSource, cfg: LDPConfig,
        allow_catalyst_plays: bool = False) -> BacktestResult:
    pos = position
    out = BacktestResult()
    for day in days:
        if pos.contracts_open <= 0:
            break
        pos = dataclasses.replace(pos, mark=day.mark, thesis_status=day.thesis_status,
                                  peak_mark=max(pos.peak_mark or day.mark, day.mark))
        d = evaluate_position(pos, today=day.on, rate_source=rate_source, cfg=cfg, satellite=day.satellite,
                              allow_catalyst_plays=allow_catalyst_plays, roll_chain=day.roll_chain,
                              annual_review=day.annual_review, top_tier_sectors=day.top_tier_sectors)
        if d.contracts <= 0:
            continue
        n = min(d.contracts, pos.contracts_open)
        gain = (day.mark * 100 - pos.basis_per_contract) * n
        ch = character(pos.instrument_type, pos.acquired, day.on)
        tax = max(0.0, gain) * rate_source(max(0.0, gain), ch)
        out.fills.append(Fill(day.on, d.action, d.rule_name, pos.contract_symbol, n, day.mark, gain, ch, tax))
        remaining = pos.contracts_open - n
        if d.action == "roll" and d.replacement is not None:
            q = d.replacement.quote
            proceeds = day.mark * 100 * n
            cost = q.contract_cost or 0
            new_n = int(proceeds // cost) if cost > 0 else 0
            if new_n >= 1:
                pos = dataclasses.replace(
                    pos, contract_symbol=q.symbol, expiration=q.expiration, original_contracts=new_n,
                    contracts_open=new_n, basis_per_contract=cost, entry_price=q.ask, mark=q.ask,
                    acquired=day.on, rungs_filled=frozenset(), rungs_resting=frozenset(), peak_mark=q.ask,
                )
                continue
            remaining = 0
        filled = pos.rungs_filled | frozenset(d.rungs) if d.action == "sell_rung" else pos.rungs_filled
        pos = dataclasses.replace(pos, contracts_open=remaining, rungs_filled=filled)
    out.final_position = pos
    return out
