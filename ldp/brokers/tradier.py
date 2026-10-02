"""Tradier brokerage adapter (REST, stdlib only).

Endpoints (Tradier Brokerage API v1):
  GET    /markets/options/expirations?symbol=
  GET    /markets/options/chains?symbol=&expiration=&greeks=true
  POST   /accounts/{id}/orders            class=option, type=limit only
  PUT    /accounts/{id}/orders/{order_id} reprice
  DELETE /accounts/{id}/orders/{order_id}
  GET    /accounts/{id}/orders/{order_id}
  GET    /accounts/{id}/balances
  GET    /accounts/{id}/positions

Base URL: https://api.tradier.com/v1 (live) or
https://sandbox.tradier.com/v1 (paper). Sandbox is the default; live
must be chosen explicitly.

Auth: an access token (``TRADIER_ACCESS_TOKEN``) — never logged.

Tradier returns a bare object instead of a one-element list when a
collection has a single item, and the string "null" for empty
collections; ``_as_list`` normalises both.

Limit orders only. ``place_limit_order`` always sends ``type=limit``;
there is no code path that sends ``market``.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable, Mapping, Sequence

from ..models import OptionQuote
from .base import Balances, BrokerPosition, LimitOrder, OrderStatus

LIVE_URL = "https://api.tradier.com/v1"
SANDBOX_URL = "https://sandbox.tradier.com/v1"

# transport(method, url, headers, form_body) → (status_code, parsed_json)
Transport = Callable[[str, str, Mapping[str, str], bytes | None], tuple[int, Any]]


class TradierError(RuntimeError):
    def __init__(self, status: int, body: Any):
        # Body only — request headers (with the token) are never included.
        super().__init__(f"Tradier HTTP {status}: {str(body)[:500]}")
        self.status = status
        self.body = body


def urllib_transport(method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> tuple[int, Any]:
    req = urllib.request.Request(url, data=body, method=method, headers=dict(headers))
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = raw.decode("utf-8", "replace")
        return e.code, parsed


def _as_list(v: Any) -> list:
    if v is None or v == "null":
        return []
    return v if isinstance(v, list) else [v]


_STATE = {
    "pending": "pending", "open": "open", "partially_filled": "partially_filled",
    "filled": "filled", "canceled": "canceled", "rejected": "rejected",
    "expired": "expired", "error": "rejected",
}


@dataclass
class TradierBroker:
    token: str
    sandbox: bool = True
    transport: Transport = urllib_transport
    base_url: str | None = None

    @classmethod
    def from_env(cls, *, transport: Transport = urllib_transport) -> "TradierBroker":
        token = os.environ.get("TRADIER_ACCESS_TOKEN")
        if not token:
            raise RuntimeError("TRADIER_ACCESS_TOKEN is not set")
        env = os.environ.get("TRADIER_ENV", "sandbox")
        if env not in ("sandbox", "live"):
            raise RuntimeError("TRADIER_ENV must be 'sandbox' or 'live'")
        return cls(token=token, sandbox=env != "live", transport=transport)

    # ── HTTP ────────────────────────────────────────────────────────
    def _url(self, path: str, params: Mapping[str, Any] | None = None) -> str:
        base = self.base_url or (SANDBOX_URL if self.sandbox else LIVE_URL)
        q = f"?{urllib.parse.urlencode(params)}" if params else ""
        return f"{base}{path}{q}"

    def _call(self, method: str, path: str, *, params: Mapping[str, Any] | None = None,
              form: Mapping[str, Any] | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        body = None
        if form is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            body = urllib.parse.urlencode({k: v for k, v in form.items() if v is not None}).encode()
        status, data = self.transport(method, self._url(path, params), headers, body)
        if status >= 400:
            raise TradierError(status, data)
        if isinstance(data, Mapping) and data.get("errors"):
            raise TradierError(status, data["errors"])
        return data

    # ── Market data ─────────────────────────────────────────────────
    def get_expirations(self, symbol: str) -> list[date]:
        data = self._call("GET", "/markets/options/expirations", params={"symbol": symbol, "includeAllRoots": "false"})
        exp = (data or {}).get("expirations")
        dates = _as_list(exp.get("date") if isinstance(exp, Mapping) else None)
        return sorted(date.fromisoformat(d) for d in dates)

    def get_chain(self, symbol: str, expiration: date) -> list[OptionQuote]:
        data = self._call("GET", "/markets/options/chains",
                          params={"symbol": symbol, "expiration": expiration.isoformat(), "greeks": "true"})
        options = _as_list(((data or {}).get("options") or {}).get("option"))
        out: list[OptionQuote] = []
        for o in options:
            greeks = o.get("greeks") or {}
            out.append(OptionQuote(
                symbol=o["symbol"],
                underlying=o.get("underlying") or symbol,
                option_type="call" if o.get("option_type") == "call" else "put",
                strike=float(o["strike"]),
                expiration=date.fromisoformat(o.get("expiration_date") or expiration.isoformat()),
                bid=_f(o.get("bid")),
                ask=_f(o.get("ask")),
                delta=_f(greeks.get("delta")),
                open_interest=None if o.get("open_interest") is None else int(o["open_interest"]),
                iv=_f(greeks.get("mid_iv")),
                iv_rank=None,   # not provided by Tradier; enriched by the market-data layer
            ))
        return out

    # ── Orders (limit only) ─────────────────────────────────────────
    def place_limit_order(self, account_id: str, order: LimitOrder) -> str:
        form = {
            "class": "option",
            "symbol": order.underlying,
            "option_symbol": order.option_symbol,
            "side": order.side,
            "quantity": order.quantity,
            "type": "limit",
            "duration": order.duration,
            "price": f"{order.limit_price:.2f}",
            "tag": order.tag,
        }
        data = self._call("POST", f"/accounts/{account_id}/orders", form=form)
        o = (data or {}).get("order") or {}
        if o.get("status") not in (None, "ok") or "id" not in o:
            raise TradierError(200, data)
        return str(o["id"])

    def modify_order(self, account_id: str, order_id: str, limit_price: float) -> None:
        self._call("PUT", f"/accounts/{account_id}/orders/{order_id}",
                   form={"type": "limit", "price": f"{limit_price:.2f}"})

    def cancel_order(self, account_id: str, order_id: str) -> None:
        self._call("DELETE", f"/accounts/{account_id}/orders/{order_id}")

    def get_order(self, account_id: str, order_id: str) -> OrderStatus:
        data = self._call("GET", f"/accounts/{account_id}/orders/{order_id}")
        o = (data or {}).get("order") or {}
        return OrderStatus(
            order_id=str(o.get("id", order_id)),
            state=_STATE.get(str(o.get("status", "pending")), "pending"),
            filled_quantity=int(float(o.get("exec_quantity") or 0)),
            avg_fill_price=_f(o.get("avg_fill_price")) or None,
        )

    # ── Account ─────────────────────────────────────────────────────
    def get_balances(self, account_id: str) -> Balances:
        b = ((self._call("GET", f"/accounts/{account_id}/balances") or {}).get("balances")) or {}
        return Balances(total_equity=float(b.get("total_equity") or 0), cash=float(b.get("total_cash") or 0))

    def get_positions(self, account_id: str) -> Sequence[BrokerPosition]:
        data = self._call("GET", f"/accounts/{account_id}/positions") or {}
        rows = _as_list((data.get("positions") or {}).get("position") if isinstance(data.get("positions"), Mapping) else None)
        return [
            BrokerPosition(
                symbol=r["symbol"],
                quantity=float(r.get("quantity") or 0),
                cost_basis=float(r.get("cost_basis") or 0),
                date_acquired=date.fromisoformat(str(r["date_acquired"])[:10]) if r.get("date_acquired") else None,
            )
            for r in rows
        ]


def _f(v: Any) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None
