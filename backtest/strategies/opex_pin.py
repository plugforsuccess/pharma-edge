"""OPEX pin backtest stub.

For each OPEX day in [start, end]:
  1. For each ticker (SPY, QQQ, IWM, AAPL, ...) in Regime A
  2. Open short iron butterfly at the call wall + wings ±1.5% (index)
     or ±2.5% (single stock) at ~10:00 ET
  3. Close at 15:50 ET (forced EOD close)
  4. Realise P&L
"""

from __future__ import annotations

from datetime import date

from core.reporting import Trade


def run(start: date, end: date) -> list[Trade]:
    print(f'[opex_pin] backtest stub — range={start}..{end}')
    print('  TODO: implement once MASSIVE_API_KEY is set + OPEX dates seeded')
    return []
