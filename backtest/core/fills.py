"""Realistic fill model for the backtest harness.

Single-leg long: pay the ask × (1 + slippage_pct) on entry, sell the
bid × (1 - slippage_pct) on exit.

Credit verticals / iron condors: collect mid × (1 - slippage_pct) of
the net credit on entry, pay mid × (1 + slippage_pct) of the net debit
on exit. Models the worse-than-mid fill that real spreads get when
crossing the market.

Commissions: $0.65 per contract per leg (matches Tastytrade's $1 max
per leg cap closely enough). Iron condor entry = 4 × $0.65 = $2.60
per lot. Exit same.

slippage_pct defaults to 5% but should be overridden per-strategy:
  whale_tail   → 0.05 (single-leg long, decent fills)
  iv_meanrev   → 0.08 (4 legs cross spread x 2 directions)
  earnings     → 0.10 (event-day spread are typically wider)
  opex_pin     → 0.07 (4 legs on liquid indices)
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FillResult:
    fill_price: float
    commission: float


def commission_per_lot(num_legs: int) -> float:
    return 0.65 * num_legs


def long_entry(ask: float, slippage_pct: float = 0.05) -> FillResult:
    fill = ask * (1 + slippage_pct)
    return FillResult(fill_price=fill, commission=commission_per_lot(1))


def long_exit(bid: float, slippage_pct: float = 0.05) -> FillResult:
    fill = bid * (1 - slippage_pct)
    return FillResult(fill_price=max(0.0, fill), commission=commission_per_lot(1))


def credit_entry(net_credit_mid: float, num_legs: int, slippage_pct: float = 0.07) -> FillResult:
    # Get *less* credit than mid on entry
    fill = net_credit_mid * (1 - slippage_pct)
    return FillResult(fill_price=fill, commission=commission_per_lot(num_legs))


def credit_exit(net_debit_mid: float, num_legs: int, slippage_pct: float = 0.07) -> FillResult:
    # Pay *more* debit than mid on exit
    fill = net_debit_mid * (1 + slippage_pct)
    return FillResult(fill_price=fill, commission=commission_per_lot(num_legs))
