"""LDP engine configuration.

Every threshold the engine uses lives here — nothing is hard-coded in
the rule modules. Defaults below match the LDP spec; deployments
override them with a TOML file (see ``ldp/defaults/ldp.default.toml``)
via :func:`load_config`, which deep-merges the file over the defaults.

Tax figures (brackets, LTCG thresholds, NIIT, state rates) are NOT in
this config. They are per-tax-year data in ``tax_year_config`` /
``state_tax_rates`` (see :mod:`ldp.tax`).
"""

from __future__ import annotations

import dataclasses
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class RiskConfig:
    # Accounts below this are capped at "moderate".
    min_account_aggressive: float = 25_000.0
    # Horizons below this are capped at "conservative".
    min_horizon_years: float = 2.0


@dataclass(frozen=True)
class SatelliteConfig:
    # Fractions of account value at buy time.
    max_per_name: float = 0.05
    max_total: float = 0.15
    # Hard rejects.
    min_runway_months: float = 12.0
    catalyst_blackout_days: int = 14
    # When a held satellite gets a binary event inside the blackout and
    # the user hasn't allowed catalyst plays, treat it as a hard-reject
    # condition appearing (sell rule 1).
    sell_on_blackout_catalyst: bool = True
    # Candidates scoring below this are not bought or suggested.
    min_score: float = 0.5
    # Signal weights (normalised by their sum).
    weights: Mapping[str, float] = field(default_factory=lambda: {
        "runway": 0.25,
        "catalysts": 0.20,
        "dilution": 0.20,
        "institutional": 0.15,
        "short_interest": 0.10,
        "momentum": 0.10,
    })
    # Normalisation bounds for each signal → 0..1.
    runway_full_score_months: float = 36.0
    catalyst_lookahead_days: int = 365
    institutional_change_range_pct: float = 20.0   # −20%..+20% → 0..1
    max_short_interest_pct: float = 30.0           # ≥30% → 0
    momentum_range_pct: float = 50.0               # −50%..+50% → 0..1
    dilution_penalty_per_offering: float = 0.35
    dilution_penalty_shelf: float = 0.30
    dilution_lookback_days: int = 365


@dataclass(frozen=True)
class ContractConfig:
    min_dte_days: int = 540
    target_dte_days: int = 730
    core_delta_min: float = 0.70
    core_delta_max: float = 0.80
    satellite_delta_min: float = 0.60
    satellite_delta_max: float = 0.80
    max_iv_rank: float = 70.0
    max_spread_pct: float = 0.10       # of mid
    min_open_interest: int = 100
    # No IV rank → can't prove it's below max → reject.
    reject_missing_iv_rank: bool = True


@dataclass(frozen=True)
class OrderConfig:
    # Limit-only. Start at mid, step toward the ask (buys) / bid (sells)
    # by this fraction of the bid/ask spread, cancel after max_steps.
    step_pct_of_spread: float = 0.25
    max_steps: int = 4
    step_wait_seconds: float = 60.0
    poll_interval_seconds: float = 5.0
    tick_size: float = 0.05
    duration: str = "day"


@dataclass(frozen=True)
class ExitConfig:
    # After-tax gain targets as multiples of basis (1.0 = double after tax).
    ladder: tuple[float, ...] = (1.0, 2.0, 3.0)
    # Fraction of the original position sold at each rung. None → equal.
    rung_fractions: tuple[float, ...] | None = None
    roll_dte_days: int = 180
    ltcg_wait_days: int = 60
    # Price stop: sell when the mark is down this fraction from entry.
    stop_loss_pct: float = 0.50


@dataclass(frozen=True)
class CoreConfig:
    # Sectors in the top tier at the annual review are held; others rotate.
    top_n_sectors: int = 3
    # Share of account value deployed into core LEAPS at the annual buy,
    # split equally across the top-tier sectors.
    allocation_pct: float = 0.30
    weights: Mapping[str, float] = field(default_factory=lambda: {
        "ret_3m": 0.20,
        "ret_6m": 0.30,
        "ret_12m": 0.30,
        "rel_strength": 0.20,
    })
    # Sectors trading below their 200-day average can't be top tier.
    require_above_200dma: bool = True


@dataclass(frozen=True)
class CadenceConfig:
    # Default annual buy window (MM-DD start, length in days). Users can
    # pick their own start; re-entry after a sell is allowed any time.
    buy_window_start: str = "01-15"
    buy_window_days: int = 21


