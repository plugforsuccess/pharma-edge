from datetime import date

import pytest

from ldp.tax import (
    TaxProfile, character, days_until_long_term, is_long_term, load_tax_year, long_term_start,
    marginal_breakdown, stock_acquired_on_exercise, tax_on_gain, tax_on_gains, user_rates,
)

TY = load_tax_year(2026)


def prof(**kw):
    base = dict(filing_status="single", income=800_000, state_code="TX")
    base.update(kw)
    return TaxProfile(**base)


# ── Holding period (required) ──────────────────────────────────────

def test_sold_on_anniversary_is_short_term():
    assert not is_long_term(date(2026, 3, 15), date(2027, 3, 15))


def test_sold_day_after_anniversary_is_long_term():
    assert is_long_term(date(2026, 3, 15), date(2027, 3, 16))


def test_feb_29_purchase_goes_long_term_mar_1():
    assert long_term_start(date(2028, 2, 29)) == date(2029, 3, 1)
    assert not is_long_term(date(2028, 2, 29), date(2029, 2, 28))
    assert is_long_term(date(2028, 2, 29), date(2029, 3, 1))


def test_days_until_long_term():
    assert days_until_long_term(date(2025, 1, 10), date(2025, 1, 10)) == 366
    assert days_until_long_term(date(2025, 1, 10), date(2026, 1, 10)) == 1
    assert days_until_long_term(date(2025, 1, 10), date(2026, 1, 11)) == 0


def test_exercise_starts_new_holding_period():
    acquired = stock_acquired_on_exercise(date(2026, 5, 10))
    assert long_term_start(acquired) == date(2027, 5, 11)
    # Option held since 2024 — irrelevant to the stock's clock.
    assert not is_long_term(acquired, date(2027, 5, 10))


def test_section_1256_ignores_holding_period():
    assert character("index_option_1256", date(2026, 9, 1), date(2026, 9, 2)) == "section_1256"
    assert character("equity_option", date(2025, 9, 1), date(2026, 9, 2)) == "long_term"


# ── Rates ──────────────────────────────────────────────────────────

def test_top_bracket_georgia_rates():
    p = prof(state_code="GA")
    assert tax_on_gain(p, TY, 100_000, "long_term").blended_rate == pytest.approx(0.2879)
    assert tax_on_gain(p, TY, 100_000, "short_term").blended_rate == pytest.approx(0.4579)
    m = marginal_breakdown(p, TY)
    assert m["long_term"] == {"federal": 0.2, "niit": 0.038, "state": 0.0499, "total": 0.2879}


def test_no_income_tax_state():
    assert tax_on_gain(prof(), TY, 100_000, "long_term").blended_rate == pytest.approx(0.238)
    assert tax_on_gain(prof(), TY, 100_000, "short_term").blended_rate == pytest.approx(0.408)


def test_long_term_gain_stacked_across_zero_bracket():
    # $30k ordinary + $40k LTCG: 0% up to $49,450, then 15%.
    t = tax_on_gain(prof(income=30_000), TY, 40_000, "long_term")
    assert t.federal == pytest.approx((70_000 - 49_450) * 0.15)
    assert t.niit == 0


def test_short_term_gain_crosses_ordinary_bracket():
    t = tax_on_gain(prof(income=100_000), TY, 10_000, "short_term")
    assert t.federal == pytest.approx(5_700 * 0.22 + 4_300 * 0.24)


def test_niit_only_above_threshold():
    # MAGI $150k + $100k gain: only $50k is above the $200k threshold.
    t = tax_on_gain(prof(income=150_000), TY, 100_000, "long_term")
    assert t.niit == pytest.approx(50_000 * 0.038)
    assert t.total == pytest.approx(100_000 * 0.15 + 1_900)


@pytest.mark.parametrize("status,threshold", [("single", 200_000), ("hoh", 200_000), ("mfj", 250_000), ("mfs", 125_000)])
def test_niit_thresholds(status, threshold):
    below = tax_on_gain(prof(filing_status=status, income=threshold - 10_000), TY, 10_000, "long_term")
    above = tax_on_gain(prof(filing_status=status, income=threshold - 10_000), TY, 20_000, "long_term")
    assert below.niit == 0
    assert above.niit == pytest.approx(10_000 * 0.038)


def test_section_1256_is_60_40():
    t = tax_on_gain(prof(), TY, 100_000, "section_1256")
    assert (t.short_term_part, t.long_term_part) == (40_000, 60_000)
    assert t.blended_rate == pytest.approx(0.6 * 0.238 + 0.4 * 0.408)


def test_washington_gain_only_tax_above_deduction():
    t = tax_on_gain(prof(state_code="WA"), TY, 300_000, "long_term")
    assert t.state == pytest.approx((300_000 - 278_000) * 0.07)
    assert tax_on_gain(prof(state_code="WA"), TY, 300_000, "short_term").state == 0


def test_partial_exclusion_state():
    # South Carolina excludes 44% of LTCG; top rate 5.21%.
    t = tax_on_gain(prof(state_code="SC"), TY, 100_000, "long_term")
    assert t.state == pytest.approx(56_000 * 0.0521)


def test_massachusetts_short_term_rate():
    t = tax_on_gain(prof(state_code="MA", income=300_000), TY, 10_000, "short_term")
    assert t.state == pytest.approx(10_000 * 0.085)


def test_override_replaces_computed_rate():
    p = prof(lt_rate_override=0.25)
    assert tax_on_gain(p, TY, 100_000, "long_term").blended_rate == pytest.approx(0.25)
    assert tax_on_gain(p, TY, 100_000, "long_term").overridden
    # ST has no override → computed.
    assert tax_on_gain(p, TY, 100_000, "short_term").blended_rate == pytest.approx(0.408)
    # §1256 mixes override (LT 60%) with computed ST (40%).
    assert tax_on_gain(p, TY, 100_000, "section_1256").blended_rate == pytest.approx(
        0.6 * 0.25 + 0.4 * tax_on_gains(p, TY, short_term=40_000).total / 40_000)


@pytest.mark.parametrize("bad", [-0.01, 1.0])
def test_invalid_override_rejected(bad):
    with pytest.raises(ValueError):
        prof(lt_rate_override=bad)


def test_no_gain_no_tax():
    assert tax_on_gain(prof(), TY, -5_000, "short_term").total == 0


def test_user_rates_bundle():
    r = user_rates(prof(state_code="GA"), TY, 50_000)
    assert r.long_term == pytest.approx(0.2879) and r.short_term == pytest.approx(0.4579)
    assert r.for_character("section_1256") == pytest.approx(0.6 * 0.2879 + 0.4 * 0.4579)
    assert r.breakdown["tax_year"] == 2026
