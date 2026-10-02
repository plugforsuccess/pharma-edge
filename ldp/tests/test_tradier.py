from datetime import date
from urllib.parse import parse_qs

import pytest

from ldp.brokers.base import LimitOrder
from ldp.brokers.tradier import LIVE_URL, SANDBOX_URL, TradierBroker, TradierError


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), body))
        return self.responses.pop(0)


def test_sandbox_by_default_and_bearer_auth():
    t = FakeTransport([(200, {"expirations": {"date": ["2028-01-21", "2027-12-17"]}})])
    b = TradierBroker(token="secret", transport=t)
    assert b.get_expirations("XLK") == [date(2027, 12, 17), date(2028, 1, 21)]
    method, url, headers, _ = t.calls[0]
    assert url.startswith(SANDBOX_URL + "/markets/options/expirations")
    assert headers["Authorization"] == "Bearer secret"


def test_single_expiration_and_null_collections():
    t = FakeTransport([(200, {"expirations": {"date": "2028-01-21"}}), (200, {"expirations": "null"})])
    b = TradierBroker(token="x", transport=t)
    assert b.get_expirations("XLK") == [date(2028, 1, 21)]
    assert b.get_expirations("XLK") == []


def test_chain_parsing_with_greeks():
    opt = {"symbol": "XLK280121C00200000", "underlying": "XLK", "option_type": "call", "strike": 200,
           "expiration_date": "2028-01-21", "bid": 19.5, "ask": 20.5, "open_interest": 512,
           "greeks": {"delta": 0.74, "mid_iv": 0.22}}
    t = FakeTransport([(200, {"options": {"option": opt}})])   # single object, not a list
    [q] = TradierBroker(token="x", transport=t).get_chain("XLK", date(2028, 1, 21))
    assert (q.symbol, q.delta, q.open_interest, q.mid, q.iv_rank) == ("XLK280121C00200000", 0.74, 512, 20.0, None)
    assert "greeks=true" in t.calls[0][1]


def test_place_order_is_limit_only():
    t = FakeTransport([(200, {"order": {"id": 777, "status": "ok"}})])
    b = TradierBroker(token="x", transport=t, sandbox=False)
    oid = b.place_limit_order("ACC1", LimitOrder("XLK", "XLK280121C00200000", "buy_to_open", 3, 20.0, tag="ldp-core"))
    assert oid == "777"
    method, url, headers, body = t.calls[0]
    assert method == "POST" and url == f"{LIVE_URL}/accounts/ACC1/orders"
    form = {k: v[0] for k, v in parse_qs(body.decode()).items()}
    assert form == {"class": "option", "symbol": "XLK", "option_symbol": "XLK280121C00200000",
                    "side": "buy_to_open", "quantity": "3", "type": "limit", "duration": "day",
                    "price": "20.00", "tag": "ldp-core"}


def test_limit_order_requires_positive_price():
    with pytest.raises(ValueError):
        LimitOrder("XLK", "S", "buy_to_open", 1, 0)


def test_modify_cancel_and_status():
    t = FakeTransport([(200, {"order": {"id": 1, "status": "ok"}}), (200, {"order": {"id": 1, "status": "ok"}}),
                       (200, {"order": {"id": 1, "status": "partially_filled", "exec_quantity": 2, "avg_fill_price": 20.1}})])
    b = TradierBroker(token="x", transport=t)
    b.modify_order("A", "1", 20.25)
    b.cancel_order("A", "1")
    s = b.get_order("A", "1")
    assert [c[0] for c in t.calls] == ["PUT", "DELETE", "GET"]
    assert parse_qs(t.calls[0][3].decode())["type"] == ["limit"]
    assert (s.state, s.filled_quantity, s.avg_fill_price) == ("partially_filled", 2, 20.1)


def test_http_error_never_leaks_token():
    t = FakeTransport([(401, {"fault": "invalid token"})])
    with pytest.raises(TradierError) as e:
        TradierBroker(token="supersecret", transport=t).get_balances("A")
    assert "supersecret" not in str(e.value)


def test_balances_and_positions():
    t = FakeTransport([
        (200, {"balances": {"total_equity": 101000.5, "total_cash": 40000}}),
        (200, {"positions": {"position": {"symbol": "XLK280121C00200000", "quantity": 3, "cost_basis": 6000,
                                          "date_acquired": "2026-01-20T14:31:00.000Z"}}}),
        (200, {"positions": "null"}),
    ])
    b = TradierBroker(token="x", transport=t)
    assert b.get_balances("A").cash == 40000
    [p] = b.get_positions("A")
    assert p.date_acquired == date(2026, 1, 20) and p.quantity == 3
    assert b.get_positions("A") == []


def test_from_env(monkeypatch):
    monkeypatch.setenv("TRADIER_ACCESS_TOKEN", "t")
    monkeypatch.setenv("TRADIER_ENV", "live")
    assert TradierBroker.from_env().sandbox is False
    monkeypatch.setenv("TRADIER_ENV", "prod")
    with pytest.raises(RuntimeError):
        TradierBroker.from_env()
