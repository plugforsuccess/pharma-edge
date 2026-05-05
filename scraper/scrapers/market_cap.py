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


# Substrings that indicate the sponsor is academic / government /
# cooperative-group rather than a publicly-traded company. CT.gov is
# full of NIH, NCI, university hospital, and foreign public-health
# trials — those generate strong catalyst signals but aren't tradeable.
NON_TRADEABLE_KEYWORDS: tuple[str, ...] = (
    "assistance publique",
    "centre hospitalier",
    "centers for disease control",
    "department of defense",
    "department of veterans",
    "ecog-acrin",
    "fred hutchinson",
    "hopitaux",
    "hôpitaux",
    "karolinska",
    "klinikum",
    "ministry of health",
    "national cancer institute",
    "national health service",
    "national institute",
    "national institutes of health",
    "nci ",
    "nhs ",
    "nih ",
    "nrg oncology",
    "swog cancer",
    "u.s. army",
    "us army",
    "veterans affairs",
    "world health organization",
    # Academic medical centers (most common CT.gov sponsors)
    "boston children",
    "brigham and women",
    "children's hospital",
    "children's oncology",
    "city of hope",
    "cleveland clinic",
    "columbia university",
    "dana-farber",
    "duke clinical",
    "duke university",
    "fox chase",
    "harvard medical",
    "icahn school",
    "johns hopkins",
    "lurie cancer",
    "massachusetts general",
    "mayo clinic",
    "md anderson",
    "memorial sloan",
    "moffitt cancer",
    "mount sinai",
    "nyu langone",
    "sidney kimmel",
    "siteman cancer",
    "stanford university",
    "ucla",
    "ucsf",
    "university hospital",
    "university of",
    "vanderbilt university",
    "weill cornell",
    "winship cancer",
    "yale university",
)


def is_non_tradeable_sponsor(sponsor: str) -> bool:
    """True when the sponsor is an academic / government / hospital
    entity that doesn't have a tradeable stock. Drop these before they
    enter the candidate pool — they trip catalyst signals but aren't
    actionable from the trade flow."""
    if not sponsor:
        return False
    s = sponsor.lower()
    return any(name in s for name in NON_TRADEABLE_KEYWORDS)


def market_cap_for(ticker: str) -> int | None:
    """Returns the integer USD market cap for `ticker`, or None on any
    failure / missing data. Cached per ticker for the cron run."""
    summary = _summary_for(ticker)
    return summary["market_cap"] if summary else None


def stock_price_for(ticker: str) -> float | None:
    """Returns the latest traded price for `ticker`, or None.
    Sharing the cache with market_cap_for so a single yfinance call
    serves both."""
    summary = _summary_for(ticker)
    return summary["last_price"] if summary else None


_SUMMARY_CACHE: dict[str, dict[str, float | int | None] | None] = {}


def _summary_for(ticker: str) -> dict[str, float | int | None] | None:
    """Single yfinance fast_info call for a ticker, returning both
    market cap (int) and last price (float). Cached per cron run."""
    if not ticker:
        return None
    if ticker in _SUMMARY_CACHE:
        return _SUMMARY_CACHE[ticker]
    out: dict[str, float | int | None] | None = None
    try:
        import yfinance as yf

        info = yf.Ticker(ticker).fast_info

        def _get(key: str):
            try:
                return info[key]
            except (KeyError, TypeError):
                return getattr(info, key, None)

        cap_raw = _get("market_cap")
        price_raw = _get("last_price") or _get("last_traded_price")
        out = {
            "market_cap": int(cap_raw) if cap_raw and cap_raw > 0 else None,
            "last_price": float(price_raw) if price_raw and price_raw > 0 else None,
        }
    except Exception as exc:
        print(f"  yfinance({ticker}): {exc}")
    if out is None:
        print(f"  yfinance({ticker}): None (no value)")
    _SUMMARY_CACHE[ticker] = out
    # Keep _CACHE legacy key in sync so old callers still work.
    _CACHE[ticker] = out["market_cap"] if out else None
    return out
