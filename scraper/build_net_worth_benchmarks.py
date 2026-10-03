"""Net worth benchmarks for the peer comparison card (Portfolio → Peers).

Builds src/data/netWorthBenchmarks.json from the Federal Reserve's Survey
of Consumer Finances 2022 summary extract (public microdata), so every
number on the card traces back to the source file:

  1. Downloads the summary extract (Stata) from federalreserve.gov.
  2. Weighted net worth percentiles (1st–99th, 99.5th, 99.9th) for all
     households and for groups: age band, couple / single, homeowner /
     renter, income band, education, race / ethnicity, and single women /
     men — each also crossed with the age band when the cross has at
     least MIN_HOUSEHOLDS households in the sample.
  3. Adjusts 2022 dollars to the latest CPI-U month (BLS public API).

Run by .github/workflows/net-worth-benchmarks.yml (federalreserve.gov
and api.bls.gov are reachable from Actions). Locally:
  pip install pandas && python scraper/build_net_worth_benchmarks.py

The SCF public data has no geography, so there is no state / region
comparison. Rows are 5 implicates per household (multiple imputation);
weights (WGT) are used as published, and household counts are rows / 5.
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

import pandas as pd

SCF_URL = os.environ.get("SCF_URL", "https://www.federalreserve.gov/econres/files/scfp2022s.zip")
SCF_YEAR = 2022
BLS_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0?startyear={a}&endyear={b}"
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "data", "netWorthBenchmarks.json")

PERCENTILES = [float(p) for p in range(1, 100)] + [99.5, 99.9]
MIN_HOUSEHOLDS = 100
# Income bands = the SCF's own INCCAT cut points (percentiles of income).
INCOME_BAND_EDGES = [0, 20, 40, 60, 80, 90, 100]

AGE_BANDS = {1: "under_35", 2: "35_44", 3: "45_54", 4: "55_64", 5: "65_74", 6: "75_plus"}
EDUCATION = {1: "no_hs", 2: "hs", 3: "some_college", 4: "bachelors"}
RACE = {1: "white", 2: "black", 3: "hispanic", 4: "other"}
NEEDED = ["networth", "wgt", "agecl", "hhsex", "married", "edcl", "racecl4", "housecl", "income"]

UA = {"User-Agent": "cash-moves-benchmarks/1.0 (+https://cashmoves.io)"}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


def load_scf(raw: bytes | None = None) -> pd.DataFrame:
    raw = raw if raw is not None else fetch(SCF_URL)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".dta")]
        if not names:
            raise SystemExit(f"No .dta file in {SCF_URL}: {z.namelist()}")
        with z.open(names[0]) as f:
            df = pd.read_stata(io.BytesIO(f.read()), convert_categoricals=False)
    df.columns = [c.lower() for c in df.columns]
    missing = [c for c in NEEDED if c not in df.columns]
    if missing:
        raise SystemExit(f"SCF file is missing columns {missing}")
    return df[NEEDED].copy()


def weighted_percentiles(values: pd.Series, weights: pd.Series, ps: list[float]) -> list[float]:
    """Value at each percentile p (0–100): the weighted empirical
    quantile, interpolated between neighbouring observations."""
    order = values.argsort()
    v = values.to_numpy()[order]
    w = weights.to_numpy()[order]
    cw = w.cumsum()
    total = cw[-1]
    # Midpoint rule: each observation sits at the middle of its weight.
    pos = (cw - w / 2) / total * 100
    out = []
    for p in ps:
        if p <= pos[0]:
            out.append(float(v[0]))
        elif p >= pos[-1]:
            out.append(float(v[-1]))
        else:
            j = int((pos < p).sum())
            lo, hi = pos[j - 1], pos[j]
            t = (p - lo) / (hi - lo) if hi > lo else 0.0
            out.append(float(v[j - 1] + t * (v[j] - v[j - 1])))
    return out


def cpi_factor(year: int = SCF_YEAR) -> tuple[float, str]:
    """Latest CPI-U month ÷ the survey year's average (12 monthly values)."""
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


def build(df: pd.DataFrame, factor: float, cpi_label: str) -> dict:
    df = df.dropna(subset=["networth", "wgt"])
    nw = df["networth"] * factor
    w = df["wgt"]

    inc_cuts = weighted_percentiles(df["income"], w, INCOME_BAND_EDGES[1:-1])
    income_band = pd.cut(df["income"], bins=[-float("inf"), *inc_cuts, float("inf")],
                         labels=[f"p{a}_{b}" for a, b in zip(INCOME_BAND_EDGES, INCOME_BAND_EDGES[1:])])

    single = df["married"] == 2
    groups: dict[str, pd.Series] = {"all": pd.Series(True, index=df.index)}
    base_groups: dict[str, pd.Series] = {
        "household:couple": df["married"] == 1,
        "household:single": single,
        "home:owner": df["housecl"] == 1,
        "home:renter": df["housecl"] != 1,
        "sex:single_female": single & (df["hhsex"] == 2),
        "sex:single_male": single & (df["hhsex"] == 1),
    }
    for code, key in EDUCATION.items():
        base_groups[f"education:{key}"] = df["edcl"] == code
    for code, key in RACE.items():
        base_groups[f"race:{key}"] = df["racecl4"] == code
    for band in income_band.cat.categories:
        base_groups[f"income:{band}"] = income_band == band
    groups.update(base_groups)
    for code, band in AGE_BANDS.items():
        age = df["agecl"] == code
        groups[f"age:{band}"] = age
        for key, mask in base_groups.items():
            groups[f"age:{band}|{key}"] = age & mask

    out_groups = {}
    for key, mask in groups.items():
        households = int(mask.sum()) // 5
        if households < MIN_HOUSEHOLDS:
            continue
        vals = weighted_percentiles(nw[mask], w[mask], PERCENTILES)
        # Weighted mean too (owner asked for the average); it sits far above
        # the median because a few households hold most of the wealth.
        mean = float((nw[mask] * w[mask]).sum() / w[mask].sum())
        out_groups[key] = {"households": households, "values": [round(v) for v in vals], "mean": round(mean)}

    return {
        "source": {
            "survey": f"Federal Reserve Survey of Consumer Finances {SCF_YEAR}",
            "file": SCF_URL,
            "dollars": f"{SCF_YEAR} dollars adjusted by CPI-U to {cpi_label}",
            "cpi_factor": round(factor, 6),
            "cpi_month": cpi_label,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "min_households": MIN_HOUSEHOLDS,
        },
        "percentiles": PERCENTILES,
        "income_bands": {
            "edges_pct": INCOME_BAND_EDGES,
            # Household income cut points between the bands, in today's dollars.
            "cutoffs": [round(c * factor) for c in inc_cuts],
        },
        "age_bands": list(AGE_BANDS.values()),
        "groups": out_groups,
    }


def main() -> None:
    df = load_scf()
    factor, label = cpi_factor()
    result = build(df, factor, label)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(result, f, separators=(",", ":"))
        f.write("\n")
    med = result["groups"]["all"]["values"][PERCENTILES.index(50.0)]
    print(f"Wrote {len(result['groups'])} groups from {len(df) // 5} households; "
          f"median net worth ${med:,} ({result['source']['dollars']}).")


if __name__ == "__main__":
    sys.exit(main())
