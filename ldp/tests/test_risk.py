import pytest

from ldp.risk import OnboardingAnswers, compute_risk_profile, describe, permission


def tier(cfg, **kw):
    base = dict(stated_tolerance="aggressive", account_size=50_000, options_experience="experienced", horizon_years=5)
    base.update(kw)
    return compute_risk_profile(OnboardingAnswers(**base), cfg.risk)


# ── Required cases ─────────────────────────────────────────────────

def test_small_account_caps_at_moderate(cfg):
    p = tier(cfg, account_size=10_000)
    assert (p.tier, p.capped_by) == ("moderate", "account_size")


def test_no_experience_caps_at_moderate(cfg):
    p = tier(cfg, options_experience="none")
    assert (p.tier, p.capped_by) == ("moderate", "options_experience")


def test_short_horizon_caps_at_conservative(cfg):
    p = tier(cfg, horizon_years=1)
    assert (p.tier, p.capped_by) == ("conservative", "time_horizon")


def test_uncapped_aggressive(cfg):
    p = tier(cfg)
    assert (p.tier, p.capped_by) == ("aggressive", None)


def test_aggressive_self_directed_satellites_are_suggestions_only():
    perm = permission("satellite", "aggressive", "self_directed")
    assert perm.mode == "suggest"
    assert any("self-directed" in r for r in perm.reasons)


# ── Rule mechanics ─────────────────────────────────────────────────

def test_lowest_result_wins_and_all_rules_recorded(cfg):
    p = tier(cfg, account_size=10_000, options_experience="none", horizon_years=1)
    assert p.tier == "conservative" and p.capped_by == "time_horizon"
    fired = {r.rule for r in p.rules if r.fired}
    assert fired == {"stated_tolerance", "account_size", "options_experience", "time_horizon"}
    rec = p.to_record()
    assert rec["inputs"]["account_size"] == 10_000 and len(rec["rules"]) == 4


def test_equal_caps_report_first_rule(cfg):
    p = tier(cfg, account_size=10_000, options_experience="none")
    assert (p.tier, p.capped_by) == ("moderate", "account_size")


def test_caps_never_raise_a_tier(cfg):
    p = tier(cfg, stated_tolerance="conservative", account_size=10_000)
    assert (p.tier, p.capped_by) == ("conservative", None)


def test_threshold_boundaries(cfg):
    assert tier(cfg, account_size=25_000).tier == "aggressive"
    assert tier(cfg, horizon_years=2).tier == "aggressive"


def test_invalid_answers_rejected():
    with pytest.raises(ValueError):
        OnboardingAnswers("yolo", 1, "none", 1)


@pytest.mark.parametrize("sleeve,risk,acct,mode", [
    ("core", "conservative", "managed", "auto"),
    ("core", "aggressive", "self_directed", "suggest"),
    ("satellite", "conservative", "managed", "blocked"),
    ("satellite", "conservative", "self_directed", "blocked"),
    ("satellite", "moderate", "managed", "suggest"),
    ("satellite", "aggressive", "managed", "auto"),
    ("satellite", "aggressive", "self_directed", "suggest"),
])
def test_permission_table(sleeve, risk, acct, mode):
    assert permission(sleeve, risk, acct).mode == mode


def test_describe_for_ui(cfg):
    d = describe(tier(cfg, account_size=10_000), "managed", cfg)
    assert d["label"] == "Moderate"
    assert "$25,000" in d["capped_by_text"]
    assert "approve" in d["allows"]
    d2 = describe(tier(cfg), "self_directed", cfg)
    assert "5% per name, 15% total" in d2["allows"] and "Self-directed" in d2["account_text"]
    assert "Managed" in d["account_text"]


def test_profile_row_for_store(cfg):
    from ldp.store import risk_profile_row
    row = risk_profile_row("u1", tier(cfg, options_experience="none"), "self_directed", cfg)
    assert row["tier"] == "moderate" and row["capped_by"] == "options_experience"
    assert row["display"]["label"] == "Moderate" and len(row["rule_results"]) == 4
    assert row["account_tier"] == "self_directed"
