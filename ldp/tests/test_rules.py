from datetime import timedelta

import pytest

from ldp.rules import evaluate_position, fixed_rates, profile_rates
from ldp.satellite import Catalyst, SatelliteCandidate
from ldp.tax import TaxProfile, load_tax_year

from .conftest import TODAY, position, quote

RATES = fixed_rates(long_term=0.238, short_term=0.408)


def ev(pos, cfg, **kw):
    return evaluate_position(pos, today=TODAY, rate_source=RATES, cfg=cfg, **kw)


def sat(**kw):
    base = dict(ticker="RXRX", theme="AI drug discovery", thesis="pipeline readouts", sources=("https://x",),
                cash=600e6, quarterly_burn=100e6)
    base.update(kw)
    return SatelliteCandidate(**base)


# ── Required cases ─────────────────────────────────────────────────

def test_broken_thesis_sells_now_regardless_of_tax(cfg):
    p = position(sleeve="satellite", ticker="RXRX", held_days=300, mark=15.0, thesis="broken")
    d = ev(p, cfg)
    assert (d.action, d.rule, d.rule_name) == ("sell_all", 1, "thesis_broken")
    assert d.contracts == 3


def test_broken_thesis_beats_hold_for_long_term_even_days_away(cfg):
    p = position(sleeve="satellite", ticker="RXRX", held_days=360, mark=15.0, thesis="broken")
    d = ev(p, cfg)
    assert d.action == "sell_all" and d.days_until_long_term == 6


def test_hold_for_long_term_shows_days_and_tax_saved(cfg):
    p = position(held_days=330, mark=12.0)
    d = ev(p, cfg)
    assert (d.action, d.rule) == ("hold_for_long_term", 4)
    assert d.days_until_long_term == 36
    assert d.long_term_date == p.acquired + timedelta(days=366)
    gain = (12.0 * 100 - 1000) * 3
    assert d.tax_saved_by_waiting == pytest.approx(gain * (0.408 - 0.238))


def test_roll_window_rolls_to_passing_contract(cfg):
    p = position(held_days=200, dte=170)
    d = ev(p, cfg, roll_chain=[quote(symbol="XLKNEW", dte=730)])
    assert (d.action, d.rule) == ("roll", 2)
    assert d.replacement.quote.symbol == "XLKNEW" and d.contracts == 3


# ── Rule 1 ─────────────────────────────────────────────────────────

def test_price_stop(cfg):
    d = ev(position(entry_price=10.0, mark=5.0), cfg)
    assert (d.action, d.rule_name) == ("sell_all", "price_stop")
    assert ev(position(entry_price=10.0, mark=5.01), cfg).action != "sell_all"


def test_satellite_runway_falling_below_minimum_sells(cfg):
    p = position(sleeve="satellite", ticker="RXRX", held_days=340, mark=15.0)
    d = ev(p, cfg, satellite=sat(cash=300e6, quarterly_burn=100e6))   # 9 months
    assert (d.action, d.rule_name) == ("sell_all", "satellite_hard_reject")
    assert "9.0 mo" in d.reason


def test_satellite_binary_event_in_blackout(cfg):
    s = sat(catalysts=(Catalyst("trial_readout", TODAY + timedelta(days=10), True),))
    p = position(sleeve="satellite", ticker="RXRX", held_days=100, mark=12.0)
    assert ev(p, cfg, satellite=s).rule_name == "satellite_hard_reject"
    assert ev(p, cfg, satellite=s, allow_catalyst_plays=True).action == "hold"


def test_core_ignores_satellite_snapshot(cfg):
    d = ev(position(), cfg, satellite=sat(cash=1, quarterly_burn=100e6))
    assert d.action == "hold"


# ── Rule 2 ─────────────────────────────────────────────────────────

def test_roll_with_no_passing_contract_sells(cfg):
    p = position(held_days=200, dte=170)
    d = ev(p, cfg, roll_chain=[quote(dte=400), quote(iv_rank=90)])
    assert (d.action, d.rule_name) == ("sell_all", "roll_no_contract")
    assert d.details["candidates_checked"] == 2


def test_roll_beats_profit_target(cfg):
    p = position(held_days=200, dte=170, mark=40.0)
    assert ev(p, cfg, roll_chain=[quote()]).action == "roll"


def test_stop_beats_roll(cfg):
    p = position(dte=170, entry_price=10, mark=4)
    assert ev(p, cfg, roll_chain=[quote()]).rule_name == "price_stop"


