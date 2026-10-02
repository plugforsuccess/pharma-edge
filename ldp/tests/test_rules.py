from datetime import timedelta

import pytest

from ldp.config import config_from_dict
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


def test_target_hit_waits_for_long_term_when_it_lands_before_the_roll_window(cfg):
    # +100% hit while short-term; long-term in 36 days, roll window opens in 230.
    p = position(held_days=330, mark=20.0, dte=500)
    d = ev(p, cfg)
    assert (d.action, d.rule) == ("hold_for_long_term", 4)
    assert d.days_until_long_term == 36 and d.rungs == (0,)
    assert d.long_term_date == p.acquired + timedelta(days=366)
    gain = (20.0 * 100 - 1000) * 3
    assert d.tax_saved_by_waiting == pytest.approx(gain * (0.408 - 0.238))


def test_taxes_come_after_the_plan_when_long_term_lands_in_the_roll_window(cfg):
    # Same, but only 300 DTE: the roll window opens in 30 days, long-term in 36 → sell at target.
    d = ev(position(held_days=330, mark=20.0, dte=300), cfg)
    assert (d.action, d.rule_name, d.contracts) == ("sell_rung", "profit_target", 2)


def test_roll_window_rolls_to_passing_contract(cfg):
    p = position(held_days=200, dte=170)
    d = ev(p, cfg, roll_chain=[quote(symbol="XLKNEW", dte=730)])
    assert (d.action, d.rule) == ("roll", 2)
    assert d.replacement.quote.symbol == "XLKNEW" and d.contracts == 3


# ── Rule 1 ─────────────────────────────────────────────────────────

def test_no_hard_price_stop_by_default(cfg):
    # Risk capital that can go to zero: −90% with the thesis intact is a hold.
    assert ev(position(entry_price=10.0, mark=1.0), cfg).action == "hold"


def test_optional_price_stop_still_works():
    cfg = config_from_dict({"exits": {"stop_loss_pct": 0.5}})
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


def test_broken_thesis_beats_roll(cfg):
    p = position(dte=170, thesis="broken")
    assert ev(p, cfg, roll_chain=[quote()]).rule_name == "thesis_broken"


def test_roll_window_flagged_from_nine_months(cfg):
    d = ev(position(dte=250), cfg)
    assert d.action == "hold" and d.details["roll_window"] is True and "roll window" in d.reason
    assert ev(position(dte=300), cfg).details["roll_window"] is False


# ── Rule 3: runner trail ───────────────────────────────────────────

def runner(**kw):
    # 20 contracts: 14 sold at +100%, 3 at +200%, 3 left running.
    base = dict(contracts=20, contracts_open=3, held_days=400, rungs_filled=frozenset({0, 1}), peak_mark=40.0)
    base.update(kw)
    return position(**base)


def test_runner_exits_on_30_percent_giveback_from_peak(cfg):
    d = ev(runner(mark=28.0), cfg)                                # 40 × 0.70
    assert (d.action, d.rule, d.rule_name, d.contracts) == ("sell_all", 3, "runner_trail", 3)
    assert d.details["peak_mark"] == 40.0


def test_runner_keeps_running_above_the_trail(cfg):
    assert ev(runner(mark=28.5), cfg).action == "hold"


def test_user_trail_override(cfg):
    assert ev(runner(mark=30.0), cfg, runner_trail_pct=0.25).rule_name == "runner_trail"


def test_no_trail_before_every_target_fills(cfg):
    # Target 2 not hit yet: a drop from the peak is not a trail exit (no hard stop either).
    p = position(contracts=20, contracts_open=6, held_days=400, rungs_filled=frozenset({0}), peak_mark=29.0, mark=15.0)
    assert ev(p, cfg).action == "hold"


# ── Rule 4: profit targets ─────────────────────────────────────────

def test_target_1_sells_70_percent_at_plus_100(cfg):
    p = position(contracts=20, held_days=400, mark=20.0)           # 2.0x
    d = ev(p, cfg)
    assert (d.action, d.rule, d.rungs, d.contracts) == ("sell_rung", 4, (0,), 14)
    assert ev(position(contracts=20, held_days=400, mark=19.95), cfg).action == "hold"


def test_target_2_sells_half_of_what_is_left_at_plus_200(cfg):
    p = position(contracts=20, contracts_open=6, held_days=400, mark=30.0, rungs_filled=frozenset({0}))
    d = ev(p, cfg)
    assert (d.rungs, d.contracts) == ((1,), 3)


def test_filled_rung_not_sold_twice(cfg):
    p = position(held_days=400, mark=20.0, rungs_filled=frozenset({0}))
    assert ev(p, cfg).action == "hold"


def test_resting_gtc_order_left_to_the_broker(cfg):
    p = position(contracts=20, held_days=400, mark=20.0, rungs_resting=frozenset({0}))
    assert ev(p, cfg).action == "hold"


def test_both_targets_hit_same_day(cfg):
    d = ev(position(contracts=20, held_days=400, mark=30.0), cfg)
    assert d.rungs == (0, 1) and d.contracts == 17


def test_targets_are_pre_tax_so_short_term_sells_at_the_same_price(cfg):
    assert ev(position(held_days=100, mark=20.0), cfg).action == "sell_rung"
    assert ev(position(held_days=400, mark=20.0), cfg).action == "sell_rung"


def test_ladder_records_after_tax_figures(cfg):
    d = ev(position(contracts=20, held_days=400, mark=20.0), cfg)
    r1 = d.ladder[0]
    assert r1["exit_multiple"] == 2.0 and r1["contracts"] == 14
    assert r1["estimated_tax"] == pytest.approx(14 * 1000 * 0.238)


def test_custom_user_ladder(cfg):
    d = ev(position(held_days=400, mark=15.0), cfg, ladder_targets=(0.5,), ladder_fractions=(1.0,))
    assert d.action == "sell_rung" and d.contracts == 3


# ── Rule 4 edges ───────────────────────────────────────────────────

@pytest.mark.parametrize("kw,expected", [
    ({"held_days": 300}, "sell_rung"),                       # 66 days out > 60 → take it
    ({"held_days": 306}, "hold_for_long_term"),              # exactly 60 days out
    ({"held_days": 330, "thesis": "unknown"}, "sell_rung"),  # thesis not confirmed intact
    ({"held_days": 330, "instrument": "index_option_1256"}, "sell_rung"),   # no countdown for §1256
    ({"held_days": 400}, "sell_rung"),                       # already long-term
    ({"held_days": 330, "dte": 300}, "sell_rung"),           # long-term lands in the roll window
    ({"held_days": 330, "mark": 12.0}, "hold"),              # no target hit → nothing to wait for
])
def test_hold_for_long_term_conditions(cfg, kw, expected):
    base = {"mark": 20.0, "dte": 500}
    assert ev(position(**{**base, **kw}), cfg).action == expected


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
    d = ev(position(held_days=330, mark=20.0, sector="XLE"), cfg, annual_review=True,
           top_tier_sectors=frozenset({"XLK"}))
    assert d.action == "hold_for_long_term"


# ── Real tax tables ────────────────────────────────────────────────

def test_profile_rates_feed_the_ladder(cfg):
    src = profile_rates(TaxProfile("single", 800_000, "GA"), load_tax_year(2026))
    d = evaluate_position(position(held_days=400, mark=20.0), today=TODAY, rate_source=src, cfg=cfg)
    assert d.rates["long_term"] == pytest.approx(0.2879)
    assert d.ladder[0]["exit_multiple"] == 2.0                      # targets are pre-tax
    assert d.ladder[0]["rate"] == pytest.approx(0.2879, abs=1e-3)
