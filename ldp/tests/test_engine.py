from datetime import date, timedelta

import pytest

from ldp.audit import MemoryAuditSink
from ldp.config import config_from_dict
from ldp.ladder import allocate_with_runner
from ldp.brokers import DryRunBroker
from ldp.engine import Engine, UserContext
from ldp.orders import LimitOrderExecutor
from ldp.risk import OnboardingAnswers, compute_risk_profile
from ldp.rules import fixed_rates
from ldp.satellite import SatelliteCandidate, evaluate
from ldp.scoring import SectorMetrics, score_sectors

from .conftest import account, position, quote

BUY_DAY = date(2027, 1, 20)


class Clock:
    t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def make(cfg, *, tier="aggressive", acct_tier="managed", fill=True):
    exp = BUY_DAY + timedelta(days=730)
    qs = {
        "XLK": quote(symbol="XLKC", underlying="XLK", today=BUY_DAY),
        "RXRX": quote(symbol="RXRXC", underlying="RXRX", ask=4.0, bid=3.7, delta=0.65, today=BUY_DAY),
    }
    broker = DryRunBroker(chains={(t, exp): [q] for t, q in qs.items()},
                          fill_at={q.symbol: q.ask for q in qs.values()} if fill else {})
    sink = MemoryAuditSink()
    clock = Clock()
    eng = Engine(cfg, broker=broker, audit=sink, iv_rank=lambda t: 40.0,
                 executor=LimitOrderExecutor(broker, cfg.orders, sleep=clock.sleep, clock=clock))
    user = UserContext(
        user_id="u1", account=account(tier=acct_tier),
        risk=compute_risk_profile(OnboardingAnswers(tier, 100_000, "experienced", 5), cfg.risk),
        rate_source=fixed_rates(0.238, 0.408),
    )
    return eng, user, broker, sink


def buys(cfg, eng, user):
    scores = score_sectors([SectorMetrics("XLK", 30, 30, 30, 10, True)], cfg.core)
    sat = evaluate(SatelliteCandidate("RXRX", "AI bio", "Readouts in 2027", ("https://src",), 900e6, 100e6,
                                      momentum_pct=30, institutional_change_pct=10, short_interest_pct=5),
                   BUY_DAY, cfg.satellite)
    return eng.run_buys(user, today=BUY_DAY, sector_scores=scores, satellite_evals=[sat], positions=[])


def test_managed_aggressive_auto_trades_core_and_satellite(cfg):
    eng, user, broker, sink = make(cfg)
    _, outcomes = buys(cfg, eng, user)
    assert {(o.kind, o.ticker) for o in outcomes} == {("trade", "XLK"), ("trade", "RXRX")}
    assert {e["type"] for e in broker.log if e["op"] == "place"} == {"limit"}


def test_self_directed_aggressive_never_auto_trades(cfg):
    eng, user, broker, sink = make(cfg, acct_tier="self_directed")
    _, outcomes = buys(cfg, eng, user)
    assert {o.kind for o in outcomes} == {"suggestion"}
    assert broker.log == []   # nothing sent to the broker
    sat = next(r for r in sink.records if r.ticker == "RXRX")
    assert sat.permission_mode == "suggest" and sat.account_tier == "self_directed"


def test_audit_record_has_required_fields(cfg):
    eng, user, broker, sink = make(cfg)
    buys(cfg, eng, user)
    rec = next(r for r in sink.records if r.ticker == "RXRX")
    j = rec.to_json()
    for k in ("timestamp", "user_id", "risk_tier", "risk_capped_by", "risk_rules", "account_tier", "ticker",
              "contract", "filter_values", "score", "score_components", "thesis", "sources", "tax_rates",
              "exit_ladder", "sizing", "order", "permission_reasons"):
        assert k in j
    assert j["thesis"] == "Readouts in 2027" and j["sources"] == ["https://src"]
    assert j["filter_values"]["delta"] == 0.65 and j["sizing"]["allowed_dollars"] == 5_000
    assert j["order"]["open"]["status"] == "filled" and j["order"]["target_order"]["status"] == "resting"


