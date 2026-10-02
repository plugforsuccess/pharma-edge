from pathlib import Path

import pytest

from ldp.config import LDPConfig, config_from_dict, load_config, rung_fractions

DEFAULTS = Path(__file__).resolve().parents[1] / "defaults" / "ldp.default.toml"


def test_defaults_match_spec():
    c = LDPConfig()
    assert c.risk.min_account_aggressive == 25_000
    assert (c.satellite.max_per_name, c.satellite.max_total) == (0.05, 0.15)
    assert (c.satellite.min_runway_months, c.satellite.catalyst_blackout_days) == (12, 14)
    assert (c.contracts.min_dte_days, c.contracts.target_dte_days) == (540, 730)
    assert (c.contracts.core_delta_min, c.contracts.core_delta_max) == (0.70, 0.80)
    assert (c.contracts.satellite_delta_min, c.contracts.satellite_delta_max) == (0.60, 0.80)
    assert (c.contracts.max_iv_rank, c.contracts.max_spread_pct, c.contracts.min_open_interest) == (70, 0.10, 100)
    # LEAPS playbook: +100% → sell 70%, +200% → sell 15%, runner 15% trails 30%.
    assert c.exits.ladder == (1.0, 2.0)
    assert rung_fractions(c.exits) == pytest.approx((0.70, 0.15))
    assert c.exits.runner_trail_pct == 0.30
    assert (c.exits.roll_dte_days, c.exits.roll_warn_dte_days, c.exits.ltcg_wait_days) == (180, 270, 60)
    assert c.exits.stop_loss_pct is None                       # no hard price stop
    assert (c.orders.place_target_order_on_entry, c.orders.target_order_duration) == (True, "gtc")


def test_toml_file_equals_dataclass_defaults():
    assert load_config(DEFAULTS) == LDPConfig()


def test_override_merges_over_defaults():
    c = config_from_dict({"satellite": {"max_per_name": 0.04, "weights": {"runway": 1.0}}})
    assert c.satellite.max_per_name == 0.04
    assert c.satellite.max_total == 0.15
    assert c.satellite.weights["runway"] == 1.0 and "momentum" in c.satellite.weights


@pytest.mark.parametrize("bad", [
    {"satelite": {}},                                  # unknown section
    {"satellite": {"max_per_nam": 0.05}},              # unknown key
    {"satellite": {"max_per_name": 0.2}},              # per-name > total
    {"exits": {"rung_fractions": [0.5, 0.25, 0.25]}},  # wrong length
    {"exits": {"rung_fractions": [0.8, 0.3]}},         # sells more than the position
    {"exits": {"runner_trail_pct": 1.5}},              # trail out of range
    {"exits": {"ladder": [2.0, 1.0]}},                 # targets must increase
    {"exits": {"roll_warn_dte_days": 100}},            # warn before act
    {"exits": {"roll_dte_days": 600}},                 # roll ≥ min DTE
])
def test_invalid_config_rejected(bad):
    with pytest.raises(ValueError):
        config_from_dict(bad)
