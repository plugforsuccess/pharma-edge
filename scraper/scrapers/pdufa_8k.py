"""PDUFA-from-8-K scanner.

Public companies are required to disclose a newly-assigned PDUFA action
date as material information via 8-K (typically Item 8.01) within 4
business days. We hit SEC EDGAR's full-text search for 8-Ks mentioning
PDUFA action/goal/target dates, fetch the filing body, regex out the
date, and return a candidate dict.

This is the free replacement for the broken FDA Step-4 PDUFA tracker
scraper (`scrapers.fda_calendar.fetch_pdufa_dates`) — see CLAUDE.md.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta
from typing import Any

import requests
from dateutil import parser as dateparser

EDGAR_FTS = "https://efts.sec.gov/LATEST/search-index"

# "PDUFA <stuff> action/goal/target date <of/is/on?> <Month Day, Year | M/D/YYYY>"
PDUFA_DATE_RX = re.compile(
    r"PDUFA[^.]{0,80}?(?:action date|goal date|target date)[^.]{0,40}?"
    r"(?:of |is |on |set for |scheduled for |assigned |to be )?"
    r"([A-Za-z]+ \d{1,2},? \d{4}|\d{1,2}/\d{1,2}/\d{2,4})",
    re.IGNORECASE,
)


def _headers() -> dict[str, str]:
    ua = os.environ.get("SEC_USER_AGENT")
    if not ua:
        raise RuntimeError("SEC_USER_AGENT must be set for PDUFA scanner")
    return {"User-Agent": ua, "Accept-Encoding": "gzip, deflate"}


def fetch_pdufa_8k(days_back: int = 14) -> list[dict[str, Any]]:
    """Return [{ticker, company_name, cik, pdufa_date, filing_url, file_date,
    excerpt, flags}] for every 8-K in the window that mentions a PDUFA
    action/goal/target date. `pdufa_date` may be None if the filing
    references PDUFA but our regex couldn't lock onto a date — in that
    case the candidate still goes through with a 'review filing' flag
    so the user gets a pointer instead of a silent miss."""
    since = (datetime.utcnow() - timedelta(days=days_back)).strftime("%Y-%m-%d")
    today = datetime.utcnow().strftime("%Y-%m-%d")
    # Same parens-AND-OR shape as the proven `fetch_biotech_8k` query.
    # Bare-word and quoted-phrase queries both came back empty against
    # this endpoint; this matches the working pattern. enddt is required
    # alongside startdt or SEC FTS silently ignores the date range.
    params = {
        "q": "(PDUFA AND (action OR goal OR target) AND date)",
        "dateRange": "custom",
        "startdt": since,
        "enddt": today,
        "forms": "8-K",
    }
    try:
        resp = requests.get(EDGAR_FTS, params=params, headers=_headers(), timeout=30)
        resp.raise_for_status()
        body = resp.json()
    except Exception as exc:
        print(f"  fetch_pdufa_8k: {exc}")
        return []

    # Diagnostic: log SEC's reported total + the keys we got back so we
    # can spot future query-shape regressions without having to print
    # the full body to scan_log.
    total = (body.get("hits") or {}).get("total")
    raw_hits = body.get("hits", {}).get("hits", []) or []
    print(
        f"  fetch_pdufa_8k: total={total} raw_hits={len(raw_hits)} "
        f"keys={list(body.keys())}"
    )

    out: list[dict[str, Any]] = []
    for hit in raw_hits[:30]:
        src = hit.get("_source") or {}
        file_path = src.get("file_path", "")
        if not file_path:
            continue
        tickers = src.get("tickers") or []
        ticker = tickers[0].upper() if tickers else ""
        company = src.get("entity_name", "") or ""
        # SEC FTS returns CIKs in a `ciks` array (zero-padded strings);
        # `entity_id` is a different identifier and isn't the CIK.
        ciks = src.get("ciks") or []
        cik = ciks[0] if ciks else ""
        filing_url = f"https://www.sec.gov/Archives/edgar/{file_path}"
        pdufa_date, excerpt = _extract_pdufa_date(filing_url)

        flags: list[str] = []
        if pdufa_date:
            flags.append(f"PDUFA action date: {pdufa_date}")
        else:
            flags.append("PDUFA mentioned — date parse failed, review filing")

        out.append(
            {
                "ticker": ticker,
                "company_name": company,
                "cik": cik,
                "pdufa_date": pdufa_date,
                "filing_url": filing_url,
                "file_date": src.get("file_date", ""),
                "excerpt": excerpt,
                "flags": flags,
            }
        )
    return out


def _extract_pdufa_date(filing_url: str) -> tuple[str | None, str]:
    """Fetch the 8-K body, regex out the latest PDUFA date if present.
    Returns (YYYY-MM-DD or None, short excerpt for raw_data)."""
    try:
        resp = requests.get(filing_url, headers=_headers(), timeout=20)
        resp.raise_for_status()
        text = resp.text
    except Exception as exc:
        return None, f"fetch failed: {exc}"

    matches = list(PDUFA_DATE_RX.finditer(text))
    if not matches:
        return None, ""

    # When a filing references multiple dates (e.g. "the prior PDUFA of
    # Jan 5, 2026 has been extended to Mar 5, 2026"), take the latest —
    # PDUFAs are forward-looking and the more recent date is the active
    # target. We also drop any parsed dates older than today.
    cutoff = datetime.utcnow().date()
    parsed: list[tuple[datetime, str]] = []
    for m in matches:
        raw = m.group(1)
        try:
            dt = dateparser.parse(raw, fuzzy=False)
        except (ValueError, OverflowError, TypeError):
            continue
        if not dt or dt.date() < cutoff:
            continue
        start = max(0, m.start() - 40)
        end = min(len(text), m.end() + 40)
        excerpt = re.sub(r"\s+", " ", text[start:end]).strip()
        parsed.append((dt, excerpt))

    if not parsed:
        return None, ""

    parsed.sort(key=lambda x: x[0])
    latest = parsed[-1]
    return latest[0].strftime("%Y-%m-%d"), latest[1]
