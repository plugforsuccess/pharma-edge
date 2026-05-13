from datetime import date
from unittest.mock import patch

import pytest

from backtest.simulate_tier1 import simulate_play_outcome


def test_bull_call_in_the_money_above_short():
    """Spot above short_strike → max value (width)."""
    with patch("backtest.simulate_tier1.fetch_close", return_value=120.0):
        r = simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=100,
            short_strike=110,
            expiration_date=date(2026, 5, 17),
            entry_debit=3.50,
            entry_date=date(2026, 5, 10),
        )
    # Width = 10, slippage = 0.5% × 105 = 0.525 → net 9.475 → P&L = 5.975
    assert abs(r["pnl_per_spread"] - 5.975) < 0.01
    assert r["exit_trigger"] == "expiration"
    assert r["underlying_at_exit"] == 120.0
    assert r["days_held"] == 7


def test_bull_call_below_long_strike_total_loss():
    """Spot below long_strike → spread worthless, total loss of debit."""
    with patch("backtest.simulate_tier1.fetch_close", return_value=95.0):
        r = simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=100,
            short_strike=110,
            expiration_date=date(2026, 5, 17),
            entry_debit=3.50,
            entry_date=date(2026, 5, 10),
        )
    assert r["pnl_per_spread"] == -3.50
    assert r["pnl_pct"] == -100.0


def test_bull_call_between_strikes_partial():
    """Spot between long and short → partial value."""
    with patch("backtest.simulate_tier1.fetch_close", return_value=105.0):
        r = simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=100,
            short_strike=110,
            expiration_date=date(2026, 5, 17),
            entry_debit=3.50,
            entry_date=date(2026, 5, 10),
        )
    # Long intrinsic = 5, short intrinsic = 0 → spread = 5
    # After slippage 0.525 → 4.475 → P&L = 0.975
    assert abs(r["pnl_per_spread"] - 0.975) < 0.01


def test_bear_put_in_the_money_below_short():
    """Spot below short_strike → max value (width)."""
    with patch("backtest.simulate_tier1.fetch_close", return_value=90.0):
        r = simulate_play_outcome(
            ticker="TEST",
            structure="bear_put_spread",
            long_strike=110,
            short_strike=100,
            expiration_date=date(2026, 5, 17),
            entry_debit=4.00,
            entry_date=date(2026, 5, 10),
        )
    # Long intrinsic = 20, short intrinsic = 10 → clamped to width 10
    # After slippage 0.525 → 9.475 → P&L = 5.475
    assert abs(r["pnl_per_spread"] - 5.475) < 0.01


def test_no_data_returns_safely():
    """Missing expiration close returns no_data, not a crash."""
    with patch("backtest.simulate_tier1.fetch_close", return_value=None):
        r = simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=100,
            short_strike=110,
            expiration_date=date(2026, 5, 17),
            entry_debit=3.50,
            entry_date=date(2026, 5, 10),
        )
    assert r["exit_trigger"] == "no_data"
    assert r["pnl_per_spread"] is None
    assert r["pnl_total"] is None
    assert r["underlying_at_exit"] is None


def test_invalid_inputs_raise():
    with pytest.raises(ValueError):
        simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=100,
            short_strike=110,
            expiration_date=date(2026, 5, 17),
            entry_debit=0,  # invalid
            entry_date=date(2026, 5, 10),
        )
    with pytest.raises(ValueError):
        simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=100,
            short_strike=100,  # invalid
            expiration_date=date(2026, 5, 17),
            entry_debit=3.50,
            entry_date=date(2026, 5, 10),
        )


def test_reversed_legs_get_swapped():
    """Bull call passed with long > short should swap and warn, not crash."""
    with patch("backtest.simulate_tier1.fetch_close", return_value=120.0):
        r = simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=110,  # reversed
            short_strike=100,
            expiration_date=date(2026, 5, 17),
            entry_debit=3.50,
            entry_date=date(2026, 5, 10),
        )
    # After swap: long=100 short=110, spot=120 → max value (width 10)
    assert abs(r["pnl_per_spread"] - 5.975) < 0.01
