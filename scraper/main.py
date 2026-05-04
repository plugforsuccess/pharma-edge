"""Pharma Edge daily scanner entrypoint.

Run from CI on a 12:00 UTC cron (= 7am ET in standard time, 8am ET during
DST — see CLAUDE.md). Locally, set the env vars in scraper/.env and run:

    python -m main
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from typing import Any

import requests
from dotenv import load_dotenv

# Allow running as `python main.py` from inside scraper/.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from analyzer.claude_analyzer import analyze_scanner_candidate, generate_daily_digest
from db.supabase_client import (
    get_supabase,
    insert_scanner_candidate,
    log_scanner_run,
)
from scrapers.clinicaltrials import (
    check_protocol_amendments,
    detect_enrollment_anomalies,
    fetch_upcoming_readouts,
    score_trial,
)
from scrapers.fda_calendar import (
    fetch_adcomm_meetings,
    fetch_fda_press_releases,
    fetch_pdufa_dates,
)
from scrapers.sec_edgar import fetch_biotech_8k, fetch_shelf_offerings


REQUIRED_ENVS = (
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ANTHROPIC_API_KEY",
    "SEC_USER_AGENT",
)


def preflight() -> None:
    """Bail out early with a clear message if any required env is missing."""
    missing = [k for k in REQUIRED_ENVS if not os.environ.get(k)]
    if missing:
        raise RuntimeError(
            "Missing required env vars: " + ", ".join(missing) +
            ". Set them via GitHub Actions secrets or scraper/.env"
        )


def send_alert_email(digest: str, candidate_count: int, fda_count: int) -> None:
    resend_api_key = os.environ.get("RESEND_API_KEY")
    alert_email = os.environ.get("ALERT_EMAIL")

    if not resend_api_key or not alert_email:
        print("  email credentials not set — skipping alert")
        return

    subject = (
        f"Pharma Edge Daily Scan — {candidate_count} candidates, "
        f"{fda_count} FDA events — {datetime.utcnow().strftime('%b %d, %Y')}"
    )

    # NOTE: onboarding@resend.dev only delivers to the Resend account owner's
    # verified address. Replace with a verified custom-domain sender before
    # opening the app to other users (see CLAUDE.md).
    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {resend_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": "onboarding@resend.dev",
                "to": alert_email,
                "subject": subject,
                "text": digest,
            },
            timeout=20,
        )
        print(f"  email sent: {resp.status_code}")
    except Exception as exc:
        print(f"  email send failed: {exc}")


def main() -> None:
    load_dotenv()
    preflight()

    print(f"[{datetime.utcnow().isoformat()}] Starting Pharma Edge daily scan...")
    scan_log: dict[str, Any] = {
        "started_at": datetime.utcnow().isoformat(),
        "results": {},
    }

    supabase = get_supabase()
    all_candidates: list[dict[str, Any]] = []
    errors: list[str] = []

    # ─── ClinicalTrials.gov ─────────────────────────────────────────
    print("Scanning ClinicalTrials.gov...")
    try:
        trials = fetch_upcoming_readouts(days_ahead=120)
        print(f"  {len(trials)} upcoming trial readouts")

        scored: list[dict[str, Any]] = []
        for trial in trials[:50]:
            try:
                nct_id = (
                    trial.get("protocolSection", {})
                    .get("identificationModule", {})
                    .get("nctId", "")
                )
                anomaly = detect_enrollment_anomalies(nct_id) if nct_id else {}
                amendment = check_protocol_amendments(nct_id) if nct_id else {}
                score_data = score_trial(trial, anomaly, amendment)
                if score_data["score"] >= 5:
                    scored.append(score_data)
            except Exception as exc:
                errors.append(f"trial scoring: {exc}")

        scored.sort(key=lambda x: x["score"], reverse=True)
        all_candidates.extend(scored[:10])

        log_scanner_run(
            supabase,
            "clinicaltrials",
            len(trials),
            len(scored),
            {"top_candidates": scored[:5]},
            "success",
        )
        scan_log["results"]["clinicaltrials"] = {
            "scanned": len(trials),
            "flagged": len(scored),
        }
    except Exception as exc:
        msg = f"ClinicalTrials scan failed: {exc}"
        print(f"  {msg}")
        errors.append(msg)
        try:
            log_scanner_run(
                supabase, "clinicaltrials", 0, 0, {}, "failed", error_log=msg
            )
        except Exception:
            pass

    # ─── FDA Calendar ────────────────────────────────────────────────
    print("Scanning FDA calendar...")
    fda_events: list[dict[str, Any]] = []
    try:
        pdufa = fetch_pdufa_dates()
        adcomm = fetch_adcomm_meetings()
        press = fetch_fda_press_releases(days_back=1)
        fda_events = pdufa + adcomm + press
        print(f"  PDUFA={len(pdufa)} adcomm={len(adcomm)} press={len(press)}")

        log_scanner_run(
            supabase,
            "fda_calendar",
            len(fda_events),
            len(press),
            {
                "pdufa": pdufa[:5],
                "adcomm": adcomm[:5],
                "press": press[:5],
            },
            "success",
        )
        scan_log["results"]["fda"] = {
            "pdufa_dates": len(pdufa),
            "adcomm": len(adcomm),
            "press_releases": len(press),
        }
    except Exception as exc:
        msg = f"FDA calendar scan failed: {exc}"
        print(f"  {msg}")
        errors.append(msg)

    # ─── SEC EDGAR ───────────────────────────────────────────────────
    print("Scanning SEC EDGAR...")
    sec_events: list[dict[str, Any]] = []
    try:
        filings_8k = fetch_biotech_8k(days_back=1)
        shelf = fetch_shelf_offerings(days_back=7)
        sec_events = filings_8k + shelf
        print(f"  8-K={len(filings_8k)} shelf={len(shelf)}")

        log_scanner_run(
            supabase,
            "sec_edgar",
            len(sec_events),
            len(shelf),
            {"filings_8k": len(filings_8k), "shelf_offerings": len(shelf)},
            "success",
        )
        scan_log["results"]["sec"] = {
            "8k_filings": len(filings_8k),
            "shelf_offerings": len(shelf),
        }
    except Exception as exc:
        msg = f"SEC EDGAR scan failed: {exc}"
        print(f"  {msg}")
        errors.append(msg)

    # ─── Claude analysis of top candidates ──────────────────────────
    print(f"Analyzing top {min(5, len(all_candidates))} candidates with Claude...")
    analyzed: list[dict[str, Any]] = []
    for candidate in all_candidates[:5]:
        try:
            analysis = analyze_scanner_candidate(candidate)
            candidate["claude_analysis"] = analysis
            analyzed.append(candidate)

            phase_str = str(candidate.get("phase", ""))
            catalyst_type = (
                "phase3_readout" if "PHASE3" in phase_str else "phase2_readout"
            )

            insert_scanner_candidate(
                supabase,
                {
                    "ticker": candidate.get("ticker", ""),
                    "company_name": candidate.get("sponsor", ""),
                    "catalyst_type": catalyst_type,
                    "catalyst_date": candidate.get("primary_completion", ""),
                    "score": candidate.get("score", 0),
                    "flags": candidate.get("flags", []),
                    "claude_analysis": analysis,  # JSONB — pass dict, not string
                    "source": "clinicaltrials",
                    "nct_id": candidate.get("nct_id", ""),
                    "raw_data": candidate,        # JSONB — pass dict, not string
                },
            )
        except Exception as exc:
            errors.append(f"claude analysis / candidate insert: {exc}")

    # ─── Daily digest ───────────────────────────────────────────────
    print("Generating daily digest...")
    try:
        digest = generate_daily_digest(analyzed, fda_events, sec_events)
        send_alert_email(digest, len(all_candidates), len(fda_events))
    except Exception as exc:
        print(f"  digest/email failed: {exc}")
        errors.append(f"digest: {exc}")

    # ─── Persist scan log artifact ─────────────────────────────────
    scan_log["completed_at"] = datetime.utcnow().isoformat()
    scan_log["total_candidates"] = len(all_candidates)
    scan_log["errors"] = errors

    with open("scan_log.json", "w") as fh:
        json.dump(scan_log, fh, indent=2, default=str)

    print(f"[{datetime.utcnow().isoformat()}] Scan complete.")
    print(
        f"Candidates: {len(all_candidates)} | "
        f"FDA events: {len(fda_events)} | "
        f"Errors: {len(errors)}"
    )
    if errors:
        print("Errors:")
        for err in errors:
            print(f"  - {err}")


if __name__ == "__main__":
    main()
