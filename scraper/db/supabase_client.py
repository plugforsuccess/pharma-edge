"""Supabase service-role client for the scraper.

The scraper writes via service_role which bypasses RLS — every insert here
is therefore unrestricted. Be mindful: never copy this client into the
frontend.
"""

import os
from typing import Optional

from supabase import Client, create_client


def get_supabase() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set "
            "(see scraper/.env.example or your GitHub Actions secrets)."
        )
    return create_client(url, key)


def log_scanner_run(
    supabase: Client,
    source: str,
    companies_scanned: int,
    signals_generated: int,
    raw_data: dict,
    status: str,
    error_log: Optional[str] = None,
) -> None:
    supabase.table("scanner_runs").insert(
        {
            "source": source,
            "companies_scanned": companies_scanned,
            "signals_generated": signals_generated,
            "raw_data": raw_data,
            "status": status,
            "error_log": error_log,
        }
    ).execute()


def insert_scanner_candidate(supabase: Client, candidate: dict) -> None:
    """Insert a candidate row. claude_analysis and raw_data are passed as
    dicts (not JSON strings) so PostgREST writes proper JSONB."""
    supabase.table("scanner_candidates").insert(candidate).execute()
