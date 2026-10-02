"""In-memory broker: records orders, fills a working order once its
limit reaches ``fill_at`` (per option symbol). Never touches a network."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Sequence

from ..models import OptionQuote
from .base import Balances, BrokerPosition, LimitOrder, OrderStatus


@dataclass
class _Working:
    order: LimitOrder
    price: float
    state: str = "open"
    filled: int = 0


@dataclass
class DryRunBroker:
    chains: dict[tuple[str, date], list[OptionQuote]] = field(default_factory=dict)
    fill_at: dict[str, float] = field(default_factory=dict)   # option_symbol → price that fills
    balances: Balances = field(default_factory=lambda: Balances(0.0, 0.0))
    positions: list[BrokerPosition] = field(default_factory=list)
    orders: dict[str, _Working] = field(default_factory=dict)
    log: list[dict] = field(default_factory=list)

    def get_expirations(self, symbol: str) -> list[date]:
        return sorted({exp for (s, exp) in self.chains if s == symbol})

    def get_chain(self, symbol: str, expiration: date) -> list[OptionQuote]:
        return list(self.chains.get((symbol, expiration), []))

    def place_limit_order(self, account_id: str, order: LimitOrder) -> str:
        oid = f"dry-{len(self.orders) + 1}"
        self.orders[oid] = _Working(order, order.limit_price)
        self.log.append({"op": "place", "order_id": oid, "account_id": account_id, "type": "limit",
                         "price": order.limit_price, "side": order.side, "quantity": order.quantity,
                         "symbol": order.option_symbol})
        self._maybe_fill(oid)
        return oid

    def modify_order(self, account_id: str, order_id: str, limit_price: float) -> None:
        w = self.orders[order_id]
        w.price = limit_price
        self.log.append({"op": "modify", "order_id": order_id, "price": limit_price})
        self._maybe_fill(order_id)

    def cancel_order(self, account_id: str, order_id: str) -> None:
        w = self.orders[order_id]
        if w.state != "filled":
            w.state = "canceled"
        self.log.append({"op": "cancel", "order_id": order_id})

    def get_order(self, account_id: str, order_id: str) -> OrderStatus:
        w = self.orders[order_id]
        state = w.state if w.state in ("filled", "canceled") else "open"
        return OrderStatus(order_id, state, w.filled, w.price if w.filled else None)

    def get_balances(self, account_id: str) -> Balances:
        return self.balances

    def get_positions(self, account_id: str) -> Sequence[BrokerPosition]:
        return list(self.positions)

    def _maybe_fill(self, order_id: str) -> None:
        w = self.orders[order_id]
        target = self.fill_at.get(w.order.option_symbol)
        if target is None or w.state != "open":
            return
        ok = w.price >= target if w.order.side == "buy_to_open" else w.price <= target
        if ok:
            w.state, w.filled = "filled", w.order.quantity
