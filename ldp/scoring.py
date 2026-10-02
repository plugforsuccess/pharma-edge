"""Core scoring — sector-ETF ranking for the core sleeve.

Each sector ETF is scored on trailing returns and relative strength vs
the benchmark, weighted by ``core.weights``. Metrics are min-max
normalised across the candidate set so the weights compare like with
like. The top ``core.top_n_sectors`` are the top tier: bought at the
annual buy, and held through the annual review (sell rule 5 rotates the
rest).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .config import CoreConfig


@dataclass(frozen=True)
class SectorMetrics:
    ticker: str
    ret_3m: float
    ret_6m: float
    ret_12m: float
    rel_strength: float        # 12m return minus benchmark 12m return
    above_200dma: bool


@dataclass(frozen=True)
class SectorScore:
    ticker: str
    score: float
    components: dict
    eligible: bool
    rank: int


def score_sectors(metrics: Sequence[SectorMetrics], cfg: CoreConfig) -> list[SectorScore]:
    if not metrics:
        return []
    keys = list(cfg.weights)
    lo = {k: min(getattr(m, k) for m in metrics) for k in keys}
    hi = {k: max(getattr(m, k) for m in metrics) for k in keys}
    total_w = sum(cfg.weights.values())

    scored = []
    for m in metrics:
        comps = {k: (0.5 if hi[k] == lo[k] else (getattr(m, k) - lo[k]) / (hi[k] - lo[k])) for k in keys}
        s = sum(comps[k] * cfg.weights[k] for k in keys) / total_w
        eligible = m.above_200dma or not cfg.require_above_200dma
        scored.append((m.ticker, round(s, 6), {k: round(v, 6) for k, v in comps.items()}, eligible))
    scored.sort(key=lambda t: (not t[3], -t[1], t[0]))
    return [SectorScore(t, s, c, e, i + 1) for i, (t, s, c, e) in enumerate(scored)]


def top_tier(scores: Sequence[SectorScore], cfg: CoreConfig) -> list[SectorScore]:
    return [s for s in scores if s.eligible][: cfg.top_n_sectors]
