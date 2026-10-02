"""Trading cadence.

* Buys: once per year per user inside their annual buy window, plus any
  re-entry after a sell (a slot freed by a sale can be refilled any time).
* Sell checks: daily on every open position (see rules.evaluate_position).
* Idle cash between buys stays in the account's sweep / money market —
  the engine never trades it.
"""

from __future__ import annotations

from datetime import date, timedelta

from .config import CadenceConfig


def _parse_mmdd(mmdd: str) -> tuple[int, int]:
    m, d = (int(x) for x in mmdd.split("-"))
    date(2024, m, d)  # validates (2024 is a leap year, so 02-29 is allowed)
    return m, d


def window_start(year: int, mmdd: str) -> date:
    m, d = _parse_mmdd(mmdd)
    if (m, d) == (2, 29):
        try:
            return date(year, 2, 29)
        except ValueError:
            return date(year, 2, 28)
    return date(year, m, d)


def in_buy_window(today: date, cfg: CadenceConfig, user_window_start: str | None = None) -> bool:
    mmdd = user_window_start or cfg.buy_window_start
    for year in (today.year - 1, today.year):   # windows can straddle New Year
        start = window_start(year, mmdd)
        if start <= today < start + timedelta(days=cfg.buy_window_days):
            return True
    return False


def may_buy(
    today: date, cfg: CadenceConfig, *, last_annual_buy: date | None,
    user_window_start: str | None = None, reentry: bool = False,
) -> tuple[bool, str]:
    """Whether the allocator may place buys today, and why."""
    if reentry:
        return True, "re-entry after a sell"
    if not in_buy_window(today, cfg, user_window_start):
        return False, "outside the annual buy window"
    mmdd = user_window_start or cfg.buy_window_start
    start = max(s for s in (window_start(today.year - 1, mmdd), window_start(today.year, mmdd)) if s <= today)
    if last_annual_buy is not None and last_annual_buy >= start:
        return False, "annual buy already done in this window"
    return True, "annual buy window"
