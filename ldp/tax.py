"""Per-user tax rates and holding periods — decides when the bot sells.

Tax figures are DATA, read from the per-year config tables
(``tax_year_config`` + ``state_tax_rates``, same shapes as the Supabase
migration ``20261002000000_after_tax_leaps.sql``). Bracket schedules are
``{"single": [[lower_bound, rate], ...], "mfj": ..., "mfs": ..., "hoh": ...}``;
a state schedule may omit statuses that equal ``single``.

Tax on a gain is incremental: ``tax(income + gain) − tax(income)``.
  * Short-term gains are ordinary income stacked on top of ``income``.
  * Long-term gains are stacked on top of ordinary income (and any
    short-term gain), so a gain that straddles the 0/15/20% thresholds
    is split across them.
  * NIIT (3.8%) applies only to the part of investment income above the
    MAGI threshold: ``rate × max(0, min(NII, MAGI − threshold))``.
  * State: the stored schedule, LTCG exclusion, or WA-style gain-only
    schedule, evaluated incrementally — the effective rate on the gain.
The blended rate is ``total tax ÷ gain``.

Section 1256 index options (SPX, XSP, …) are taxed 60% long-term /
40% short-term regardless of holding period.

Every figure here is an ESTIMATE. Actual taxes depend on the user's
full tax situation (deductions, other gains/losses, AMT, credits, local
taxes); users should consult a tax professional.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Literal, Mapping, Sequence

from .models import FilingStatus, InstrumentType

TAX_DISCLAIMER = (
    "Tax figures are estimates. Actual taxes depend on your full tax situation; "
    "consult a tax professional."
)

SECTION_1256_LT_SHARE = 0.6

Brackets = Sequence[Sequence[float]]
Schedule = Mapping[str, Brackets]
Character = Literal["long_term", "short_term", "section_1256"]


# ── Config tables ──────────────────────────────────────────────────

@dataclass(frozen=True)
class StateTax:
    state_code: str
    ordinary: Schedule
    ltcg: Schedule | None = None
    ltcg_applies_to: Literal["income", "gain"] = "income"
    ltcg_exclusion_pct: float = 0.0
    stcg: Schedule | None = None
    confidence: str = "medium"
    # Gains excluded from US federal tax + NIIT for bona fide residents
    # (Puerto Rico, IRC §933 — post-move appreciation only).
    federal_exempt: bool = False


@dataclass(frozen=True)
class TaxYear:
    tax_year: int
    ordinary: Schedule
    ltcg: Schedule
    niit_rate: float
    niit_thresholds: Mapping[str, float]
    states: Mapping[str, StateTax] = field(default_factory=dict)

    @classmethod
    def from_rows(cls, config_row: Mapping, state_rows: Sequence[Mapping]) -> "TaxYear":
        """Build from ``tax_year_config`` + ``state_tax_rates`` rows."""
        states = {
            r["state_code"]: StateTax(
                state_code=r["state_code"],
                ordinary=r["ordinary"],
                ltcg=r.get("ltcg"),
                ltcg_applies_to=r.get("ltcg_applies_to") or "income",
                ltcg_exclusion_pct=float(r.get("ltcg_exclusion_pct") or 0),
                stcg=r.get("stcg"),
                confidence=r.get("confidence") or "medium",
                federal_exempt=bool(r.get("federal_exempt", False)),
            )
            for r in state_rows
        }
        niit = config_row["niit"]
        return cls(
            tax_year=int(config_row["tax_year"]),
            ordinary=config_row["ordinary"],
            ltcg=config_row["ltcg"],
            niit_rate=float(niit["rate"]),
            niit_thresholds=niit["thresholds"],
            states=states,
        )

    @classmethod
    def from_json(cls, path: str | Path) -> "TaxYear":
        data = json.loads(Path(path).read_text())
        return cls.from_rows(data["tax_year_config"], data["state_tax_rates"])


DATA_DIR = Path(__file__).parent / "data"


def load_tax_year(year: int) -> TaxYear:
    """Offline snapshot of the config tables (ldp/data/tax_<year>.json).

    Production reads the Supabase tables; this snapshot is kept identical
    to the migration seed by tests/test_tax_data.py.
    """
    return TaxYear.from_json(DATA_DIR / f"tax_{year}.json")


# ── User inputs ────────────────────────────────────────────────────

@dataclass(frozen=True)
class TaxProfile:
    filing_status: FilingStatus
    income: float                     # taxable ordinary income before these gains
    state_code: str | None
    magi: float | None = None         # defaults to income
    other_investment_income: float = 0.0
    # CPA-provided combined rates; replace the computed figure entirely.
    lt_rate_override: float | None = None
    st_rate_override: float | None = None
    # Puerto Rico Act 60 decree rate on PR-source gains (0 for decrees by
    # 2026-12-31, 0.04 for 2027+). None = no decree.
    pr_act60_rate: float | None = None

    def __post_init__(self) -> None:
        if self.filing_status not in ("single", "mfj", "mfs", "hoh"):
            raise ValueError(f"unknown filing status: {self.filing_status}")
        for r in (self.lt_rate_override, self.st_rate_override, self.pr_act60_rate):
            if r is not None and not (0 <= r <= 0.99):
                raise ValueError("rate overrides must be between 0% and 99%")
        if self.income < 0:
            raise ValueError("income must be ≥ 0")


# ── Bracket math ───────────────────────────────────────────────────

def _for_status(schedule: Schedule | None, status: str) -> Brackets | None:
    if schedule is None:
        return None
    return schedule.get(status) or schedule.get("single")


def bracket_tax(brackets: Brackets | None, amount: float) -> float:
    """Tax a progressive schedule charges on ``amount``."""
    if not brackets or amount <= 0:
        return 0.0
    tax = 0.0
    for i, (lo, rate) in enumerate(brackets):
        hi = brackets[i + 1][0] if i + 1 < len(brackets) else float("inf")
        if amount <= lo:
            break
        tax += (min(amount, hi) - lo) * rate
    return tax


def stacked_tax(brackets: Brackets | None, base: float, amount: float) -> float:
    """Tax on ``amount`` stacked on top of ``base`` — T(base+amount) − T(base)."""
    if amount <= 0:
        return 0.0
    return bracket_tax(brackets, base + amount) - bracket_tax(brackets, base)


def marginal_rate(brackets: Brackets | None, amount: float) -> float:
    if not brackets:
        return 0.0
    rate = brackets[0][1]
    for lo, r in brackets:
        if amount > lo:
            rate = r
        else:
            break
    return rate


@dataclass(frozen=True)
class GainTax:
    gain: float
    short_term_part: float
    long_term_part: float
    federal: float
    niit: float
    state: float
    overridden: bool = False

    @property
    def total(self) -> float:
        return self.federal + self.niit + self.state

    @property
    def blended_rate(self) -> float:
        return self.total / self.gain if self.gain > 0 else 0.0

    def to_record(self) -> dict:
        return {
            "gain": round(self.gain, 2),
            "short_term_part": round(self.short_term_part, 2),
            "long_term_part": round(self.long_term_part, 2),
            "federal": round(self.federal, 2),
            "niit": round(self.niit, 2),
            "state": round(self.state, 2),
            "total": round(self.total, 2),
            "blended_rate": round(self.blended_rate, 6),
            "overridden": self.overridden,
        }


def tax_on_gains(profile: TaxProfile, ty: TaxYear, *, short_term: float = 0.0, long_term: float = 0.0) -> GainTax:
    """Incremental tax on realising these gains, ST stacked first, then LT."""
    st = max(0.0, short_term)
    lt = max(0.0, long_term)
    gain = st + lt
    if gain <= 0:
        return GainTax(0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    fs = profile.filing_status
    inc = profile.income
    st_row = ty.states.get(profile.state_code or "")

    if st_row is not None and st_row.federal_exempt:
        # Bona fide Puerto Rico resident: gains on post-move appreciation
        # are PR-source and excluded from federal tax and NIIT (§933).
        if profile.pr_act60_rate is not None:
            return GainTax(gain, st, lt, 0.0, 0.0, gain * profile.pr_act60_rate)
        ordinary = _for_status(st_row.ordinary, fs)
        state_tax = stacked_tax(_for_status(st_row.stcg, fs) if st_row.stcg else ordinary, inc, st)
        if st_row.ltcg:
            state_tax += stacked_tax(_for_status(st_row.ltcg, fs), inc + st, lt)
        else:
            state_tax += stacked_tax(ordinary, inc + st, lt * (1 - st_row.ltcg_exclusion_pct))
        return GainTax(gain, st, lt, 0.0, 0.0, state_tax)

    federal = stacked_tax(_for_status(ty.ordinary, fs), inc, st)
    federal += stacked_tax(_for_status(ty.ltcg, fs), inc + st, lt)

    magi = (profile.magi if profile.magi is not None else inc)
    threshold = ty.niit_thresholds.get(fs, float("inf"))
    nii_before = max(0.0, profile.other_investment_income)

    def _niit(m: float, nii: float) -> float:
        return ty.niit_rate * max(0.0, min(nii, m - threshold))

    niit = _niit(magi + gain, nii_before + gain) - _niit(magi, nii_before)

    state_tax = 0.0
    if st_row is not None:
        ordinary = _for_status(st_row.ordinary, fs)
        st_sched = _for_status(st_row.stcg, fs) if st_row.stcg else ordinary
        state_tax += stacked_tax(st_sched, inc, st)
        if st_row.ltcg:
            lt_sched = _for_status(st_row.ltcg, fs)
            base = 0.0 if st_row.ltcg_applies_to == "gain" else inc + st
            state_tax += stacked_tax(lt_sched, base, lt)
        else:
            taxable_lt = lt * (1 - st_row.ltcg_exclusion_pct)
            state_tax += stacked_tax(ordinary, inc + st, taxable_lt)

    return GainTax(gain, st, lt, federal, niit, state_tax)


def tax_on_gain(profile: TaxProfile, ty: TaxYear, gain: float, character: Character) -> GainTax:
    """Tax on one position's gain, honouring CPA overrides."""
    g = max(0.0, gain)
    if character == "section_1256":
        st_part, lt_part = g * (1 - SECTION_1256_LT_SHARE), g * SECTION_1256_LT_SHARE
    elif character == "long_term":
        st_part, lt_part = 0.0, g
    else:
        st_part, lt_part = g, 0.0

    computed = tax_on_gains(profile, ty, short_term=st_part, long_term=lt_part)
    lt_o, st_o = profile.lt_rate_override, profile.st_rate_override
    if (lt_part > 0 and lt_o is not None) or (st_part > 0 and st_o is not None):
        # Override each part that has one; compute the other part alone.
        lt_tax = lt_part * lt_o if lt_o is not None else tax_on_gains(profile, ty, long_term=lt_part).total
        st_tax = st_part * st_o if st_o is not None else tax_on_gains(profile, ty, short_term=st_part).total
        return GainTax(g, st_part, lt_part, lt_tax + st_tax, 0.0, 0.0, overridden=True)
    return computed


