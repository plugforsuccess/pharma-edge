"""Risk profile — decides what the bot is allowed to buy.

The tier is computed from the onboarding answers, never from the stated
tolerance alone. Rules run in order and the LOWEST resulting tier wins:

  1. start from the stated tolerance
  2. account under ``risk.min_account_aggressive``  → cap at moderate
  3. options experience = none                     → cap at moderate
  4. time horizon under ``risk.min_horizon_years``  → cap at conservative

Every rule's result is kept (fired or not) so the audit log and
suitability records can show exactly why a user landed where they did.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .config import LDPConfig, RiskConfig, SatelliteConfig
from .models import RISK_TIERS, AccountTier, RiskTier, Sleeve

Experience = Literal["none", "some", "experienced"]
_RANK = {t: i for i, t in enumerate(RISK_TIERS)}


@dataclass(frozen=True)
class OnboardingAnswers:
    stated_tolerance: RiskTier
    account_size: float
    options_experience: Experience
    horizon_years: float

    def __post_init__(self) -> None:
        if self.stated_tolerance not in _RANK:
            raise ValueError(f"unknown risk tolerance: {self.stated_tolerance}")
        if self.options_experience not in ("none", "some", "experienced"):
            raise ValueError(f"unknown options experience: {self.options_experience}")
        if self.account_size < 0 or self.horizon_years < 0:
            raise ValueError("account size and horizon must be ≥ 0")


@dataclass(frozen=True)
class RuleResult:
    rule: str
    fired: bool
    cap: RiskTier | None
    detail: str


@dataclass(frozen=True)
class RiskProfile:
    tier: RiskTier
    answers: OnboardingAnswers
    rules: tuple[RuleResult, ...]
    # The rule that set the final tier; None when the stated tolerance stood.
    capped_by: str | None

    def to_record(self) -> dict:
        return {
            "tier": self.tier,
            "capped_by": self.capped_by,
            "inputs": {
                "stated_tolerance": self.answers.stated_tolerance,
                "account_size": self.answers.account_size,
                "options_experience": self.answers.options_experience,
                "horizon_years": self.answers.horizon_years,
            },
            "rules": [r.__dict__ for r in self.rules],
        }


def compute_risk_profile(answers: OnboardingAnswers, cfg: RiskConfig) -> RiskProfile:
    rules = [
        RuleResult("stated_tolerance", True, answers.stated_tolerance,
                   f"stated tolerance: {answers.stated_tolerance}"),
        RuleResult(
            "account_size",
            answers.account_size < cfg.min_account_aggressive,
            "moderate" if answers.account_size < cfg.min_account_aggressive else None,
            f"account ${answers.account_size:,.0f} vs ${cfg.min_account_aggressive:,.0f} minimum for aggressive",
        ),
        RuleResult(
            "options_experience",
            answers.options_experience == "none",
            "moderate" if answers.options_experience == "none" else None,
            f"options experience: {answers.options_experience}",
        ),
        RuleResult(
            "time_horizon",
            answers.horizon_years < cfg.min_horizon_years,
            "conservative" if answers.horizon_years < cfg.min_horizon_years else None,
            f"horizon {answers.horizon_years:g} yr vs {cfg.min_horizon_years:g} yr minimum",
        ),
    ]
    tier: RiskTier = answers.stated_tolerance
    capped_by: str | None = None
    for r in rules[1:]:
        # Strictly lower only: when two rules cap to the same tier, the
        # first one in rule order is reported.
        if r.fired and r.cap is not None and _RANK[r.cap] < _RANK[tier]:
            tier, capped_by = r.cap, r.rule
    return RiskProfile(tier=tier, answers=answers, rules=tuple(rules), capped_by=capped_by)


# ── What each tier allows ──────────────────────────────────────────

Mode = Literal["auto", "suggest", "blocked"]


@dataclass(frozen=True)
class Permission:
    mode: Mode
    reasons: tuple[str, ...]


def permission(sleeve: Sleeve, risk_tier: RiskTier, account_tier: AccountTier) -> Permission:
    """Whether a trade in this sleeve is auto-traded, suggested, or blocked.

    Compliance: auto-trading on a user's behalf requires a managed
    account. Self-directed subscription accounts get suggestions only,
    whatever the risk tier.
    """
    reasons: list[str] = []
    if sleeve == "core":
        mode: Mode = "auto"
        reasons.append("core sector ETFs auto-trade at every risk tier")
    elif risk_tier == "conservative":
        return Permission("blocked", ("conservative tier: satellites are never traded or suggested",))
    elif risk_tier == "moderate":
        mode = "suggest"
        reasons.append("moderate tier: satellites need the user's approval on each trade")
    else:
        mode = "auto"
        reasons.append("aggressive tier: satellites auto-trade within size caps")

    if mode == "auto" and account_tier != "managed":
        mode = "suggest"
        reasons.append("self-directed account: suggestions only (auto-trading requires a managed account)")
    elif mode == "auto":
        reasons.append("managed account: auto-trading allowed")
    return Permission(mode, tuple(reasons))


# ── UI labels ──────────────────────────────────────────────────────

TIER_LABELS: dict[RiskTier, str] = {
    "conservative": "Conservative",
    "moderate": "Moderate",
    "aggressive": "Aggressive",
}

def tier_allows(tier: RiskTier, sat: SatelliteConfig) -> str:
    if tier == "conservative":
        return "Core sector-ETF LEAPS only. Small-cap satellites are never traded or suggested."
    if tier == "moderate":
        return "Core sector-ETF LEAPS, plus small-cap satellites as suggestions you approve one by one."
    return (
        "Core sector-ETF LEAPS, plus small-cap satellites within size caps "
        f"({sat.max_per_name:.0%} per name, {sat.max_total:.0%} total)."
    )


def capped_by_text(capped_by: str | None, risk: RiskConfig) -> str:
    if capped_by == "account_size":
        return f"Capped at Moderate because the account is under ${risk.min_account_aggressive:,.0f}."
    if capped_by == "options_experience":
        return "Capped at Moderate because you have no options experience yet."
    if capped_by == "time_horizon":
        return f"Capped at Conservative because your time horizon is under {risk.min_horizon_years:g} years."
    return "Based on your stated risk tolerance."


def describe(profile: RiskProfile, account_tier: AccountTier, cfg: LDPConfig) -> dict:
    """Plain-language summary for the UI: tier, why, what it allows."""
    return {
        "tier": profile.tier,
        "label": TIER_LABELS[profile.tier],
        "capped_by": profile.capped_by,
        "capped_by_text": capped_by_text(profile.capped_by, cfg.risk),
        "allows": tier_allows(profile.tier, cfg.satellite),
        "account_text": (
            "Managed account — the bot places trades for you within these limits."
            if account_tier == "managed"
            else "Self-directed account — the bot suggests trades; you place them."
        ),
    }
