"""Earnings IV crush backtest stub.

For each BMO earnings event in [start, end] in the configured universe:
  1. Open short IC ~15:30 ET the day before
  2. Close at the open (09:35 ET) the morning of announcement
  3. Realise P&L from credit collected minus closing debit
"""

from __future__ import annotations

from datetime import date

from core.reporting import Trade


def run(start: date, end: date) -> list[Trade]:
    print(f'[earnings_crush] backtest stub — range={start}..{end}')
    print('  TODO: implement once MASSIVE_API_KEY is set + earnings calendar primed')
    return []
