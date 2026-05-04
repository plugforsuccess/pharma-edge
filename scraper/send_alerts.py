"""Catalyst-approaching + outcome-reminder fanout.

Runs daily on a 13:00 UTC cron (= 8am ET in standard time, 9am ET during
DST — see CLAUDE.md). For each active signal owned by a user with an
email on file, sends:

  catalyst date - 14 days  -> catalyst_approaching_14d
  catalyst date - 7  days  -> catalyst_approaching_7d
  catalyst date - 1  day   -> catalyst_tomorrow
  catalyst date + 1  day   -> outcome_reminder

Idempotency: skip if (signal_id, alert_type) already exists in `alerts`.
The actual email goes through the send-alerts edge function, which is
service-role-gated, so we never expose Resend credentials in CI logs.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv
from supabase import create_client


REQUIRED = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")


def main() -> None:
    load_dotenv()
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"Missing env: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    supabase_url = os.environ["SUPABASE_URL"]
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    supabase = create_client(supabase_url, service_key)

    today = datetime.now(timezone.utc).date()

    result = (
        supabase.table("signals")
        .select("id, user_id, ticker, catalyst_date, status")
        .eq("status", "active")
        .execute()
    )
    signals = result.data or []

    print(f"[{datetime.now(timezone.utc).isoformat()}] {len(signals)} active signals")

    sent = 0
    skipped = 0
    failed = 0

    for signal in signals:
        try:
            catalyst_date = datetime.strptime(signal["catalyst_date"], "%Y-%m-%d").date()
        except (KeyError, ValueError):
            print(f"  skip {signal.get('id')}: bad catalyst_date")
            continue

        delta = (catalyst_date - today).days
        alert_type = {
            14: "catalyst_approaching_14d",
            7: "catalyst_approaching_7d",
            1: "catalyst_tomorrow",
            -1: "outcome_reminder",
        }.get(delta)

        if not alert_type:
            continue

        # Idempotency: don't re-send if we already logged this alert type
        # for this signal.
        existing = (
            supabase.table("alerts")
            .select("id")
            .eq("signal_id", signal["id"])
            .eq("alert_type", alert_type)
            .limit(1)
            .execute()
        )
        if existing.data:
            print(f"  skip {signal['ticker']} {alert_type} (already sent)")
            skipped += 1
            continue

        try:
            resp = requests.post(
                f"{supabase_url}/functions/v1/send-alerts",
                headers={
                    "Authorization": f"Bearer {service_key}",
                    "Content-Type": "application/json",
                    "apikey": service_key,
                },
                json={
                    "alert_type": alert_type,
                    "user_id": signal["user_id"],
                    "signal_id": signal["id"],
                },
                timeout=30,
            )
            if resp.status_code >= 400:
                print(
                    f"  fail {signal['ticker']} {alert_type}: "
                    f"{resp.status_code} {resp.text[:200]}"
                )
                failed += 1
            else:
                print(f"  sent {signal['ticker']} {alert_type}")
                sent += 1
        except Exception as exc:
            print(f"  fail {signal['ticker']} {alert_type}: {exc}")
            failed += 1

    print(f"Done. sent={sent} skipped={skipped} failed={failed}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
