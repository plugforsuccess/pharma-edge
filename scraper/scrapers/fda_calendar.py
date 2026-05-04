"""FDA calendar scrapers.

TODO(structure): FDA's PDUFA tracker isn't published as a clean public table
and the AdComm calendar page structure changes. Both `fetch_pdufa_dates`
and `fetch_adcomm_meetings` are best-effort and may return empty if FDA
restructures the page. The press-release RSS feed is reliable.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import feedparser
import requests
from bs4 import BeautifulSoup

UA = {"User-Agent": "Mozilla/5.0 (compatible; PharmaEdge/1.0; research)"}


def fetch_pdufa_dates() -> list[dict[str, Any]]:
    url = "https://www.fda.gov/patients/drug-development-process/step-4-fda-drug-review"
    try:
        resp = requests.get(url, headers=UA, timeout=30)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  fetch_pdufa_dates: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    rows: list[dict[str, Any]] = []
    for table in soup.find_all("table"):
        for row in table.find_all("tr")[1:]:
            cells = row.find_all("td")
            if len(cells) < 3:
                continue
            rows.append(
                {
                    "drug": cells[0].get_text(strip=True),
                    "company": cells[1].get_text(strip=True) if len(cells) > 1 else "",
                    "pdufa_date": cells[2].get_text(strip=True) if len(cells) > 2 else "",
                    "indication": cells[3].get_text(strip=True) if len(cells) > 3 else "",
                    "source": url,
                }
            )
    return rows


def fetch_adcomm_meetings() -> list[dict[str, Any]]:
    url = "https://www.fda.gov/advisory-committees/advisory-committee-calendar"
    try:
        resp = requests.get(url, headers=UA, timeout=30)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  fetch_adcomm_meetings: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "lxml")
    out: list[dict[str, Any]] = []
    for entry in soup.find_all("div", class_="views-row"):
        title = entry.find("h3")
        date_elem = entry.find("span", class_="date-display-single")
        if title and date_elem:
            out.append(
                {
                    "title": title.get_text(strip=True),
                    "date": date_elem.get_text(strip=True),
                    "source": url,
                    "type": "adcomm",
                }
            )
    return out


_DRUG_KEYWORDS = (
    "drug", "approval", "approve", "approved", "approves", "clinical",
    "biologic", "treatment", "therapy", "therapeutic", "pdufa", "ind",
    "nda", "bla", "vaccine", "warning letter", "complete response",
    "recall", "adverse", "ema", "indication",
)


def fetch_fda_press_releases(days_back: int = 7) -> list[dict[str, Any]]:
    feed_url = (
        "https://www.fda.gov/about-fda/contact-fda/stay-informed/"
        "rss-feeds/press-releases/rss.xml"
    )
    try:
        feed = feedparser.parse(feed_url)
    except Exception as exc:
        print(f"  fetch_fda_press_releases: {exc}")
        return []

    since = datetime.utcnow() - timedelta(days=days_back)
    out: list[dict[str, Any]] = []
    for entry in feed.entries:
        published_parsed = getattr(entry, "published_parsed", None)
        if not published_parsed:
            continue
        published = datetime(*published_parsed[:6])
        if published <= since:
            continue
        # FDA's press feed covers the whole agency (food, tobacco, devices,
        # cosmetics). Only keep entries that look drug/biologic-related so
        # the digest + scanner queue don't drown in non-actionable noise.
        haystack = f"{entry.get('title', '')} {entry.get('summary', '')}".lower()
        if not any(kw in haystack for kw in _DRUG_KEYWORDS):
            continue
        out.append(
            {
                "title": entry.title,
                "link": entry.link,
                "published": published.isoformat(),
                "summary": entry.get("summary", ""),
                "type": _classify(entry.title),
            }
        )
    return out


def _classify(title: str) -> str:
    t = title.lower()
    if "approves" in t or "approved" in t:
        return "approval"
    if "rejects" in t or "denied" in t or "complete response" in t:
        return "rejection"
    if "warning" in t or "safety" in t:
        return "safety"
    if "advisory committee" in t or "adcom" in t:
        return "adcomm"
    return "other"
