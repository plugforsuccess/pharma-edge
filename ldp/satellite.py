"""Satellite engine — small-cap discovery, signals, hard rejects.

Sector-ETF scoring won't surface names like RXRX, so satellites come
from a separate pipeline:

  1. Discovery: the agentic research tool emits candidates per theme,
     each with a written thesis and source links. The thesis is stored
     with the candidate (and in every audit record that cites it).
  2. Small-cap signals, each normalised to 0..1, weighted by
     ``satellite.weights``.
  3. Hard rejects: cash runway under ``min_runway_months``, or a known
     binary event within ``catalyst_blackout_days`` of the planned buy
     (unless the user explicitly allows catalyst plays).
  4. Survivors go through the same contract filters as core.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from typing import Mapping, Sequence

from .config import SatelliteConfig


@dataclass(frozen=True)
class Catalyst:
    kind: str                 # trial_readout | fda_date | earnings | other
    on: date
    binary: bool              # can the stock gap on the outcome?
    description: str = ""


@dataclass(frozen=True)
class Offering:
    on: date
    kind: str                 # follow_on | atm | pipe | convertible


@dataclass(frozen=True)
class SatelliteCandidate:
    ticker: str
    theme: str
    thesis: str
    sources: tuple[str, ...]
    cash: float                       # latest reported cash + equivalents
    quarterly_burn: float             # operating cash burn per quarter (> 0 = burning)
    catalysts: tuple[Catalyst, ...] = ()
    offerings: tuple[Offering, ...] = ()
    active_shelf: bool = False
    institutional_change_pct: float | None = None   # QoQ change in institutional ownership, %
    short_interest_pct: float | None = None         # % of float
    momentum_pct: float | None = None               # trailing 6-month price return, %

    def to_record(self) -> dict:
        return {
            "ticker": self.ticker,
            "theme": self.theme,
            "thesis": self.thesis,
            "sources": list(self.sources),
        }


def runway_months(cash: float, quarterly_burn: float) -> float:
    """cash ÷ quarterly burn × 3. Not burning cash → unlimited runway."""
    if quarterly_burn <= 0:
        return math.inf
    return cash / quarterly_burn * 3


def binary_events_in_blackout(c: SatelliteCandidate, on: date, cfg: SatelliteConfig) -> list[Catalyst]:
    return [k for k in c.catalysts if k.binary and 0 <= (k.on - on).days <= cfg.catalyst_blackout_days]


def hard_rejects(
    c: SatelliteCandidate, planned_buy: date, cfg: SatelliteConfig, *, allow_catalyst_plays: bool = False,
) -> list[str]:
    out: list[str] = []
    if not c.thesis.strip():
        out.append("missing thesis")
    if not c.sources:
        out.append("missing source links")
    rw = runway_months(c.cash, c.quarterly_burn)
    if rw < cfg.min_runway_months:
        out.append(f"cash runway {rw:.1f} mo < {cfg.min_runway_months:g} mo")
    if not allow_catalyst_plays:
        for k in binary_events_in_blackout(c, planned_buy, cfg):
            out.append(f"binary {k.kind} on {k.on.isoformat()} within {cfg.catalyst_blackout_days}d blackout")
    return out


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def signal_scores(c: SatelliteCandidate, on: date, cfg: SatelliteConfig) -> dict[str, float]:
    """Each signal mapped to 0..1 (higher = better). Missing data → 0.5
    (neutral) so an unknown never helps or hurts more than a known."""
    rw = runway_months(c.cash, c.quarterly_burn)
    runway = 1.0 if math.isinf(rw) else _clamp01(rw / cfg.runway_full_score_months)

    upcoming = [k for k in c.catalysts
                if cfg.catalyst_blackout_days < (k.on - on).days <= cfg.catalyst_lookahead_days]
    catalysts = _clamp01(len(upcoming) / 2)   # one dated catalyst = 0.5, two or more = 1

    recent = [o for o in c.offerings if 0 <= (on - o.on).days <= cfg.dilution_lookback_days]
    dilution = _clamp01(1 - cfg.dilution_penalty_per_offering * len(recent)
                        - (cfg.dilution_penalty_shelf if c.active_shelf else 0))

    def ranged(v: float | None, span: float) -> float:
        return 0.5 if v is None else _clamp01((v + span) / (2 * span))

    institutional = ranged(c.institutional_change_pct, cfg.institutional_change_range_pct)
    momentum = ranged(c.momentum_pct, cfg.momentum_range_pct)
    short_interest = 0.5 if c.short_interest_pct is None else _clamp01(1 - c.short_interest_pct / cfg.max_short_interest_pct)

    return {
        "runway": runway,
        "catalysts": catalysts,
        "dilution": dilution,
        "institutional": institutional,
        "short_interest": short_interest,
        "momentum": momentum,
    }


def score(c: SatelliteCandidate, on: date, cfg: SatelliteConfig) -> tuple[float, dict[str, float]]:
    parts = signal_scores(c, on, cfg)
    weights: Mapping[str, float] = cfg.weights
    total_w = sum(weights.values())
    if total_w <= 0:
        raise ValueError("satellite weights must sum to > 0")
    s = sum(parts[k] * w for k, w in weights.items()) / total_w
    return round(s, 6), {k: round(v, 6) for k, v in parts.items()}


@dataclass(frozen=True)
class SatelliteEvaluation:
    candidate: SatelliteCandidate
    passed: bool
    rejects: tuple[str, ...]
    score: float
    components: dict = field(default_factory=dict)
    runway_months: float = 0.0


def evaluate(
    c: SatelliteCandidate, planned_buy: date, cfg: SatelliteConfig, *, allow_catalyst_plays: bool = False,
) -> SatelliteEvaluation:
    rejects = hard_rejects(c, planned_buy, cfg, allow_catalyst_plays=allow_catalyst_plays)
    s, parts = score(c, planned_buy, cfg)
    if not rejects and s < cfg.min_score:
        rejects.append(f"score {s:.2f} < {cfg.min_score:.2f}")
    return SatelliteEvaluation(c, not rejects, tuple(rejects), s, parts, runway_months(c.cash, c.quarterly_burn))


# ── Discovery input ────────────────────────────────────────────────

def parse_research_output(payload: Mapping) -> list[SatelliteCandidate]:
    """Parse the research tool's output:

    {"themes": [{"theme": "AI drug discovery", "candidates": [
        {"ticker": "RXRX", "thesis": "...", "sources": ["https://..."],
         "fundamentals": {"cash": ..., "quarterly_burn": ...},
         "catalysts": [{"kind": "trial_readout", "date": "2027-03-01", "binary": true}],
         "offerings": [{"date": "2026-06-01", "kind": "follow_on"}],
         "active_shelf": true, "institutional_change_pct": 4.2,
         "short_interest_pct": 12.5, "momentum_pct": 18.0}]}]}
    """
    out: list[SatelliteCandidate] = []
    for theme in payload.get("themes", []):
        for raw in theme.get("candidates", []):
            f = raw.get("fundamentals", {})
            out.append(SatelliteCandidate(
                ticker=str(raw["ticker"]).upper(),
                theme=str(theme.get("theme", "")),
                thesis=str(raw.get("thesis", "")),
                sources=tuple(raw.get("sources", [])),
                cash=float(f.get("cash", 0)),
                quarterly_burn=float(f.get("quarterly_burn", 0)),
                catalysts=tuple(
                    Catalyst(k.get("kind", "other"), date.fromisoformat(k["date"]), bool(k.get("binary", False)),
                             k.get("description", ""))
                    for k in raw.get("catalysts", [])
                ),
                offerings=tuple(Offering(date.fromisoformat(o["date"]), o.get("kind", "follow_on"))
                                for o in raw.get("offerings", [])),
                active_shelf=bool(raw.get("active_shelf", False)),
                institutional_change_pct=raw.get("institutional_change_pct"),
                short_interest_pct=raw.get("short_interest_pct"),
                momentum_pct=raw.get("momentum_pct"),
            ))
    return out


def rank(evals: Sequence[SatelliteEvaluation]) -> list[SatelliteEvaluation]:
    return sorted((e for e in evals if e.passed), key=lambda e: e.score, reverse=True)
