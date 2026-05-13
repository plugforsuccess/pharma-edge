"""
Tier 2 (path-aware) spread outcome simulator.

Walks daily closes between entry and expiration, prices the spread via
Black-Scholes with held-flat IV, and exits at profit target or stop
loss when hit. Falls through to Tier 1 intrinsic at expiration if no
exit fires.

Caveats:
  * Held-flat IV is an approximation. Trades over earnings or vol
    events will be off significantly. For GEX structural plays
    (5-14 DTE, no earnings in window) the error is small.
  * Risk-free rate is hard-coded at 0.045 (rough current 3-month).
  * For full fidelity (mid-trade options quotes per leg per day) see
    Tier 3 — deferred.
"""

import logging
import math
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd
import requests
from scipy.stats import norm

from backtest.simulate_tier1 import (
    CACHE_DIR,
    POLYGON_BASE,
    _polygon_key,
    simulate_play_outcome as simulate_tier1,
)

logger = logging.getLogger(__name__)

RISK_FREE_RATE = 0.045


def black_scholes_call(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """European call price via Black-Scholes. T in years."""
    if T <= 0:
        return max(0.0, S - K)
    if sigma <= 0:
        return max(0.0, S - K * math.exp(-r * T))
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return S * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)


def black_scholes_put(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """European put price via Black-Scholes. T in years."""
    if T <= 0:
        return max(0.0, K - S)
    if sigma <= 0:
        return max(0.0, K * math.exp(-r * T) - S)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return K * math.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)


def fetch_daily_bars(ticker: str, from_date: date, to_date: date) -> pd.DataFrame:
    """Returns all trading-day bars in [from_date, to_date] for `ticker`,
    sorted ascending by date. Shares the Tier 1 parquet cache."""
    cache_path = CACHE_DIR / f"eod_{ticker.upper()}.parquet"

    cached: Optional[pd.DataFrame] = None
    need_fetch = True
    if cache_path.exists():
        cached = pd.read_parquet(cache_path)
        cached["date"] = pd.to_datetime(cached["date"]).dt.date
        in_range = cached[(cached["date"] >= from_date) & (cached["date"] <= to_date)]
        if not in_range.empty:
            cached_min = in_range["date"].min()
            cached_max = in_range["date"].max()
            if cached_min <= from_date + timedelta(days=3) and cached_max >= to_date - timedelta(days=3):
                need_fetch = False

    if need_fetch:
        url = (
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker.upper()}"
            f"/range/1/day/{from_date}/{to_date}"
            f"?adjusted=true&sort=asc&limit=50000&apiKey={_polygon_key()}"
        )
        resp = requests.get(url, timeout=15)
        if resp.status_code != 200:
            logger.warning(
                "Polygon fetch failed for %s %s..%s: %d %s",
                ticker, from_date, to_date, resp.status_code, resp.text[:200],
            )
            if cached is not None:
                in_range = cached[(cached["date"] >= from_date) & (cached["date"] <= to_date)]
                return in_range.sort_values("date").reset_index(drop=True)
            return pd.DataFrame(columns=["date", "open", "high", "low", "close", "volume"])

        results = resp.json().get("results") or []
        bars = pd.DataFrame([
            {
                "date": pd.to_datetime(bar["t"], unit="ms").date(),
                "open": bar["o"],
                "high": bar["h"],
                "low": bar["l"],
                "close": bar["c"],
                "volume": bar["v"],
            }
            for bar in results
        ])
        if cached is not None and not cached.empty:
            bars = pd.concat([cached, bars], ignore_index=True)
            bars = bars.drop_duplicates(subset=["date"]).sort_values("date")
        if not bars.empty:
            bars.to_parquet(cache_path, index=False)
        cached = bars

    in_range = cached[(cached["date"] >= from_date) & (cached["date"] <= to_date)]
    return in_range.sort_values("date").reset_index(drop=True)


def price_spread(
    structure: str,
    spot: float,
    long_strike: float,
    short_strike: float,
    T: float,
    iv: float,
    risk_free: float = RISK_FREE_RATE,
) -> float:
    """Black-Scholes value of the spread (long leg minus short leg)."""
    if structure == "bull_call_spread":
        long_val = black_scholes_call(spot, long_strike, T, risk_free, iv)
        short_val = black_scholes_call(spot, short_strike, T, risk_free, iv)
    elif structure == "bear_put_spread":
        long_val = black_scholes_put(spot, long_strike, T, risk_free, iv)
        short_val = black_scholes_put(spot, short_strike, T, risk_free, iv)
    else:
        raise NotImplementedError(structure)
    return long_val - short_val


