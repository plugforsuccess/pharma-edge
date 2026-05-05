"""Best-effort market cap lookup via yfinance.

Used by the scanner to tag candidates with their sponsor's market cap so
the queue UI can flag mega-caps (where a single Phase 2/3 readout isn't
material to the parent's price). Failures are silent — market cap is
decoration for triage, not load-bearing for any signal.

Hardcoded sponsor pre-filter (`is_known_mega_sponsor`) catches the
obvious mega-caps without depending on yfinance, since yfinance has
been intermittently rate-limited / blocked from CI environments.
"""

from __future__ import annotations

_CACHE: dict[str, int | None] = {}

# Sponsors known to be > $10B as of 2026. We treat any CT.gov sponsor
# whose name contains any of these substrings (case-insensitive) as a
# known mega-cap, applying the same score penalty as a yfinance >$10B
# match. This is the belt — yfinance is the suspenders.
KNOWN_MEGA_SPONSORS: tuple[str, ...] = (
    "abbvie",
    "alnylam",
    "amgen",
    "astellas",
    "astrazeneca",
    "bayer",
    "beigene",
    "bicycle therapeutics",
    "biogen",
    "biomarin",
    "bristol",
    "bristol-myers",
    "bristol myers",
    "daiichi sankyo",
    "eisai",
    "eli lilly",
    "lilly",
    "exelixis",
    "gilead",
    "glaxosmithkline",
    "gsk",
    "incyte",
    "janssen",
    "jazz pharma",
    "johnson & johnson",
    "merck ",  # trailing space avoids matching small-cap subsidiaries
    "merck sharp",
    "moderna",
    "novartis",
    "novo nordisk",
    "pfizer",
    "regeneron",
    "roche",
    "sanofi",
    "takeda",
    "teva",
    "vertex pharma",
)


def is_known_mega_sponsor(sponsor: str) -> bool:
    """True when the sponsor name matches a hardcoded known >$10B
    pharma/biotech. Avoids needing yfinance for the obvious cases."""
    if not sponsor:
        return False
    s = sponsor.lower()
    return any(name in s for name in KNOWN_MEGA_SPONSORS)


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
    if cap is None:
        print(f"  market_cap_for({ticker}): None (yfinance returned no value)")
    _CACHE[ticker] = cap
    return cap
