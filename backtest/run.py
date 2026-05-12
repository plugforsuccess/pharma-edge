"""Backtest harness CLI.

Usage:
  python run.py whale_tail   2024-01-01 2025-12-31
  python run.py iv_meanrev   2024-01-01 2025-12-31
  python run.py earnings_crush 2024-01-01 2025-12-31
  python run.py opex_pin     2024-01-01 2025-12-31

Outputs:
  - Console report (win rate, R/R, max DD, total P&L)
  - CSV with per-trade detail to backtest/output/<strategy>_<start>_<end>.csv

Strategy modules implement run(start, end) -> list[Trade]. They share
the polygon_history client and fill model in core/.

This is a scaffold. Strategies currently emit stub trades for plumbing
validation. Real strategy logic lives in backtest/strategies/<name>.py
once the API key is set + Polygon historical pulls are exercised.
"""

from __future__ import annotations

import argparse
import csv
import importlib
import sys
from datetime import date
from pathlib import Path

from core.reporting import print_report

OUTPUT = Path(__file__).parent / 'output'
OUTPUT.mkdir(parents=True, exist_ok=True)


def parse_date(s: str) -> date:
    return date.fromisoformat(s)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('strategy', choices=['whale_tail', 'iv_meanrev', 'earnings_crush', 'opex_pin'])
    ap.add_argument('start', type=parse_date)
    ap.add_argument('end',   type=parse_date)
    args = ap.parse_args()

    try:
        mod = importlib.import_module(f'strategies.{args.strategy}')
    except ImportError as e:
        print(f'Strategy module not implemented: {e}', file=sys.stderr)
        return 2

    trades = mod.run(args.start, args.end)
    print_report(args.strategy, trades)

    out_path = OUTPUT / f'{args.strategy}_{args.start}_{args.end}.csv'
    with out_path.open('w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['strategy', 'ticker', 'entry_date', 'exit_date', 'pnl', 'max_risk', 'contracts'])
        for t in trades:
            w.writerow([t.strategy, t.ticker, t.entry_date, t.exit_date, t.realised_pnl, t.max_risk, t.contracts])
    print(f'\n  wrote {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
