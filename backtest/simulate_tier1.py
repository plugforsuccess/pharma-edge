"""
Tier 1 (intrinsic-only) spread outcome simulator.

Holds-to-expiration scoring. No mid-trade exits, no Black-Scholes,
no IV. Just: what would the spread be worth at the closing print
on expiration, after slippage?

Use this for first-pass repeatability validation. It's the floor —
real trading exits at profit targets, so Tier 1 systematically
underestimates actual performance. Tier 2 (path-aware with profit
targets and stops) is the more realistic version.
"""

import logging
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd
import requests

logger = logging.getLogger(__name__)

POLYGON_BASE = "https://api.polygon.io"
CACHE_DIR = Path(__file__).parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)


def _polygon_key() -> str:
    key = os.environ.get("POLYGON_API_KEY")
    if not key:
        raise RuntimeError("POLYGON_API_KEY not set in environment")
    return key


def fetch_close(ticker: str, target_date: date) -> Optional[float]:
    """Adjusted close for `ticker` on `target_date`, or the next trading
    day if `target_date` is a holiday/weekend. Returns None if no bar
    is found within 7 days. Cached to a per-ticker parquet file."""
    cache_path = CACHE_DIR / f"eod_{ticker.upper()}.parquet"

    if cache_path.exists():
        cached = pd.read_parquet(cache_path)
        cached["date"] = pd.to_datetime(cached["date"]).dt.date
        on_or_after = cached[cached["date"] >= target_date].sort_values("date")
        if not on_or_after.empty:
            first = on_or_after.iloc[0]
            if (first["date"] - target_date).days <= 7:
                return float(first["close"])

    from_date = target_date
    to_date = target_date + timedelta(days=7)
    url = (
        f"{POLYGON_BASE}/v2/aggs/ticker/{ticker.upper()}"
        f"/range/1/day/{from_date}/{to_date}"
        f"?adjusted=true&sort=asc&apiKey={_polygon_key()}"
    )
    resp = requests.get(url, timeout=10)
    if resp.status_code != 200:
        logger.warning(
            "Polygon fetch failed for %s %s: %d %s",
            ticker, target_date, resp.status_code, resp.text[:200],
        )
        return None

    results = resp.json().get("results") or []
    if not results:
        return None

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

    if cache_path.exists():
        existing = pd.read_parquet(cache_path)
        existing["date"] = pd.to_datetime(existing["date"]).dt.date
        bars = pd.concat([existing, bars], ignore_index=True)
        bars = bars.drop_duplicates(subset=["date"]).sort_values("date")
    bars.to_parquet(cache_path, index=False)

    on_or_after = bars[bars["date"] >= target_date]
    if on_or_after.empty:
        return None
    return float(on_or_after.iloc[0]["close"])


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
) -> dict:
    """Score `structure` held to `expiration_date` against the
    expiration close. Returns pnl_per_spread, pnl_total, pnl_pct,
    exit_trigger, exit_date, exit_value, days_held, underlying_at_exit.

    `exit_trigger` is always 'expiration' on success or 'no_data' when
    the expiration close cannot be fetched."""
    if entry_debit <= 0:
        raise ValueError(f"entry_debit must be > 0, got {entry_debit}")
    if long_strike == short_strike:
        raise ValueError(
            f"long_strike ({long_strike}) == short_strike ({short_strike})"
        )
    if structure not in ("bull_call_spread", "bear_put_spread"):
        raise NotImplementedError(f"structure {structure} not supported in Tier 1")

    if structure == "bull_call_spread" and long_strike > short_strike:
        logger.warning(
            "bull_call_spread had long_strike > short_strike; swapping. "
            "Original long=%s short=%s", long_strike, short_strike,
        )
        long_strike, short_strike = short_strike, long_strike
    if structure == "bear_put_spread" and long_strike < short_strike:
        logger.warning(
            "bear_put_spread had long_strike < short_strike; swapping. "
            "Original long=%s short=%s", long_strike, short_strike,
        )
        long_strike, short_strike = short_strike, long_strike

    expiry_close = fetch_close(ticker, expiration_date)
    if expiry_close is None:
        return {
            "pnl_per_spread": None,
            "pnl_total": None,
            "pnl_pct": None,
            "exit_trigger": "no_data",
            "exit_date": expiration_date,
            "exit_value": None,
            "days_held": (expiration_date - entry_date).days,
            "underlying_at_exit": None,
        }

    if structure == "bull_call_spread":
        long_intrinsic = max(0.0, expiry_close - long_strike)
        short_intrinsic = max(0.0, expiry_close - short_strike)
        max_value = short_strike - long_strike
    else:  # bear_put_spread
        long_intrinsic = max(0.0, long_strike - expiry_close)
        short_intrinsic = max(0.0, short_strike - expiry_close)
        max_value = long_strike - short_strike

    spread_value = long_intrinsic - short_intrinsic
    spread_value = max(0.0, min(spread_value, max_value))

    slippage_dollars = slippage_pct * (long_strike + short_strike) / 2
    spread_value_net = max(0.0, spread_value - slippage_dollars)

    pnl_per_spread = spread_value_net - entry_debit
    pnl_total = pnl_per_spread * 100 * contracts
    pnl_pct = (pnl_per_spread / entry_debit) * 100

    return {
        "pnl_per_spread": round(pnl_per_spread, 4),
        "pnl_total": round(pnl_total, 2),
        "pnl_pct": round(pnl_pct, 2),
        "exit_trigger": "expiration",
        "exit_date": expiration_date,
        "exit_value": round(spread_value_net, 4),
        "days_held": (expiration_date - entry_date).days,
        "underlying_at_exit": round(expiry_close, 2),
    }


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
    )
    print(json.dumps(result, default=str, indent=2))
