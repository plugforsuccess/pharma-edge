import math
from datetime import timedelta

import pytest

from ldp.satellite import (
    Catalyst, Offering, SatelliteCandidate, evaluate, hard_rejects, parse_research_output, rank, runway_months, score,
)

from .conftest import TODAY


def cand(**kw):
    base = dict(ticker="RXRX", theme="AI drug discovery", thesis="Platform readouts in 2027.",
                sources=("https://example.com/10q",), cash=800e6, quarterly_burn=100e6,
                catalysts=(Catalyst("trial_readout", TODAY + timedelta(days=120), True),),
                institutional_change_pct=5.0, short_interest_pct=10.0, momentum_pct=20.0)
    base.update(kw)
    return SatelliteCandidate(**base)


def test_runway_formula():
    assert runway_months(600e6, 100e6) == 18
    assert math.isinf(runway_months(100e6, 0))
    assert math.isinf(runway_months(100e6, -5e6))   # cash-flow positive


def test_runway_hard_reject(cfg):
    assert any("runway 11.4 mo" in r for r in hard_rejects(cand(cash=380e6), TODAY, cfg.satellite))
    assert hard_rejects(cand(cash=400e6), TODAY, cfg.satellite) == []   # exactly 12 months


def test_catalyst_blackout(cfg):
    inside = cand(catalysts=(Catalyst("fda_date", TODAY + timedelta(days=14), True),))
    outside = cand(catalysts=(Catalyst("fda_date", TODAY + timedelta(days=15), True),))
    non_binary = cand(catalysts=(Catalyst("earnings", TODAY + timedelta(days=5), False),))
    assert any("blackout" in r for r in hard_rejects(inside, TODAY, cfg.satellite))
    assert hard_rejects(outside, TODAY, cfg.satellite) == []
    assert hard_rejects(non_binary, TODAY, cfg.satellite) == []
    assert hard_rejects(inside, TODAY, cfg.satellite, allow_catalyst_plays=True) == []


def test_thesis_and_sources_required(cfg):
    rs = hard_rejects(cand(thesis="  ", sources=()), TODAY, cfg.satellite)
    assert "missing thesis" in rs and "missing source links" in rs


def test_score_components_and_weights(cfg):
    s, parts = score(cand(), TODAY, cfg.satellite)
    assert set(parts) == set(cfg.satellite.weights)
    assert all(0 <= v <= 1 for v in parts.values())
    assert parts["runway"] == pytest.approx(24 / 36)
    assert parts["catalysts"] == 0.5
    assert parts["momentum"] == pytest.approx(0.7)
    assert parts["short_interest"] == pytest.approx(1 - 10 / 30)
    assert 0 < s < 1


def test_dilution_penalised(cfg):
    clean = score(cand(), TODAY, cfg.satellite)[1]["dilution"]
    diluted = score(cand(offerings=(Offering(TODAY - timedelta(days=30), "atm"),), active_shelf=True),
                    TODAY, cfg.satellite)[1]["dilution"]
    assert clean == 1.0 and diluted == pytest.approx(1 - 0.35 - 0.30)


def test_score_floor_rejects(cfg):
    weak = cand(cash=420e6, catalysts=(), momentum_pct=-50, short_interest_pct=40, institutional_change_pct=-20,
                offerings=(Offering(TODAY, "atm"), Offering(TODAY, "atm")), active_shelf=True)
    ev = evaluate(weak, TODAY, cfg.satellite)
    assert not ev.passed and any("score" in r for r in ev.rejects)


def test_rank_only_passing_by_score(cfg):
    a = evaluate(cand(ticker="AAA"), TODAY, cfg.satellite)
    b = evaluate(cand(ticker="BBB", momentum_pct=50), TODAY, cfg.satellite)
    c = evaluate(cand(ticker="CCC", cash=1), TODAY, cfg.satellite)
    assert [e.candidate.ticker for e in rank([a, b, c])] == ["BBB", "AAA"]


def test_parse_research_output_keeps_thesis_and_sources():
    payload = {"themes": [{"theme": "AI drug discovery", "candidates": [{
        "ticker": "rxrx", "thesis": "Readouts.", "sources": ["https://a", "https://b"],
        "fundamentals": {"cash": 5e8, "quarterly_burn": 1e8},
        "catalysts": [{"kind": "trial_readout", "date": "2027-03-01", "binary": True}],
        "offerings": [{"date": "2026-06-01", "kind": "follow_on"}],
        "active_shelf": True, "short_interest_pct": 12.5,
    }]}]}
    [c] = parse_research_output(payload)
    assert c.ticker == "RXRX" and c.theme == "AI drug discovery"
    assert c.thesis == "Readouts." and c.sources == ("https://a", "https://b")
    assert c.catalysts[0].binary and c.offerings[0].kind == "follow_on"
    assert c.to_record()["sources"] == ["https://a", "https://b"]
