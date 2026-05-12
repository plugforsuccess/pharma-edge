"""IV mean-reversion backtest stub.

For each trading day in [start, end]:
  1. For each ticker in the IV mean-rev universe (SPY, QQQ, AAPL, ...)
  2. Compute 30-day IV percentile from 60d trailing chain history
  3. If IV %ile >= 80 + regime estimated A: open short IC at body
     ±body% / wings ±wing%
  4. Walk forward day-by-day, applying exits: profit_take_50,
     stop_2x, time_stop_7dte
  5. Realise P&L; emit Trade
"""

from __future__ import annotations

from datetime import date

from core.reporting import Trade


def run(start: date, end: date) -> list[Trade]:
    print(f'[iv_meanrev] backtest stub — range={start}..{end}')
    print('  TODO: implement once MASSIVE_API_KEY is set')
    return []
