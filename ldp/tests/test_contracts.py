import pytest

from ldp.contracts import evaluate_contract, select_contract

from .conftest import TODAY, quote


def rejects(q, cfg, sleeve="core"):
    return evaluate_contract(q, sleeve, TODAY, cfg.contracts).rejects


def test_good_core_contract_passes(cfg):
    r = evaluate_contract(quote(), "core", TODAY, cfg.contracts)
    assert r.passed and r.values["spread_pct"] == pytest.approx(0.05)


@pytest.mark.parametrize("kw,needle", [
    ({"dte": 539}, "dte 539 < 540"),
    ({"delta": 0.69}, "delta 0.69 outside"),
    ({"delta": 0.81}, "delta 0.81 outside"),
    ({"iv_rank": 71}, "iv rank 71 > 70"),
    ({"bid": 18.0, "ask": 22.0}, "spread 20.0%"),
    ({"oi": 99}, "open interest 99 < 100"),
    ({"delta": None}, "missing delta"),
    ({"iv_rank": None}, "missing iv rank"),
    ({"bid": None}, "missing or crossed"),
    ({"bid": 21.0, "ask": 20.0}, "missing or crossed"),
    ({"oi": None}, "missing open interest"),
])
def test_hard_rejects(cfg, kw, needle):
    rs = rejects(quote(**kw), cfg)
    assert any(needle in r for r in rs), rs


@pytest.mark.parametrize("kw", [{"dte": 540}, {"delta": 0.70}, {"delta": 0.80}, {"iv_rank": 70}, {"oi": 100},
                                {"bid": 19.05, "ask": 20.95}])
def test_boundaries_pass(cfg, kw):
    assert rejects(quote(**kw), cfg) == ()


def test_satellite_delta_band(cfg):
    assert rejects(quote(delta=0.62), cfg, "satellite") == ()
    assert rejects(quote(delta=0.62), cfg, "core") != ()
    assert rejects(quote(delta=0.59), cfg, "satellite") != ()


def test_put_delta_uses_absolute_value(cfg):
    assert rejects(quote(delta=-0.75, option_type="put"), cfg) == ()


def test_selection_prefers_target_dte_then_delta_then_spread(cfg):
    far = quote(symbol="FAR", dte=900)
    target = quote(symbol="TGT", dte=730, delta=0.78)
    target_mid_delta = quote(symbol="TGT2", dte=730, delta=0.75)
    bad = quote(symbol="BAD", dte=731, iv_rank=95)
    best, results = select_contract([far, target, target_mid_delta, bad], "core", TODAY, cfg.contracts)
    assert best.quote.symbol == "TGT2"
    assert len(results) == 4


def test_selection_none_when_all_fail(cfg):
    best, results = select_contract([quote(dte=100)], "core", TODAY, cfg.contracts)
    assert best is None and not results[0].passed


def test_selection_ignores_puts_for_call_buys(cfg):
    best, _ = select_contract([quote(option_type="put", delta=-0.75)], "core", TODAY, cfg.contracts)
    assert best is None
