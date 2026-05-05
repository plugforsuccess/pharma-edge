"""One-shot backfill: scanner_candidates rows that predate the
drug_name / indication capture (commit 4a20558) have those fields
missing from raw_data. This script finds any open candidate with
an nct_id but no drug_name, re-fetches the CT.gov record, and
updates raw_data in place.

Run locally where CT.gov is reachable (the GitHub Actions runner
is fine; the cron sandbox isn't):

    cd scraper
    source .venv/bin/activate            # if not already
    python -m backfill_drug_indication

Idempotent — re-running it leaves already-backfilled rows alone.
"""

from __future__ import annotations

import os
import time
from typing import Any

import requests
from dotenv import load_dotenv

from db.supabase_client import get_supabase
from scrapers.clinicaltrials import CTGOV_BASE


def _fetch_study(nct_id: str) -> dict[str, Any] | None:
    try:
        resp = requests.get(
            f"{CTGOV_BASE}/{nct_id}",
            params={"format": "json"},
            timeout=20,
        )
        if resp.status_code != 200:
            print(f"  {nct_id}: HTTP {resp.status_code}")
            return None
        return resp.json()
    except Exception as exc:
        print(f"  {nct_id}: {exc}")
        return None


def _extract(study: dict[str, Any]) -> tuple[str, str]:
    protocol = study.get("protocolSection") or {}
    interventions = (
        (protocol.get("armsInterventionsModule") or {}).get("interventions") or []
    )
    drug_name = ""
    if interventions:
        drug_name = (interventions[0].get("name", "") or "").strip()
    conditions = (protocol.get("conditionsModule") or {}).get("conditions") or []
    indication = conditions[0] if conditions else ""
    return drug_name, indication


def main() -> None:
    load_dotenv()
    supabase = get_supabase()
    rows = (
        supabase.table("scanner_candidates")
        .select("id, ticker, nct_id, raw_data")
        .eq("source", "clinicaltrials")
        .eq("dismissed", False)
        .not_.is_("nct_id", "null")
        .execute()
        .data
        or []
    )
    print(f"{len(rows)} CT.gov candidates to inspect")
    backfilled = 0
    for row in rows:
        rd = row.get("raw_data") or {}
        if rd.get("drug_name") and rd.get("indication"):
            continue  # already backfilled
        nct = row.get("nct_id")
        if not nct:
            continue
        study = _fetch_study(nct)
        if not study:
            continue
        drug_name, indication = _extract(study)
        if not drug_name and not indication:
            print(f"  {row['ticker']} {nct}: no drug/indication in study record")
            continue
        new_rd = {**rd, "drug_name": drug_name, "indication": indication}
        supabase.table("scanner_candidates").update({"raw_data": new_rd}).eq(
            "id", row["id"]
        ).execute()
        print(f"  {row['ticker']} {nct}: drug={drug_name!r} indication={indication!r}")
        backfilled += 1
        time.sleep(0.5)  # be polite to CT.gov

    print(f"backfilled {backfilled} rows")


if __name__ == "__main__":
    main()
