from datetime import timedelta

import pytest

from ldp.backtester import Day, run
from ldp.rules import fixed_rates

from .conftest import TODAY, position


def test_playbook_ladder_then_runner_trail(cfg):
    p = position(held_days=380, contracts=20, mark=10.0, basis_per_contract=1_000, entry_price=10.0)
    days = [
        Day(TODAY, 20.0),                         # +100% → sell 14 (70%)
        Day(TODAY + timedelta(days=1), 30.0),     # +200% → sell 3 (half of what's left)
        Day(TODAY + timedelta(days=2), 40.0),     # runner's new peak
        Day(TODAY + timedelta(days=3), 28.0),     # 30% off the peak → sell the runner
    ]
    r = run(p, days, rate_source=fixed_rates(0.238, 0.408), cfg=cfg)
    assert [(f.rule, f.contracts) for f in r.fills] == [("profit_target", 14), ("profit_target", 3), ("runner_trail", 3)]
    assert r.realised_gain == pytest.approx(14 * 1_000 + 3 * 2_000 + 3 * 1_800)
    assert r.final_position.contracts_open == 0


def test_no_price_stop_rides_a_drawdown(cfg):
    p = position(held_days=380, mark=10.0, basis_per_contract=1_000, entry_price=10.0)
    days = [Day(TODAY + timedelta(days=i), m) for i, m in enumerate([6.0, 3.0, 1.0, 12.0])]
    r = run(p, days, rate_source=fixed_rates(0.238, 0.408), cfg=cfg)
    assert r.fills == [] and r.final_position.contracts_open == 3


def test_hold_through_long_term_then_target(cfg):
    p = position(held_days=330, mark=12.0)
    days = [Day(TODAY + timedelta(days=i), 12.0 if i < 40 else 24.0) for i in range(45)]
    r = run(p, days, rate_source=fixed_rates(0.238, 0.408), cfg=cfg)
    assert r.fills and r.fills[0].character == "long_term" and r.fills[0].on == TODAY + timedelta(days=40)