def simulate_play_outcome(
    ticker: str,
    structure: str,
    long_strike: float,
    short_strike: float,
    expiration_date: date,
    entry_debit: float,
    entry_date: date,
    contracts: int = 1,
    slippage_pct: float = 0.005,
    *,
    profit_target_pct: Optional[float] = 90.0,
    stop_loss_pct: Optional[float] = -50.0,
    entry_iv: Optional[float] = None,
) -> dict:
    """Path-aware simulation. Walks daily closes from entry_date to
    expiration_date, prices the spread per day via Black-Scholes with
    held-flat `entry_iv`, and exits when profit target or stop loss
    fires. Falls through to Tier 1 intrinsic at expiration otherwise.

    `entry_iv` should be a decimal (0.32 for 32% IV). Defaults to 0.30
    with a warning if not provided."""
    if entry_debit <= 0:
        raise ValueError(f"entry_debit must be > 0, got {entry_debit}")
    if long_strike == short_strike:
        raise ValueError(
            f"long_strike ({long_strike}) == short_strike ({short_strike})"
        )
    if structure not in ("bull_call_spread", "bear_put_spread"):
        raise NotImplementedError(f"structure {structure} not in Tier 2 scope")

    if structure == "bull_call_spread" and long_strike > short_strike:
        long_strike, short_strike = short_strike, long_strike
    if structure == "bear_put_spread" and long_strike < short_strike:
        long_strike, short_strike = short_strike, long_strike

    if entry_iv is None:
        logger.warning(
            "entry_iv not provided; defaulting to 0.30. "
            "Tier 2 results will be approximate."
        )
        entry_iv = 0.30

    bars = fetch_daily_bars(ticker, entry_date, expiration_date)
    if bars.empty:
        return {
            "pnl_per_spread": None,
            "pnl_total": None,
            "pnl_pct": None,
            "exit_trigger": "no_data",
            "exit_date": entry_date,
            "exit_value": None,
            "days_held": 0,
            "underlying_at_exit": None,
            "underlying_path": [],
        }

    slippage_dollars = slippage_pct * (long_strike + short_strike) / 2
    path: list[dict] = []

    for _, bar in bars.iterrows():
        bar_date = bar["date"]
        if not isinstance(bar_date, date):
            bar_date = pd.to_datetime(bar_date).date()
        close = float(bar["close"])

        if bar_date <= entry_date:
            path.append({"date": bar_date, "close": close})
            continue
        if bar_date >= expiration_date:
            break

        T = (expiration_date - bar_date).days / 365.0
        spread_value = price_spread(
            structure=structure,
            spot=close,
            long_strike=long_strike,
            short_strike=short_strike,
            T=T,
            iv=entry_iv,
        )
        spread_value_net = max(0.0, spread_value - slippage_dollars)
        pnl_per_spread = spread_value_net - entry_debit
        pnl_pct = (pnl_per_spread / entry_debit) * 100

        path.append({
            "date": bar_date,
            "close": close,
            "spread_value": round(spread_value_net, 4),
            "pnl_pct": round(pnl_pct, 2),
        })

        if profit_target_pct is not None and pnl_pct >= profit_target_pct:
            return {
                "pnl_per_spread": round(pnl_per_spread, 4),
                "pnl_total": round(pnl_per_spread * 100 * contracts, 2),
                "pnl_pct": round(pnl_pct, 2),
                "exit_trigger": "profit_target",
                "exit_date": bar_date,
                "exit_value": round(spread_value_net, 4),
                "days_held": (bar_date - entry_date).days,
                "underlying_at_exit": round(close, 2),
                "underlying_path": path,
            }

        if stop_loss_pct is not None and pnl_pct <= stop_loss_pct:
            return {
                "pnl_per_spread": round(pnl_per_spread, 4),
                "pnl_total": round(pnl_per_spread * 100 * contracts, 2),
                "pnl_pct": round(pnl_pct, 2),
                "exit_trigger": "stop_loss",
                "exit_date": bar_date,
                "exit_value": round(spread_value_net, 4),
                "days_held": (bar_date - entry_date).days,
                "underlying_at_exit": round(close, 2),
                "underlying_path": path,
            }

    t1 = simulate_tier1(
        ticker=ticker,
        structure=structure,
        long_strike=long_strike,
        short_strike=short_strike,
        expiration_date=expiration_date,
        entry_debit=entry_debit,
        entry_date=entry_date,
        contracts=contracts,
        slippage_pct=slippage_pct,
    )
    t1["underlying_path"] = path
    return t1


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", required=True)
    parser.add_argument(
        "--structure",
        required=True,
        choices=["bull_call_spread", "bear_put_spread"],
    )
    parser.add_argument("--long-strike", type=float, required=True)
    parser.add_argument("--short-strike", type=float, required=True)
    parser.add_argument("--expiration", required=True, help="YYYY-MM-DD")
    parser.add_argument("--entry-debit", type=float, required=True)
    parser.add_argument("--entry-date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--contracts", type=int, default=1)
    parser.add_argument("--slippage-pct", type=float, default=0.005)
    parser.add_argument("--profit-target-pct", type=float, default=90.0)
    parser.add_argument("--stop-loss-pct", type=float, default=-50.0)
    parser.add_argument("--entry-iv", type=float, default=None)
    args = parser.parse_args()

    result = simulate_play_outcome(
        ticker=args.ticker,
        structure=args.structure,
        long_strike=args.long_strike,
        short_strike=args.short_strike,
        expiration_date=date.fromisoformat(args.expiration),
        entry_debit=args.entry_debit,
        entry_date=date.fromisoformat(args.entry_date),
        contracts=args.contracts,
        slippage_pct=args.slippage_pct,
        profit_target_pct=args.profit_target_pct,
        stop_loss_pct=args.stop_loss_pct,
        entry_iv=args.entry_iv,
    )
    print(json.dumps(result, default=str, indent=2))
