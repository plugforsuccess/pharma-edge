"""Supabase persistence for the engine (service role, server-side only)."""

from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timezone

from .config import LDPConfig
from .models import AccountTier
from .risk import RiskProfile, describe


class SupabaseStore:
    def __init__(self, url: str | None = None, service_key: str | None = None) -> None:
        self.url = (url or os.environ["SUPABASE_URL"]).rstrip("/")
        self.key = service_key or os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    def _post(self, table: str, row: dict, *, upsert: bool = False) -> None:
        prefer = "return=minimal" + (",resolution=merge-duplicates" if upsert else "")
        req = urllib.request.Request(
            f"{self.url}/rest/v1/{table}", data=json.dumps(row).encode(), method="POST",
            headers={"apikey": self.key, "Authorization": f"Bearer {self.key}",
                     "Content-Type": "application/json", "Prefer": prefer},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            if resp.status >= 300:
                raise RuntimeError(f"{table} write failed: HTTP {resp.status}")

    def save_risk_profile(self, user_id: str, profile: RiskProfile, account_tier: AccountTier, cfg: LDPConfig) -> None:
        self._post("ldp_risk_profiles", risk_profile_row(user_id, profile, account_tier, cfg), upsert=True)


def risk_profile_row(user_id: str, profile: RiskProfile, account_tier: AccountTier, cfg: LDPConfig) -> dict:
    a = profile.answers
    return {
        "user_id": user_id,
        "stated_tolerance": a.stated_tolerance,
        "account_size": a.account_size,
        "options_experience": a.options_experience,
        "horizon_years": a.horizon_years,
        "tier": profile.tier,
        "capped_by": profile.capped_by,
        "rule_results": [r.__dict__ for r in profile.rules],
        "display": describe(profile, account_tier, cfg),
        "account_tier": account_tier,
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }
