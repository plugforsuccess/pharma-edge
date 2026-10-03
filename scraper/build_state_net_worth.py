#!/usr/bin/env python3
"""Net worth by state for the Peers card (owner, 2026-10-03: "what about
compared to your state?").

The Federal Reserve's SCF has no geography, so the state rows come from the
Census Bureau's Survey of Income and Program Participation (SIPP) 2023
panel (reference year 2022), via the Census API — household net worth
(THNETWORTH) for each household's reference person in December, weighted
(WPFINWGT), by state (TEHC_ST), all ages and by age band. Written to
src/data/stateNetWorth.json. SIPP undercounts the very wealthy compared
with the SCF, so the card labels these rows as a separate source.

Run by .github/workflows/state-net-worth.yml (api.census.gov and
api.bls.gov aren't reachable from the dev sandbox). Env: CENSUS_API_KEY
(optional; raises the daily request limit). Stdlib only.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SIPP_YEAR = 2023
REF_YEAR = 2022  # the 2023 panel asks about calendar 2022
BLS_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0?startyear={a}&endyear={b}"
OUT = Path(__file__).resolve().parents[1] / "src" / "data" / "stateNetWorth.json"
PERCENTILES = [float(p) for p in range(1, 100)] + [99.5, 99.9]
MIN_HOUSEHOLDS = 100
AGE_BANDS = [(0, 35, "under_35"), (35, 45, "35_44"), (45, 55, "45_54"), (55, 65, "55_64"), (65, 75, "65_74"), (75, 999, "75_plus")]
FIPS = {
    "01": ("AL", "Alabama"), "02": ("AK", "Alaska"), "04": ("AZ", "Arizona"), "05": ("AR", "Arkansas"), "06": ("CA", "California"),
    "08": ("CO", "Colorado"), "09": ("CT", "Connecticut"), "10": ("DE", "Delaware"), "11": ("DC", "District of Columbia"),
    "12": ("FL", "Florida"), "13": ("GA", "Georgia"), "15": ("HI", "Hawaii"), "16": ("ID", "Idaho"), "17": ("IL", "Illinois"),
    "18": ("IN", "Indiana"), "19": ("IA", "Iowa"), "20": ("KS", "Kansas"), "21": ("KY", "Kentucky"), "22": ("LA", "Louisiana"),
    "23": ("ME", "Maine"), "24": ("MD", "Maryland"), "25": ("MA", "Massachusetts"), "26": ("MI", "Michigan"), "27": ("MN", "Minnesota"),
    "28": ("MS", "Mississippi"), "29": ("MO", "Missouri"), "30": ("MT", "Montana"), "31": ("NE", "Nebraska"), "32": ("NV", "Nevada"),
    "33": ("NH", "New Hampshire"), "34": ("NJ", "New Jersey"), "35": ("NM", "New Mexico"), "36": ("NY", "New York"),
    "37": ("NC", "North Carolina"), "38": ("ND", "North Dakota"), "39": ("OH", "Ohio"), "40": ("OK", "Oklahoma"), "41": ("OR", "Oregon"),
    "42": ("PA", "Pennsylvania"), "44": ("RI", "Rhode Island"), "45": ("SC", "South Carolina"), "46": ("SD", "South Dakota"),
    "47": ("TN", "Tennessee"), "48": ("TX", "Texas"), "49": ("UT", "Utah"), "50": ("VT", "Vermont"), "51": ("VA", "Virginia"),
    "53": ("WA", "Washington"), "54": ("WV", "West Virginia"), "55": ("WI", "Wisconsin"), "56": ("WY", "Wyoming"),
}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "cash-moves-benchmarks/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def census_rows(year: int, with_predicate: bool) -> list | None:
    """One API shape; None when the API answers with something other than
    JSON (the message is printed so the next run says what changed)."""
    get = "MONTHCODE,ERELRPE,TAGE,WPFINWGT,THNETWORTH,TEHC_ST"
    params = {"get": get}
    if with_predicate:
        params["MONTHCODE"] = "12"
    key = os.environ.get("CENSUS_API_KEY")
    if key:
        params["key"] = key
    url = f"https://api.census.gov/data/{year}/sipp?{urllib.parse.urlencode(params)}"
    try:
        body = fetch(url)
    except urllib.error.HTTPError as e:
        print(f"SIPP {year} predicate={with_predicate}: HTTP {e.code} {e.read()[:300]!r}", file=sys.stderr)
        return None
    try:
        rows = json.loads(body)
    except json.JSONDecodeError:
        print(f"SIPP {year} predicate={with_predicate}: not JSON: {body[:300]!r}", file=sys.stderr)
        return None
    if not rows or not isinstance(rows[0], list):
        print(f"SIPP {year} predicate={with_predicate}: unexpected shape", file=sys.stderr)
        return None
    print(f"SIPP {year} predicate={with_predicate}: {len(rows) - 1} rows", file=sys.stderr)
    return rows


def load_sipp() -> tuple[int, list[tuple[str, int, float, float]]]:
    """(panel year, [(state FIPS, age, weight, household net worth)]) for
    every reference person in December. Tries the newest panel first and
    the MONTHCODE predicate first (without it the API returns all months)."""
    for year in (SIPP_YEAR, SIPP_YEAR - 1):
        for with_predicate in (True, False):
            rows = census_rows(year, with_predicate)
            if rows:
                break
        else:
            continue
        head = rows[0]
        idx = {name: head.index(name) for name in ("MONTHCODE", "ERELRPE", "TAGE", "WPFINWGT", "THNETWORTH", "TEHC_ST")}
        out = []
        for r in rows[1:]:
            try:
                if str(r[idx["MONTHCODE"]]) != "12" or str(r[idx["ERELRPE"]]) not in ("1", "2"):
                    continue
                w = float(r[idx["WPFINWGT"]])
                nw = float(r[idx["THNETWORTH"]])
                age = int(float(r[idx["TAGE"]]))
            except (TypeError, ValueError):
                continue
            if w <= 0:
                continue
            out.append((str(r[idx["TEHC_ST"]]).zfill(2), age, w, nw))
        if out:
            return year, out
    raise SystemExit("SIPP: no usable response from the Census API")


def weighted_percentiles(pairs: list[tuple[float, float]], ps: list[float]) -> list[float]:
    """pairs = (value, weight); Harrell-Davis-free linear interpolation on
    cumulative weight, like the SCF builder."""
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    cum = []
    acc = 0.0
    for v, w in pairs:
        acc += w
        cum.append((acc - w / 2) / total)
    out = []
    j = 0
    for p in ps:
        q = p / 100
        while j < len(cum) - 1 and cum[j] < q:
            j += 1
        if j == 0 or cum[j] <= q:
            out.append(pairs[j][0])
            continue
        lo_c, hi_c = cum[j - 1], cum[j]
        t = (q - lo_c) / (hi_c - lo_c) if hi_c > lo_c else 0.0
        out.append(pairs[j - 1][0] + t * (pairs[j][0] - pairs[j - 1][0]))
    return out


def cpi_factor(year: int) -> tuple[float, str]:
    now = datetime.now(timezone.utc).year
    data = json.loads(fetch(BLS_URL.format(a=year, b=now)))
    if data.get("status") != "REQUEST_SUCCEEDED":
        raise SystemExit(f"BLS CPI request failed: {data.get('message')}")
    rows = [r for r in data["Results"]["series"][0]["data"] if r["period"].startswith("M") and r["period"] != "M13"]
    base = [float(r["value"]) for r in rows if int(r["year"]) == year]
    if len(base) != 12:
        raise SystemExit(f"CPI: expected 12 months for {year}, got {len(base)}")
    latest = max(rows, key=lambda r: (int(r["year"]), r["period"]))
    label = datetime(int(latest["year"]), int(latest["period"][1:]), 1).strftime("%b %Y")
    return float(latest["value"]) / (sum(base) / 12), label


def group(recs: list[tuple[str, int, float, float]], factor: float) -> dict | None:
    if len(recs) < MIN_HOUSEHOLDS:
        return None
    pairs = [(nw * factor, w) for _, _, w, nw in recs]
    total = sum(w for _, w in pairs)
    return {
        "households": len(recs),
        "values": [round(v) for v in weighted_percentiles(pairs, PERCENTILES)],
        "mean": round(sum(v * w for v, w in pairs) / total),
    }


def build(recs, factor: float, cpi_label: str, year: int = SIPP_YEAR, ref_year: int = REF_YEAR) -> dict:
    states = {}
    for fips, (code, name) in FIPS.items():
        mine = [r for r in recs if r[0] == fips]
        g = group(mine, factor)
        if not g:
            continue
        by_age = {}
        for lo, hi, band in AGE_BANDS:
            ga = group([r for r in mine if lo <= r[1] < hi], factor)
            if ga:
                by_age[band] = ga
        states[code] = {"name": name, **g, "by_age": by_age}
    return {
        "source": {
            "survey": f"Census Bureau Survey of Income and Program Participation {year}",
            "reference_year": ref_year,
            "api": f"https://api.census.gov/data/{year}/sipp",
            "dollars": f"{ref_year} dollars adjusted by CPI-U to {cpi_label}",
            "cpi_factor": round(factor, 6),
            "cpi_month": cpi_label,
            "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "min_households": MIN_HOUSEHOLDS,
            "note": "SIPP undercounts the wealthiest households compared with the SCF; state ranks are a separate source.",
        },
        "percentiles": PERCENTILES,
        "states": states,
    }


def main() -> None:
    year, recs = load_sipp()
    if len(recs) < 10000:
        raise SystemExit(f"SIPP: only {len(recs)} reference persons — the API shape may have changed")
    ref_year = year - 1
    factor, label = cpi_factor(ref_year)
    result = build(recs, factor, label, year, ref_year)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    ga = result["states"].get("GA")
    print(f"Wrote {len(result['states'])} states from {len(recs)} households; CPI to {label}; "
          f"GA median {ga['values'][PERCENTILES.index(50.0)] if ga else 'n/a'}", file=sys.stderr)


if __name__ == "__main__":
    main()