@dataclass(frozen=True)
class LDPConfig:
    risk: RiskConfig = field(default_factory=RiskConfig)
    satellite: SatelliteConfig = field(default_factory=SatelliteConfig)
    contracts: ContractConfig = field(default_factory=ContractConfig)
    orders: OrderConfig = field(default_factory=OrderConfig)
    exits: ExitConfig = field(default_factory=ExitConfig)
    core: CoreConfig = field(default_factory=CoreConfig)
    cadence: CadenceConfig = field(default_factory=CadenceConfig)

    def __post_init__(self) -> None:
        validate(self)


def validate(cfg: LDPConfig) -> None:
    s, c, e, o = cfg.satellite, cfg.contracts, cfg.exits, cfg.orders
    _check(0 < s.max_per_name <= s.max_total <= 1, "satellite caps: 0 < max_per_name ≤ max_total ≤ 1")
    _check(c.min_dte_days <= c.target_dte_days, "contracts: min_dte_days ≤ target_dte_days")
    _check(0 < c.core_delta_min <= c.core_delta_max < 1, "contracts: core delta band")
    _check(0 < c.satellite_delta_min <= c.satellite_delta_max < 1, "contracts: satellite delta band")
    _check(0 < c.max_spread_pct < 1, "contracts: max_spread_pct in (0, 1)")
    _check(len(e.ladder) > 0 and all(t > 0 for t in e.ladder), "exits: ladder targets must be > 0")
    if e.rung_fractions is not None:
        _check(len(e.rung_fractions) == len(e.ladder), "exits: one rung fraction per ladder target")
        _check(abs(sum(e.rung_fractions) - 1) < 1e-9 and all(f > 0 for f in e.rung_fractions),
               "exits: rung fractions must be > 0 and sum to 1")
    _check(0 < e.stop_loss_pct < 1, "exits: stop_loss_pct in (0, 1)")
    _check(e.roll_dte_days < c.min_dte_days, "exits: roll_dte_days must be below contracts.min_dte_days")
    _check(o.max_steps >= 1 and 0 < o.step_pct_of_spread <= 1 and o.tick_size > 0, "orders: ladder settings")
    _check(0 < cfg.core.allocation_pct <= 1 and cfg.core.top_n_sectors >= 1, "core: allocation")


def _check(ok: bool, msg: str) -> None:
    if not ok:
        raise ValueError(f"invalid LDP config — {msg}")


def rung_fractions(cfg: ExitConfig) -> tuple[float, ...]:
    if cfg.rung_fractions is not None:
        return tuple(cfg.rung_fractions)
    n = len(cfg.ladder)
    return tuple(1.0 / n for _ in range(n))


_SECTIONS = {
    "risk": RiskConfig,
    "satellite": SatelliteConfig,
    "contracts": ContractConfig,
    "orders": OrderConfig,
    "exits": ExitConfig,
    "core": CoreConfig,
    "cadence": CadenceConfig,
}


def config_from_dict(data: Mapping[str, Any]) -> LDPConfig:
    """Build a config from a nested mapping, defaults filling the gaps.

    Unknown sections or keys raise — a typo in a threshold name must not
    silently fall back to the default.
    """
    kwargs: dict[str, Any] = {}
    for section, values in data.items():
        if section not in _SECTIONS:
            raise ValueError(f"unknown LDP config section: {section}")
        cls = _SECTIONS[section]
        known = {f.name: f for f in dataclasses.fields(cls)}
        base = cls()
        merged: dict[str, Any] = {}
        for key, value in values.items():
            if key not in known:
                raise ValueError(f"unknown LDP config key: {section}.{key}")
            current = getattr(base, key)
            if isinstance(current, Mapping) and isinstance(value, Mapping):
                value = {**current, **value}
            elif isinstance(current, tuple) or key in ("ladder", "rung_fractions"):
                value = tuple(value) if value is not None else None
            merged[key] = value
        kwargs[section] = dataclasses.replace(base, **merged)
    return LDPConfig(**kwargs)


def load_config(path: str | Path | None = None) -> LDPConfig:
    if path is None:
        return LDPConfig()
    with open(path, "rb") as fh:
        return config_from_dict(tomllib.load(fh))
