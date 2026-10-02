"""Broker interface. Limit orders only — there is deliberately no way to
express a market order."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal, Protocol, Sequence

from ..models import OptionQuote

OrderState = Literal["pending", "open", "partially_filled", "filled", "canceled", "rejected", "expired"]


@dataclass(frozen=True)
class LimitOrder:
    underlying: str
    option_symbol: str
    side: Literal["buy_to_open", "sell_to_close"]
    quantity: int
    limit_price: float
    duration: str = "day"
    tag: str | None = None

    def __post_init__(self) -> None:
        if self.quantity < 1:
            raise ValueError("quantity must be ≥ 1")
        if not (self.limit_price > 0):
            raise ValueError("limit orders need a positive limit price")


@dataclass(frozen=True)
class OrderStatus:
    order_id: str
    state: OrderState
    filled_quantity: int
    avg_fill_price: float | None


@dataclass(frozen=True)
class Balances:
    total_equity: float
    cash: float


@dataclass(frozen=True)
class BrokerPosition:
    symbol: str
    quantity: float
    cost_basis: float
    date_acquired: date | None


class Broker(Protocol):
    def get_expirations(self, symbol: str) -> list[date]: ...
    def get_chain(self, symbol: str, expiration: date) -> list[OptionQuote]: ...
    def place_limit_order(self, account_id: str, order: LimitOrder) -> str: ...
    def modify_order(self, account_id: str, order_id: str, limit_price: float) -> None: ...
    def cancel_order(self, account_id: str, order_id: str) -> None: ...
    def get_order(self, account_id: str, order_id: str) -> OrderStatus: ...
    def get_balances(self, account_id: str) -> Balances: ...
    def get_positions(self, account_id: str) -> Sequence[BrokerPosition]: ...
