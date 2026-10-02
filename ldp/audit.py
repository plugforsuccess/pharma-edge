"""Audit log — one record per trade, suggestion, or skip.

Records carry: timestamp, user, risk tier + capping rule + rule results,
account tier (self-directed vs managed), ticker, contract, every filter
value, score, thesis (satellites), tax rates used, exit ladder, and the
sell rule that fired. Sinks are append-only.
"""

from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Literal, Protocol

Kind = Literal["trade", "suggestion", "skip", "hold"]


@dataclass
class AuditRecord:
    user_id: str
    kind: Kind
    action: str                      # buy | sell_all | sell_rung | roll | rotate | hold_for_long_term | hold | skip
    ticker: str
    risk_tier: str
    risk_capped_by: str | None
    risk_rules: list[dict]
    account_tier: str
    permission_mode: str             # auto | suggest | blocked
    permission_reasons: list[str]
    sleeve: str | None = None
    contract: str | None = None
    filter_values: dict | None = None
    filter_rejects: list[str] = field(default_factory=list)
    score: float | None = None
    score_components: dict | None = None
    thesis: str | None = None
    sources: list[str] = field(default_factory=list)
    tax_rates: dict | None = None
    exit_ladder: list[dict] | None = None
    sell_rule: str | None = None
    sizing: dict | None = None
    order: dict | None = None
    reason: str | None = None
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_json(self) -> dict:
        return json.loads(json.dumps(asdict(self), default=_default))


def _default(o: Any) -> Any:
    if isinstance(o, (date, datetime)):
        return o.isoformat()
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    if hasattr(o, "to_record"):
        return o.to_record()
    if isinstance(o, float) and o == float("inf"):
        return "inf"
    raise TypeError(f"not JSON serialisable: {type(o).__name__}")


class AuditSink(Protocol):
    def write(self, record: AuditRecord) -> None: ...


class MemoryAuditSink:
    def __init__(self) -> None:
        self.records: list[AuditRecord] = []

    def write(self, record: AuditRecord) -> None:
        self.records.append(record)


class JsonlAuditSink:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def write(self, record: AuditRecord) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as fh:
            fh.write(json.dumps(record.to_json(), default=_default) + "\n")


class SupabaseAuditSink:
    """Inserts into public.ldp_audit_log with the service-role key.
    Server-side only — the key bypasses RLS."""

    def __init__(self, url: str | None = None, service_key: str | None = None) -> None:
        self.url = (url or os.environ["SUPABASE_URL"]).rstrip("/")
        self.key = service_key or os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    def write(self, record: AuditRecord) -> None:
        payload = record.to_json()
        row = {
            "user_id": record.user_id,
            "kind": record.kind,
            "action": record.action,
            "ticker": record.ticker,
            "sleeve": record.sleeve,
            "risk_tier": record.risk_tier,
            "account_tier": record.account_tier,
            "permission_mode": record.permission_mode,
            "sell_rule": record.sell_rule,
            "recorded_at": record.timestamp,
            "payload": payload,
        }
        req = urllib.request.Request(
            f"{self.url}/rest/v1/ldp_audit_log",
            data=json.dumps(row, default=_default).encode(),
            method="POST",
            headers={"apikey": self.key, "Authorization": f"Bearer {self.key}",
                     "Content-Type": "application/json", "Prefer": "return=minimal"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            if resp.status >= 300:
                raise RuntimeError(f"audit insert failed: HTTP {resp.status}")