@dataclass(frozen=True)
class UserRates:
    """Blended rates on a given gain — what the exit ladder and the
    "tax saved by waiting" figure use."""

    gain: float
    long_term: float
    short_term: float
    section_1256: float
    breakdown: dict

    def for_character(self, character: Character) -> float:
        return {"long_term": self.long_term, "short_term": self.short_term,
                "section_1256": self.section_1256}[character]


def user_rates(profile: TaxProfile, ty: TaxYear, gain: float) -> UserRates:
    g = max(0.0, gain)
    if g <= 0:
        # No gain → report the rate the first dollar would pay.
        g = 1.0
    lt = tax_on_gain(profile, ty, g, "long_term")
    st = tax_on_gain(profile, ty, g, "short_term")
    ix = tax_on_gain(profile, ty, g, "section_1256")
    return UserRates(
        gain=max(0.0, gain),
        long_term=lt.blended_rate,
        short_term=st.blended_rate,
        section_1256=ix.blended_rate,
        breakdown={"long_term": lt.to_record(), "short_term": st.to_record(),
                   "section_1256": ix.to_record(), "tax_year": ty.tax_year},
    )


def marginal_breakdown(profile: TaxProfile, ty: TaxYear, gain: float = 0.0) -> dict:
    """Display-only: federal + NIIT + state marginal components at the top
    of the stack, e.g. 20% + 3.8% + 4.99% = 28.79%."""
    fs = profile.filing_status
    top = profile.income + max(0.0, gain)
    magi = (profile.magi if profile.magi is not None else profile.income) + max(0.0, gain)
    niit = ty.niit_rate if magi > ty.niit_thresholds.get(fs, float("inf")) else 0.0
    st_row = ty.states.get(profile.state_code or "")
    st_ord = marginal_rate(_for_status(st_row.ordinary, fs), top) if st_row else 0.0
    st_lt = st_ord * (1 - (st_row.ltcg_exclusion_pct if st_row else 0))
    if st_row and st_row.ltcg:
        st_lt = marginal_rate(_for_status(st_row.ltcg, fs), max(0.0, gain) if st_row.ltcg_applies_to == "gain" else top)
    fed_lt = marginal_rate(_for_status(ty.ltcg, fs), top)
    fed_st = marginal_rate(_for_status(ty.ordinary, fs), top)
    if st_row and st_row.federal_exempt:
        fed_lt = fed_st = niit = 0.0
        if profile.pr_act60_rate is not None:
            st_lt = st_ord = profile.pr_act60_rate
    return {
        "long_term": {"federal": fed_lt, "niit": niit, "state": st_lt, "total": round(fed_lt + niit + st_lt, 6)},
        "short_term": {"federal": fed_st, "niit": niit, "state": st_ord, "total": round(fed_st + niit + st_ord, 6)},
    }


# ── Holding period ─────────────────────────────────────────────────

def anniversary(acquired: date) -> date:
    """One-year anniversary; a Feb 29 acquisition anniversaries on Feb 28."""
    try:
        return acquired.replace(year=acquired.year + 1)
    except ValueError:
        return acquired.replace(year=acquired.year + 1, day=28)


def long_term_start(acquired: date) -> date:
    """First sale date that is long-term: anniversary + 1 day."""
    return anniversary(acquired) + timedelta(days=1)


def is_long_term(acquired: date, sold: date) -> bool:
    return sold >= long_term_start(acquired)


def days_until_long_term(acquired: date, today: date) -> int:
    return max(0, (long_term_start(acquired) - today).days)


def stock_acquired_on_exercise(exercise_date: date) -> date:
    """Exercising starts a new holding period for the stock the day after
    exercise. Returned as the acquisition date that the holding-period
    functions count from (their clock already starts the day after)."""
    return exercise_date


def character(instrument_type: InstrumentType, acquired: date, sold: date) -> Character:
    if instrument_type == "index_option_1256":
        return "section_1256"
    return "long_term" if is_long_term(acquired, sold) else "short_term"
