from datetime import date, timedelta
from unittest.mock import patch

import pandas as pd

from backtest.simulate_tier2 import simulate_play_outcome


def make_bars(prices, start=date(2026, 5, 10)):
    """Build a fake DataFrame of consecutive daily bars from a list of closes."""
    rows = []
    d = start
    for p in prices:
        rows.append({
            "date": d,
            "open": p,
            "high": p,
            "low": p,
            "close": p,
            "volume": 1_000_000,
        })
        d = d + timedelta(days=1)
    return pd.DataFrame(rows)


def test_profit_target_fires():
    """Spot ramps up fast → profit target hits before expiration."""
    bars = make_bars([100, 105, 112, 118], start=date(2026, 5, 10))
    with patch("backtest.simulate_tier2.fetch_daily_bars", return_value=bars):
        r = simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=100,
            short_strike=110,
            expiration_date=date(2026, 5, 17),
            entry_debit=3.50,
            entry_date=date(2026, 5, 10),
            entry_iv=0.30,
            profit_target_pct=90,
            stop_loss_pct=-50,
        )
    assert r["exit_trigger"] == "profit_target"
    assert r["pnl_pct"] >= 90


def test_stop_loss_fires():
    """Spot drops → stop loss fires."""
    bars = make_bars([100, 95, 90, 85], start=date(2026, 5, 10))
    with patch("backtest.simulate_tier2.fetch_daily_bars", return_value=bars):
        r = simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=100,
            short_strike=110,
            expiration_date=date(2026, 5, 17),
            entry_debit=3.50,
            entry_date=date(2026, 5, 10),
            entry_iv=0.30,
            profit_target_pct=90,
            stop_loss_pct=-50,
        )
    assert r["exit_trigger"] == "stop_loss"
    assert r["pnl_pct"] <= -50


def test_falls_through_to_expiration():
    """Spot drifts → no exit fires → uses Tier 1 intrinsic at expiry."""
    # 8 bars covering entry through expiration
    bars = make_bars(
        [100, 101, 102, 103, 104, 105, 105, 105],
        start=date(2026, 5, 10),
    )
    with patch("backtest.simulate_tier2.fetch_daily_bars", return_value=bars), \
         patch("backtest.simulate_tier1.fetch_close", return_value=105.0):
        r = simulate_play_outcome(
            ticker="TEST",
            structure="bull_call_spread",
            long_strike=100,
            short_strike=110,
            expiration_date=date(2026, 5, 17),
            entry_debit=3.50,
            entry_date=date(2026, 5, 10),
            entry_iv=0.30,
            profit_target_pct=200,  # unreachable
            stop_loss_pct=-100,     # unreachable
        )
    assert r["exit_trigger"] == "expiration"
    # Tier 1 math at spot=105: long_intrinsic=5, short=0 → 5 - 0.525 slippage = 4.475
    # P&L = 4.475 - 3.50 = 0.975
    assert abs(r["pnl_per_spread"] - 0.975) < 0.01
    # Path data is preserved on the fall-through
    assert isinstance(r.get("underlying_path"), list)
    assert len(r["underlying_path"]) > 0
