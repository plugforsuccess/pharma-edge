"""Contract selection — hard reject rules for core and satellites.

These are rejects, not score inputs. A contract must clear every one:
  * DTE at buy ≥ ``contracts.min_dte_days`` (target ``target_dte_days``)
  * |delta| inside the sleeve's band (core 0.70–0.80, satellite 0.60–0.80)
  * underlying IV rank ≤ ``max_iv_rank``
  * bid/ask spread ≤ ``max_spread_pct`` of mid
  * open interest ≥ ``min_open_interest``
Missing data is a reject too — we never buy what we can't measure.

Among passing contracts, the pick is the one closest to the target DTE,
then closest to the middle of the delta band, then the tightest spread.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Iterable

from .config import ContractConfig
from .models import OptionQuote, Sleeve


@dataclass(frozen=True)
class FilterResult:
    quote: OptionQuote
    sleeve: Sleeve
    passed: bool
    rejects: tuple[str, ...]
    values: dict

    def to_record(self) -> dict:
        return {
            "symbol": self.quote.symbol,
            "passed": self.passed,
            "rejects": list(self.rejects),
            "values": self.values,
        }


def delta_band(sleeve: Sleeve, cfg: ContractConfig) -> tuple[float, float]:
    if sleeve == "core":
        return cfg.core_delta_min, cfg.core_delta_max
    return cfg.satellite_delta_min, cfg.satellite_delta_max


def evaluate_contract(q: OptionQuote, sleeve: Sleeve, today: date, cfg: ContractConfig) -> FilterResult:
    rejects: list[str] = []
    dte = (q.expiration - today).days
    lo, hi = delta_band(sleeve, cfg)
    mid = q.mid
    spread_pct = None if mid in (None, 0) else (q.ask - q.bid) / mid
    abs_delta = None if q.delta is None else abs(q.delta)

    if dte < cfg.min_dte_days:
        rejects.append(f"dte {dte} < {cfg.min_dte_days}")
    if abs_delta is None:
        rejects.append("missing delta")
    elif not (lo <= abs_delta <= hi):
        rejects.append(f"delta {abs_delta:.2f} outside {lo:.2f}–{hi:.2f}")
    if q.iv_rank is None:
        if cfg.reject_missing_iv_rank:
            rejects.append("missing iv rank")
    elif q.iv_rank > cfg.max_iv_rank:
        rejects.append(f"iv rank {q.iv_rank:g} > {cfg.max_iv_rank:g}")
    if spread_pct is None:
        rejects.append("missing or crossed bid/ask")
    elif spread_pct > cfg.max_spread_pct:
        rejects.append(f"spread {spread_pct:.1%} of mid > {cfg.max_spread_pct:.0%}")
    if q.open_interest is None:
        rejects.append("missing open interest")
    elif q.open_interest < cfg.min_open_interest:
        rejects.append(f"open interest {q.open_interest} < {cfg.min_open_interest}")

    values = {
        "dte": dte,
        "target_dte": cfg.target_dte_days,
        "delta": abs_delta,
        "delta_band": [lo, hi],
        "iv_rank": q.iv_rank,
        "bid": q.bid,
        "ask": q.ask,
        "mid": mid,
        "spread_pct": None if spread_pct is None else round(spread_pct, 6),
        "open_interest": q.open_interest,
        "strike": q.strike,
        "expiration": q.expiration.isoformat(),
    }
    return FilterResult(q, sleeve, not rejects, tuple(rejects), values)


def select_contract(
    quotes: Iterable[OptionQuote], sleeve: Sleeve, today: date, cfg: ContractConfig,
    option_type: str = "call",
) -> tuple[FilterResult | None, list[FilterResult]]:
    results = [evaluate_contract(q, sleeve, today, cfg) for q in quotes if q.option_type == option_type]
    passing = [r for r in results if r.passed]
    if not passing:
        return None, results
    lo, hi = delta_band(sleeve, cfg)
    centre = (lo + hi) / 2

    def rank(r: FilterResult):
        return (abs(r.values["dte"] - cfg.target_dte_days), abs(r.values["delta"] - centre), r.values["spread_pct"])

    return min(passing, key=rank), results
