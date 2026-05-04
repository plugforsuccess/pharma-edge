"""Stamp anchored signals with the public-record commit SHA.

Run AFTER the workflow has committed + pushed the anchor JSON files in
the public-record repo. Reads:

  _anchored_ids.json   list of signal IDs anchored this run
  ANCHOR_COMMIT_SHA    env, the commit SHA from `git rev-parse HEAD`

Updates `signals.github_commit_sha` and `hash_anchored_at` for each id.
The immutability trigger does NOT block these columns, so this is safe
on locked rows.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client


REQUIRED = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANCHOR_COMMIT_SHA")
ANCHOR_IDS_FILE = Path("_anchored_ids.json")


def main() -> None:
    load_dotenv()
    missing = [k for k in REQUIRED if not os.environ.get(k)]
    if missing:
        print(f"Missing env: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    if not ANCHOR_IDS_FILE.exists():
        print("No _anchored_ids.json found — nothing to update")
        return

    try:
        ids = json.loads(ANCHOR_IDS_FILE.read_text())
    except json.JSONDecodeError as exc:
        print(f"Bad _anchored_ids.json: {exc}", file=sys.stderr)
        sys.exit(1)

    if not ids:
        print("Empty anchor id list — nothing to update")
        return

    sha = os.environ["ANCHOR_COMMIT_SHA"].strip()
    if not sha:
        print("ANCHOR_COMMIT_SHA is empty", file=sys.stderr)
        sys.exit(1)

    supabase = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

    now = datetime.now(timezone.utc).isoformat()
    updated = 0
    for signal_id in ids:
        try:
            supabase.table("signals").update(
                {
                    "github_commit_sha": sha,
                    "hash_anchored_at": now,
                }
            ).eq("id", signal_id).execute()
            updated += 1
        except Exception as exc:
            print(f"  fail update {signal_id}: {exc}")

    print(f"Stamped {updated}/{len(ids)} signals with commit {sha[:12]}")


if __name__ == "__main__":
    main()
