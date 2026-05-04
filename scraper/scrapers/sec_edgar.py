"""SEC EDGAR full-text search + Form 4 + S-3 fetchers.

SEC requires a real contact email in the User-Agent header per their fair-use
policy. Set `SEC_USER_AGENT` env var to a value like "PharmaEdge you@example.com"
— the value is supplied via env, not hardcoded, so we don't ship a personal
address in the repo.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta
from typing import Any

import requests

EDGAR_BASE = "https://data.sec.gov"
EDGAR_FTS = "https://efts.sec.gov/LATEST/search-index"
EDGAR_TICKERS = "https://www.sec.gov/files/company_tickers.json"

# Suffixes that show up on CT.gov sponsor names but not in SEC's title.
_COMPANY_SUFFIX_RX = re.compile(
    r"\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|"
    r"plc|holdings|holding|group|sa|nv|ag|ab|gmbh|the)\b\.?",
    re.IGNORECASE,
)


def _normalize_company(name: str) -> str:
    """Normalize a company name for fuzzy matching against SEC's ticker map.
    Lowercases, drops corporate-form suffixes, strips non-alphanumerics."""
    if not name:
        return ""
    n = _COMPANY_SUFFIX_RX.sub("", name.lower())
    return re.sub(r"[^a-z0-9]", "", n)


def _headers() -> dict[str, str]:
    ua = os.environ.get("SEC_USER_AGENT")
    if not ua:
        raise RuntimeError(
            "SEC_USER_AGENT must be set — SEC requires a real contact email in "
            "the User-Agent header. Example: 'PharmaEdge you@example.com'."
        )
    return {"User-Agent": ua, "Accept-Encoding": "gzip, deflate"}


def load_ticker_map() -> dict[str, str]:
    """Fetch SEC's company_tickers.json once and build a normalized
    company-name → ticker map. Returns {} on failure (caller should
    fall back to leaving ticker empty)."""
    try:
        resp = requests.get(EDGAR_TICKERS, headers=_headers(), timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        print(f"  load_ticker_map: {exc}")
        return {}

    out: dict[str, str] = {}
    for row in data.values():
        title = row.get("title", "")
        ticker = row.get("ticker", "")
        if not title or not ticker:
            continue
        key = _normalize_company(title)
        if key and key not in out:
            out[key] = ticker.upper()
    return out


def resolve_ticker(company_name: str, ticker_map: dict[str, str]) -> str:
    """Best-effort sponsor → ticker. Tries exact normalized match, then
    a prefix match (for cases like 'Acme Therapeutics, Inc.' → SEC's
    'Acme Therapeutics Inc')."""
    if not company_name or not ticker_map:
        return ""
    key = _normalize_company(company_name)
    if not key:
        return ""
    if key in ticker_map:
        return ticker_map[key]
    # Prefix fallback — only accept if exactly one candidate matches,
    # otherwise we'd be guessing between e.g. multiple "BIO*" tickers.
    matches = [t for k, t in ticker_map.items() if k.startswith(key) or key.startswith(k)]
    if len(matches) == 1:
        return matches[0]
    return ""


def fetch_biotech_8k(days_back: int = 1) -> list[dict[str, Any]]:
    since = (datetime.utcnow() - timedelta(days=days_back)).strftime("%Y-%m-%d")
    params = {
        "q": "(clinical trial OR FDA OR PDUFA OR phase 3 OR phase 2)",
        "dateRange": "custom",
        "startdt": since,
        "forms": "8-K",
    }
    try:
        resp = requests.get(EDGAR_FTS, params=params, headers=_headers(), timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        print(f"  fetch_biotech_8k: {exc}")
        return []

    out: list[dict[str, Any]] = []
    for hit in data.get("hits", {}).get("hits", [])[:50]:
        src = hit.get("_source", {}) or {}
        tickers = src.get("tickers") or []
        out.append(
            {
                "ticker": tickers[0] if tickers else "",
                "company": src.get("entity_name", ""),
                "filed_at": src.get("file_date", ""),
                "form_type": src.get("form_type", "8-K"),
                "filing_url": (
                    f"https://www.sec.gov/Archives/edgar/{src.get('file_path', '')}"
                ),
                "description": src.get("period_of_report", ""),
                "cik": src.get("entity_id", ""),
            }
        )
    return out


def fetch_insider_transactions(ticker: str, cik: str) -> dict[str, Any]:
    if not cik:
        return {"ticker": ticker, "insider_filings_30d": 0, "has_recent_insider_activity": False}
    url = f"{EDGAR_BASE}/submissions/CIK{cik.zfill(10)}.json"
    try:
        resp = requests.get(url, headers=_headers(), timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return {"ticker": ticker, "insider_filings_30d": 0, "has_recent_insider_activity": False}

    recent = data.get("filings", {}).get("recent", {}) or {}
    forms = recent.get("form", []) or []
    dates = recent.get("filingDate", []) or []
    documents = recent.get("primaryDocument", []) or []

    cutoff = datetime.utcnow() - timedelta(days=30)
    recent_form4: list[dict[str, str]] = []
    for idx, form in enumerate(forms):
        if form != "4":
            continue
        try:
            filed = datetime.strptime(dates[idx], "%Y-%m-%d")
        except (IndexError, ValueError):
            continue
        if filed > cutoff:
            recent_form4.append(
                {
                    "date": dates[idx],
                    "document": documents[idx] if idx < len(documents) else "",
                }
            )
        if len(recent_form4) >= 10:
            break

    return {
        "ticker": ticker,
        "insider_filings_30d": len(recent_form4),
        "has_recent_insider_activity": bool(recent_form4),
        "filings": recent_form4,
    }


def fetch_shelf_offerings(days_back: int = 30) -> list[dict[str, Any]]:
    since = (datetime.utcnow() - timedelta(days=days_back)).strftime("%Y-%m-%d")
    params = {
        "dateRange": "custom",
        "startdt": since,
        "forms": "S-3",
    }
    try:
        resp = requests.get(EDGAR_FTS, params=params, headers=_headers(), timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        print(f"  fetch_shelf_offerings: {exc}")
        return []

    out: list[dict[str, Any]] = []
    for hit in data.get("hits", {}).get("hits", [])[:30]:
        src = hit.get("_source", {}) or {}
        tickers = src.get("tickers") or []
        out.append(
            {
                "ticker": tickers[0] if tickers else "",
                "company": src.get("entity_name", ""),
                "filed_at": src.get("file_date", ""),
                "form_type": "S-3",
                "signal": "Shelf offering registered — potential dilution incoming",
            }
        )
    return out
