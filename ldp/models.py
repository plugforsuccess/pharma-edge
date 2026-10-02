"""Shared value types for the LDP engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Literal

RiskTier = Literal["conservative", "moderate", "aggressive"]
AccountTier = Literal["managed", "self_directed"]
Sleeve = Literal["core", "satellite"]
InstrumentType = Literal["equity_option", "index_option_1256", "stock"]
ThesisStatus = Literal["intact", "broken", "unknown"]
FilingStatus = Literal["single", "mfj", "mfs", "hoh"]

RISK_TIERS: tuple[RiskTier, ...] = ("conservative", "moderate", "aggressive")


@dataclass(frozen=True)
class Account:
    account_id: str
    user_id: str
    # Auto-trading on a user's behalf is allowed only for "managed".
    tier: AccountTier
    value: float          # net liquidation value
    cash: float           # sweep / money-market balance available to buy


@dataclass(frozen=True)
class OptionQuote:
    """One option contract as seen in a chain snapshot."""

    symbol: str            # OCC symbol, e.g. XLK270115C00200000
    underlying: str
    option_type: Literal["call", "put"]
    strike: float
    expiration: date
    bid: float | None
    ask: float | None
    delta: float | None
    open_interest: int | None
    iv: float | None = None
    # IV rank (0–100) of the UNDERLYING, supplied by the market-data
    # layer — brokers don't return it in chains.
    iv_rank: float | None = None

    @property
    def mid(self) -> float | None:
        if self.bid is None or self.ask is None or self.bid < 0 or self.ask <= 0 or self.ask < self.bid:
            return None
        return (self.bid + self.ask) / 2

    @property
    def contract_cost(self) -> float | None:
        """Dollar cost of one contract at the ask (the worst limit we'd pay)."""
        return None if self.ask is None else self.ask * 100


@dataclass(frozen=True)
class Position:
    """An open LDP position (one contract line, or stock after exercise)."""

    position_id: str
    user_id: str
    ticker: str
    sleeve: Sleeve
    instrument_type: InstrumentType
    contract_symbol: str | None
    expiration: date | None
    original_contracts: int
    contracts_open: int
    basis_per_contract: float      # dollars paid per contract (premium × 100 + fees)
    entry_price: float             # per-share option price paid (for the price stop)
    mark: float                    # current per-share option price
    acquired: date                 # holding period starts the day after this date
    thesis_status: ThesisStatus = "intact"
    sector: str | None = None      # core: the sector ETF ticker
    rungs_filled: frozenset[int] = field(default_factory=frozenset)

    @property
    def basis(self) -> float:
        return self.basis_per_contract * self.contracts_open

    @property
    def current_value(self) -> float:
        return self.mark * 100 * self.contracts_open

    @property
    def gain(self) -> float:
        return self.current_value - self.basis

    @property
    def multiple(self) -> float:
        return (self.mark * 100) / self.basis_per_contract

    def dte(self, today: date) -> int | None:
        return None if self.expiration is None else (self.expiration - today).days