# ── Rule 3 ─────────────────────────────────────────────────────────

def test_profit_target_sells_one_rung(cfg):
    # Long-term 23.8% → rung 1 exit 2.31x. Mark 24 = 2.4x.
    p = position(held_days=400, mark=24.0)
    d = ev(p, cfg)
    assert (d.action, d.rule, d.rungs, d.contracts) == ("sell_rung", 3, (0,), 1)


def test_filled_rung_not_sold_twice(cfg):
    p = position(held_days=400, mark=24.0, rungs_filled=frozenset({0}))
    assert ev(p, cfg).action == "hold"


def test_multiple_rungs_hit_same_day(cfg):
    p = position(held_days=400, mark=40.0)   # 4.0x ≥ 2.31x and 3.62x
    d = ev(p, cfg)
    assert d.rungs == (0, 1) and d.contracts == 2


def test_target_uses_rate_if_sold_today(cfg):
    # 2.4x clears the long-term rung (2.31x) but not the short-term one (2.69x).
    assert ev(position(held_days=400, mark=24.0), cfg).action == "sell_rung"
    assert ev(position(held_days=100, mark=24.0), cfg).action == "hold"


def test_profit_target_beats_hold_for_long_term(cfg):
    p = position(held_days=340, mark=30.0)   # 3.0x ≥ short-term rung 2.69x
    assert ev(p, cfg).action == "sell_rung"


def test_custom_user_ladder(cfg):
    # 0.5x after tax at 23.8% → exit 1.66x; mark 17 = 1.7x.
    d = ev(position(held_days=400, mark=17.0), cfg, ladder_targets=(0.5,), ladder_fractions=(1.0,))
    assert d.action == "sell_rung" and d.contracts == 3


# ── Rule 4 edges ───────────────────────────────────────────────────

@pytest.mark.parametrize("kw,expected", [
    ({"held_days": 300}, "hold"),                       # 66 days out > 60
    ({"held_days": 306}, "hold_for_long_term"),         # exactly 60 days out
    ({"held_days": 330, "mark": 9.0}, "hold"),          # not in profit
    ({"held_days": 330, "thesis": "unknown"}, "hold"),  # thesis not confirmed intact
    ({"held_days": 330, "instrument": "index_option_1256"}, "hold"),   # no countdown for §1256
    ({"held_days": 400}, "hold"),                       # already long-term
])
def test_hold_for_long_term_conditions(cfg, kw, expected):
    assert ev(position(**kw), cfg).action == expected


def test_1256_has_no_countdown(cfg):
    d = ev(position(instrument="index_option_1256"), cfg)
    assert d.character_today == "section_1256" and d.days_until_long_term is None
    assert d.rates["today"] == pytest.approx(0.6 * 0.238 + 0.4 * 0.408)


# ── Rule 5 ─────────────────────────────────────────────────────────

def test_rotation_at_annual_review(cfg):
    d = ev(position(sector="XLE"), cfg, annual_review=True, top_tier_sectors=frozenset({"XLK", "XLV"}))
    assert (d.action, d.rule) == ("rotate", 5)


def test_no_rotation_outside_review_or_in_top_tier(cfg):
    assert ev(position(sector="XLE"), cfg, top_tier_sectors=frozenset({"XLK"})).action == "hold"
    assert ev(position(sector="XLK"), cfg, annual_review=True, top_tier_sectors=frozenset({"XLK"})).action == "hold"


def test_satellites_never_rotate(cfg):
    p = position(sleeve="satellite", ticker="RXRX", sector=None)
    assert ev(p, cfg, annual_review=True, top_tier_sectors=frozenset({"XLK"})).action == "hold"


def test_hold_for_long_term_beats_rotation(cfg):
    d = ev(position(held_days=330, sector="XLE"), cfg, annual_review=True, top_tier_sectors=frozenset({"XLK"}))
    assert d.action == "hold_for_long_term"


# ── Real tax tables ────────────────────────────────────────────────

def test_profile_rates_feed_the_ladder(cfg):
    src = profile_rates(TaxProfile("single", 800_000, "GA"), load_tax_year(2026))
    d = evaluate_position(position(held_days=400, mark=20.0), today=TODAY, rate_source=src, cfg=cfg)
    assert d.rates["long_term"] == pytest.approx(0.2879)
    assert d.ladder[0]["exit_multiple"] == pytest.approx(1 + 1 / (1 - 0.2879), abs=1e-4)
