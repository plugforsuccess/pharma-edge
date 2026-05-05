"""ClinicalTrials.gov v2 API scraper.

Fetches upcoming Phase 2/3 readouts and looks for enrollment-velocity and
protocol-amendment red flags.

TODO(amendments): the spec'd /history endpoint does not exist on the v2 API.
`check_protocol_amendments` currently returns a no-op default; revisit when
the v2 history endpoint ships or wire up the legacy v1 study record diff.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta
from typing import Any

import requests

CTGOV_BASE = "https://clinicaltrials.gov/api/v2/studies"


def normalize_ct_date(raw: str) -> tuple[str | None, str]:
    """CT.gov returns dates at varying precision (estimated dates can be
    YYYY-MM or even YYYY only). signals.catalyst_date is a DATE column
    so we MUST emit YYYY-MM-DD or NULL — and HTML <input type=date>
    won't accept partial formats either, so the prefill silently fails
    on month-only dates.

    Convention: month-only → first of month (01); year-only → Jan 1.
    The earliest-possible-date assumption is the conservative choice
    for options-buying — the strategy needs expiry > catalyst + 30d
    DTE, so assuming the catalyst could land on day 1 of the window
    forces longer-dated expiry choices and avoids being caught short
    if the actual date lands earlier in the month than expected.
    Precision flag goes on raw_data so the UI can label it 'estimated'
    and prompt the user to confirm before locking.
    """
    if not raw:
        return None, "unknown"
    raw = raw.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return raw, "day"
    if re.fullmatch(r"\d{4}-\d{2}", raw):
        return f"{raw}-01", "month"
    if re.fullmatch(r"\d{4}", raw):
        return f"{raw}-01-01", "year"
    return None, "unknown"


def fetch_upcoming_readouts(days_ahead: int = 120) -> list[dict[str, Any]]:
    """Trials with primary completion in the next N days. Phase 2/3 only."""
    end_date = (datetime.utcnow() + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
    today = datetime.utcnow().strftime("%Y-%m-%d")

    # CT.gov v2 only exposes a small fixed set of `filter.*` params:
    # overallStatus, geo, ids, advanced, synonyms. There is no
    # `filter.primaryCompletionDate` — date ranges go through
    # `filter.advanced` using Essie syntax. Phase is also expressed
    # there rather than at the API top level. We still re-check phase
    # in score_trial() against the returned `phases` array.
    advanced = (
        f"AREA[PrimaryCompletionDate]RANGE[{today},{end_date}]"
        " AND AREA[Phase](PHASE2 OR PHASE3)"
    )
    params: dict[str, Any] = {
        "filter.overallStatus": "ACTIVE_NOT_RECRUITING,RECRUITING",
        "filter.advanced": advanced,
        "fields": (
            "NCTId,BriefTitle,OverallStatus,Phase,"
            "PrimaryCompletionDate,LeadSponsorName,EnrollmentCount"
        ),
        "pageSize": 100,
        "format": "json",
    }

    trials: list[dict[str, Any]] = []
    next_token: str | None = None

    while True:
        if next_token:
            params["pageToken"] = next_token

        resp = requests.get(CTGOV_BASE, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        trials.extend(data.get("studies", []))

        next_token = data.get("nextPageToken")
        if not next_token:
            break

        time.sleep(0.5)

    return trials


def detect_enrollment_anomalies(nct_id: str) -> dict[str, Any]:
    """Detailed enrollment + site status for a single trial."""
    if not nct_id:
        return {}
    try:
        resp = requests.get(f"{CTGOV_BASE}/{nct_id}", params={"format": "json"}, timeout=30)
        if resp.status_code != 200:
            return {}
        data = resp.json()
    except Exception:
        return {}

    protocol = data.get("protocolSection", {})
    status_module = protocol.get("statusModule", {})
    locations = (
        protocol.get("contactsLocationsModule", {}).get("locations", []) or []
    )

    active_sites = [loc for loc in locations if loc.get("status") == "RECRUITING"]
    terminated_sites = [
        loc for loc in locations if loc.get("status") in {"TERMINATED", "WITHDRAWN"}
    ]

    why_stopped = status_module.get("whyStopped", "") or ""

    return {
        "nct_id": nct_id,
        "active_sites": len(active_sites),
        "terminated_sites": len(terminated_sites),
        "termination_rate": (
            len(terminated_sites) / len(locations) if locations else 0.0
        ),
        "why_stopped": why_stopped,
        "enrollment_signal": len(terminated_sites) > 2 or bool(why_stopped),
    }


def check_protocol_amendments(nct_id: str) -> dict[str, Any]:
    """Placeholder: CT.gov v2 has no public history endpoint. Returns a
    no-op result so the scoring step doesn't blow up."""
    return {"nct_id": nct_id, "has_amendment": False, "endpoint_changes": 0}


def score_trial(
    trial: dict[str, Any],
    anomaly_data: dict[str, Any] | None = None,
    amendment_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Aggregate signal score (0–10) for a trial."""
    protocol = trial.get("protocolSection", {})
    ident = protocol.get("identificationModule", {})
    status = protocol.get("statusModule", {})
    design = protocol.get("designModule", {})
    outcomes = protocol.get("outcomesModule", {})

    phases = design.get("phases") or [""]
    phase = phases[0]
    enrollment = (design.get("enrollmentInfo") or {}).get("count", 0)
    primary_outcomes = outcomes.get("primaryOutcomes") or []
    conditions = (protocol.get("conditionsModule", {}) or {}).get("conditions", []) or []
    sponsor = (
        protocol.get("sponsorCollaboratorsModule", {}).get("leadSponsor", {}) or {}
    )

    score = 0
    flags: list[str] = []

    if "PHASE3" in str(phase):
        score += 3
        flags.append("Phase 3 — high stakes readout")
    elif "PHASE2" in str(phase):
        score += 2

    if enrollment and enrollment < 200:
        score += 1
        flags.append(f"Small trial (n={enrollment}) — high variance outcome")

    if len(primary_outcomes) > 2:
        score += 2
        flags.append(
            f"{len(primary_outcomes)} primary endpoints — possible endpoint fishing"
        )

    if anomaly_data:
        if anomaly_data.get("terminated_sites", 0) > 2:
            score += 3
            flags.append(
                f"{anomaly_data['terminated_sites']} investigator sites terminated"
            )
        if anomaly_data.get("why_stopped"):
            score += 4
            flags.append(f"Trial stopped: {anomaly_data['why_stopped']}")

    if amendment_data and amendment_data.get("has_amendment"):
        score += 3
        flags.append("Recent protocol amendment detected — endpoint change possible")

    raw_pc = (status.get("primaryCompletionDateStruct") or {}).get("date", "")
    pc_normalized, pc_precision = normalize_ct_date(raw_pc)
    interventions = (
        (protocol.get("armsInterventionsModule") or {}).get("interventions") or []
    )
    drug_name = ""
    if interventions:
        drug_name = (interventions[0].get("name", "") or "").strip()
    indication = conditions[0] if conditions else ""
    return {
        "nct_id": ident.get("nctId", ""),
        "title": ident.get("briefTitle", ""),
        "sponsor": sponsor.get("name", ""),
        "drug_name": drug_name,
        "indication": indication,
        "phase": phase,
        "conditions": conditions,
        "enrollment": enrollment,
        "score": min(score, 10),
        "flags": flags,
        "primary_completion": pc_normalized,
        # Mirror onto a shared key so downstream main.py / UI can read
        # one consistent field regardless of which scraper produced it.
        "catalyst_date_raw": raw_pc,
        "catalyst_date_precision": pc_precision,
    }
