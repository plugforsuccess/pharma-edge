"""Limit-order execution. Never sends market orders.

Buys start at mid and step toward the ask by
``orders.step_pct_of_spread`` × spread each step; sells start at mid and
step toward the bid. Each price waits ``step_wait_seconds`` for a fill,
then the working order is repriced (modify, not cancel/replace, so
partial fills keep their place). After ``max_steps`` prices the order is
cancelled and whatever filled is reported.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Literal

from .brokers.base import Broker, LimitOrder, OrderStatus
from .config import OrderConfig

Side = Literal["buy_to_open", "sell_to_close"]


def _nearest_tick(price: float, tick: float) -> float:
    return round(round(price / tick) * tick, 2)


def price_ladder(bid: float, ask: float, side: Side, cfg: OrderConfig) -> list[float]:
    """Limit prices to try, in order. Each step is rounded to the nearest
    tick, then clamped inside [bid, ask] — a buy never bids above the ask
    and a sell never offers below the bid."""
    if not (ask > 0 and bid >= 0 and ask >= bid):
        raise ValueError(f"invalid quote bid={bid} ask={ask}")
    mid = (bid + ask) / 2
    step = cfg.step_pct_of_spread * (ask - bid)
    prices: list[float] = []
    for i in range(cfg.max_steps):
        raw = mid + i * step if side == "buy_to_open" else mid - i * step
        p = min(max(_nearest_tick(raw, cfg.tick_size), bid), ask)
        p = max(round(p, 2), cfg.tick_size)
        if not prices or p != prices[-1]:
            prices.append(p)
    return prices


@dataclass
class ExecutionResult:
    order_id: str | None
    status: Literal["filled", "partially_filled", "unfilled", "rejected"]
    requested: int
    filled: int
    avg_fill_price: float | None
    prices_tried: list[float] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)

    def to_record(self) -> dict:
        return dict(self.__dict__)


class LimitOrderExecutor:
    def __init__(self, broker: Broker, cfg: OrderConfig, *,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic):
        self.broker = broker
        self.cfg = cfg
        self.sleep = sleep
        self.clock = clock

    def execute(self, *, account_id: str, underlying: str, option_symbol: str, side: Side,
                quantity: int, bid: float, ask: float, tag: str | None = None) -> ExecutionResult:
        if quantity < 1:
            raise ValueError("quantity must be ≥ 1")
        prices = price_ladder(bid, ask, side, self.cfg)
        result = ExecutionResult(None, "unfilled", quantity, 0, None)
        order = LimitOrder(underlying=underlying, option_symbol=option_symbol, side=side,
                           quantity=quantity, limit_price=prices[0], duration=self.cfg.duration, tag=tag)
        try:
            order_id = self.broker.place_limit_order(account_id, order)
        except Exception as exc:  # broker rejected the order outright
            result.status = "rejected"
            result.events.append({"event": "rejected", "error": str(exc)})
            return result
        result.order_id = order_id
        status: OrderStatus | None = None
        for i, price in enumerate(prices):
            if i > 0:
                self.broker.modify_order(account_id, order_id, price)
                result.events.append({"event": "repriced", "price": price})
            result.prices_tried.append(price)
            status = self._wait(account_id, order_id)
            if status.state == "filled":
                result.status, result.filled, result.avg_fill_price = "filled", status.filled_quantity, status.avg_fill_price
                return result
            if status.state in ("rejected", "canceled", "expired"):
                result.status = "rejected" if status.state == "rejected" else "unfilled"
                result.filled, result.avg_fill_price = status.filled_quantity, status.avg_fill_price
                result.events.append({"event": status.state})
                return result
        self.broker.cancel_order(account_id, order_id)
        result.events.append({"event": "canceled_after_max_steps", "steps": len(prices)})
        if status is not None:
            result.filled, result.avg_fill_price = status.filled_quantity, status.avg_fill_price
        result.status = "partially_filled" if result.filled else "unfilled"
        return result

    def _wait(self, account_id: str, order_id: str) -> OrderStatus:
        deadline = self.clock() + self.cfg.step_wait_seconds
        while True:
            status = self.broker.get_order(account_id, order_id)
            if status.state in ("filled", "rejected", "canceled", "expired") or self.clock() >= deadline:
                return status
            self.sleep(self.cfg.poll_interval_seconds)
