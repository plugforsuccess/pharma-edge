import dataclasses

import pytest

from ldp.brokers import DryRunBroker
from ldp.orders import LimitOrderExecutor, price_ladder


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def test_buy_ladder_starts_at_mid_steps_to_ask(cfg):
    assert price_ladder(10.00, 11.00, "buy_to_open", cfg.orders) == [10.50, 10.75, 11.00]


def test_sell_ladder_steps_to_bid(cfg):
    assert price_ladder(10.00, 11.00, "sell_to_close", cfg.orders) == [10.50, 10.25, 10.00]


def test_ladder_never_crosses_ask(cfg):
    o = dataclasses.replace(cfg.orders, max_steps=10, step_pct_of_spread=0.5)
    assert max(price_ladder(10.00, 10.40, "buy_to_open", o)) <= 10.40


def test_ladder_rejects_crossed_quote(cfg):
    with pytest.raises(ValueError):
        price_ladder(11, 10, "buy_to_open", cfg.orders)


def _executor(broker, cfg):
    clock = FakeClock()
    return LimitOrderExecutor(broker, cfg.orders, sleep=clock.sleep, clock=clock)


def test_fills_on_second_step(cfg):
    b = DryRunBroker(fill_at={"SYM": 10.75})
    r = _executor(b, cfg).execute(account_id="A", underlying="XLK", option_symbol="SYM", side="buy_to_open",
                                  quantity=2, bid=10.0, ask=11.0)
    assert (r.status, r.filled, r.avg_fill_price) == ("filled", 2, 10.75)
    assert r.prices_tried == [10.50, 10.75]
    assert all(e.get("type", "limit") == "limit" for e in b.log)


def test_cancels_after_max_steps(cfg):
    b = DryRunBroker()   # never fills
    r = _executor(b, cfg).execute(account_id="A", underlying="XLK", option_symbol="SYM", side="buy_to_open",
                                  quantity=1, bid=10.0, ask=11.0)
    assert r.status == "unfilled" and r.filled == 0
    assert [e["op"] for e in b.log] == ["place", "modify", "modify", "cancel"]
    assert any(ev["event"] == "canceled_after_max_steps" for ev in r.events)


def test_no_market_orders_anywhere(cfg):
    b = DryRunBroker()
    _executor(b, cfg).execute(account_id="A", underlying="XLK", option_symbol="SYM", side="sell_to_close",
                              quantity=1, bid=1.0, ask=1.2)
    assert {e["type"] for e in b.log if e["op"] == "place"} == {"limit"}
