"""Best-effort market cap lookup via yfinance.

Used by the scanner to tag candidates with their sponsor's market cap so
the queue UI can flag mega-caps (where a single Phase 2/3 readout isn't
material to the parent's price). Failures are silent — market cap is
decoration for triage, not load-bearing for any signal.
"""

from __future__ import annotations

_CACHE: dict[str, int | None] = {}


def market_cap_for(ticker: str) -> int | None:
    """Returns the integer USD market cap for `ticker`, or None on any
    failure / missing data. Cached per ticker for the cron run."""
    if not ticker:
        return None
    if ticker in _CACHE:
        return _CACHE[ticker]
    cap: int | None = None
    try:
        import yfinance as yf

        info = yf.Ticker(ticker).fast_info
        raw = None
        try:
            raw = info["market_cap"]
        except (KeyError, TypeError):
            raw = getattr(info, "market_cap", None)
        if raw and raw > 0:
            cap = int(raw)
    except Exception as exc:
        print(f"  market_cap_for({ticker}): {exc}")
    _CACHE[ticker] = cap
    return cap