def test_daily_thesis_break_sells_on_managed(cfg):
    eng, user, broker, sink = make(cfg)
    exp = BUY_DAY + timedelta(days=730)
    pos = position(sleeve="satellite", ticker="RXRX", thesis="broken", held_days=300, mark=4.0, entry_price=3.0,
                   basis_per_contract=300, today=BUY_DAY)
    pos = pos.__class__(**{**pos.__dict__, "contract_symbol": "RXRXC", "expiration": exp})
    broker.fill_at["RXRXC"] = 3.8
    [(p, d, o)] = eng.run_daily(user, [pos], today=BUY_DAY)
    assert d.rule_name == "thesis_broken" and o.kind == "trade"
    assert sink.records[-1].sell_rule == "thesis_broken"
    assert [e["side"] for e in broker.log if e["op"] == "place"] == ["sell_to_close"]


def test_daily_sell_is_suggestion_on_self_directed(cfg):
    eng, user, broker, sink = make(cfg, acct_tier="self_directed")
    pos = position(thesis="broken", today=BUY_DAY)
    [(_, d, o)] = eng.run_daily(user, [pos], today=BUY_DAY)
    assert o.kind == "suggestion" and broker.log == []


def test_hold_for_long_term_is_audited_with_tax_figures(cfg):
    eng, user, broker, sink = make(cfg)
    [(_, d, o)] = eng.run_daily(user, [position(held_days=330, mark=20.0, today=BUY_DAY)], today=BUY_DAY)
    assert o.kind == "hold" and o.detail["days_until_long_term"] == 36
    rec = sink.records[-1]
    assert rec.sell_rule == "hold_for_long_term" and "estimates" in rec.tax_rates["note"]


def test_plain_hold_not_audited(cfg):
    eng, user, broker, sink = make(cfg)
    [(_, d, o)] = eng.run_daily(user, [position(today=BUY_DAY)], today=BUY_DAY)
    assert o is None and sink.records == []


# ── Playbook: GTC Target 1 order at entry ─────────────────────────

def test_buy_rests_gtc_target_1_sell(cfg):
    eng, user, broker, sink = make(cfg)
    _, outcomes = buys(cfg, eng, user)
    buys_ = {e["symbol"]: e for e in broker.log if e["op"] == "place" and e["side"] == "buy_to_open"}
    sells = [e for e in broker.log if e["op"] == "place" and e["side"] == "sell_to_close"]
    assert {e["symbol"] for e in sells} == {"XLKC", "RXRXC"}
    for s in sells:
        filled = next(o for o in outcomes if o.ticker == ("XLK" if s["symbol"] == "XLKC" else "RXRX")).detail
        assert s["duration"] == "gtc"
        assert s["quantity"] == allocate_with_runner(filled["filled"], [0.70, 0.15])[0][0]
        ask = 20.5 if s["symbol"] == "XLKC" else 4.0
        assert s["price"] == pytest.approx(2 * ask)             # +100% on the fill
        assert filled["target_order"]["status"] == "resting"
    rec = next(r for r in sink.records if r.ticker == "XLK")
    assert rec.order["target_order"]["duration"] == "gtc" and rec.order["open"]["status"] == "filled"


def test_target_order_can_be_turned_off():
    cfg = config_from_dict({"orders": {"place_target_order_on_entry": False}})
    eng, user, broker, sink = make(cfg)
    buys(cfg, eng, user)
    assert [e for e in broker.log if e["op"] == "place" and e["side"] == "sell_to_close"] == []


def test_target_price_rounds_up_to_the_tick(cfg):
    eng, user, broker, sink = make(cfg)
    class Filled:
        filled, avg_fill_price = 10, 3.33          # 2 × 3.33 = 6.66 → 6.70
    t = eng._place_target_order(user, "RXRX", "RXRXC", Filled())
    assert (t["limit_price"], t["quantity"]) == (6.70, 7)
