"""Write GitHub anchor JSON files for unanchored signals.

Reads the canonical `signal_hash` value Postgres already computed at
insert time (via compute_signal_hash trigger) — never reconstructs the
hash here, since json_build_object's argument-order serialisation does
NOT match Python's `json.dumps(..., sort_keys=True)`.

Outputs:
  public-record/anchors/<YYYY-MM-DD>.json   anchor file for the public repo
  _anchored_ids.json                         list of signal IDs anchored
                                             this run, consumed by
                                             update_anchor_shas.py after
                                             the workflow captures the
                                             commit SHA.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client


PUBLIC_RECORD_DIR = Path(os.environ.get("PUBLIC_RECORD_DIR", "public-record"))
ANCHOR_IDS_FILE = Path("_anchored_ids.json")
REQUIRED = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")


def main() -> None:
    load_dotenv()
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"Missing env: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    supabase = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

    result = (
        supabase.table("signals")
        .select(
            "id, ticker, direction, catalyst_date, logged_at, "
            "confidence_score, signal_hash, status"
        )
        .is_("github_commit_sha", "null")
        .execute()
    )
    signals = result.data or []
    print(f"Found {len(signals)} unanchored signals")

    if not signals:
        # Still write the ids file (empty) so downstream step is a no-op
        ANCHOR_IDS_FILE.write_text(json.dumps([]))
        return

    anchors: dict[str, dict[str, object]] = {}
    for signal in signals:
        if not signal.get("signal_hash"):
            print(f"  skip {signal['id']}: signal_hash not populated yet")
            continue
        anchors[signal["id"]] = {
            "hash": signal["signal_hash"],
            "ticker": signal["ticker"],
            "direction": signal["direction"],
            "logged_at": signal["logged_at"],
            "catalyst_date": signal["catalyst_date"],
            "confidence_score": signal["confidence_score"],
        }

    if not anchors:
        ANCHOR_IDS_FILE.write_text(json.dumps([]))
        print("Nothing to anchor (no signal_hash values yet)")
        return

    anchor_dir = PUBLIC_RECORD_DIR / "anchors"
    anchor_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    anchor_path = anchor_dir / f"{today}.json"

    # If the file already exists (workflow re-run same day), merge.
    existing: dict[str, dict[str, object]] = {}
    if anchor_path.exists():
        try:
            payload = json.loads(anchor_path.read_text())
            existing = payload.get("anchors", {}) or {}
        except (OSError, json.JSONDecodeError):
            existing = {}

    merged = {**existing, **anchors}
    anchor_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "signal_count": len(merged),
                "anchors": merged,
            },
            indent=2,
            sort_keys=True,
        )
    )

    ANCHOR_IDS_FILE.write_text(json.dumps(list(anchors.keys())))
    print(f"Wrote {len(anchors)} anchors to {anchor_path}")


if __name__ == "__main__":
    main()
