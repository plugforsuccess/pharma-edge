from datetime import timedelta

import pytest

from ldp.backtester import Day, run
from ldp.rules import fixed_rates

from .conftest import TODAY, position


def test_ladder_then_stop_after_tax(cfg):
    p = position(held_days=380, mark=10.0, basis_per_contract=1_000, entry_price=10.0)
    days = [
        Day(TODAY, 24.0),                         # 2.4x ≥ LT rung 1 (2.31x) → sell 1
        Day(TODAY + timedelta(days=1), 37.0),     # 3.7x ≥ rung 2 (3.62x) → sell 1
        Day(TODAY + timedelta(days=2), 4.0),      # −60% vs entry → stop, sell the rest
    ]
    r = run(p, days, rate_source=fixed_rates(0.238, 0.408), cfg=cfg)
    assert [(f.rule, f.contracts) for f in r.fills] == [("profit_target", 1), ("profit_target", 1), ("price_stop", 1)]
    assert r.realised_gain == pytest.approx(1_400 + 2_700 - 600)
    assert r.tax == pytest.approx((1_400 + 2_700) * 0.238)
    assert r.final_position.contracts_open == 0


def test_hold_through_long_term_then_target(cfg):
    p = position(held_days=330, mark=12.0)
    days = [Day(TODAY + timedelta(days=i), 12.0 if i < 40 else 24.0) for i in range(45)]
    r = run(p, days, rate_source=fixed_rates(0.238, 0.408), cfg=cfg)
    assert r.fills and r.fills[0].character == "long_term" and r.fills[0].on == TODAY + timedelta(days=40)
