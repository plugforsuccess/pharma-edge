"""Whale-tail backtest stub.

Replays Polygon's historical options-trades feed against the
qualification filter shared with the live scanner, then simulates
the bot's entry + 6-rule exit ladder against the trade-aggs of the
tailed contract.

This stub returns an empty trade list — the real implementation
ships once the API key is set + cache is primed.
"""

from __future__ import annotations

from datetime import date

from core.reporting import Trade


def run(start: date, end: date) -> list[Trade]:
    print(f'[whale_tail] backtest stub — range={start}..{end}')
    print('  TODO: implement once MASSIVE_API_KEY is set and cache is primed')
    return []
