"""Backtest result reporting.

Given a list of `Trade` outcomes with realised P&L, compute:
  - win rate
  - mean / median win / loss
  - expectancy per trade
  - max drawdown (% of running capital)
  - per-month P&L
  - sharpe-like ratio (mean / stdev of daily P&L)

Light-touch — no plotting libraries. CSV output for downstream analysis.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from statistics import mean, stdev


@dataclass
class Trade:
    strategy: str
    ticker: str
    entry_date: date
    exit_date: date
    realised_pnl: float          # net of commissions
    max_risk: float              # max loss at entry
    contracts: int


def aggregate(trades: list[Trade]) -> dict[str, float]:
    if not trades:
        return {'n': 0}
    wins = [t for t in trades if t.realised_pnl > 0]
    losses = [t for t in trades if t.realised_pnl <= 0]
    win_rate = len(wins) / len(trades)
    mean_win = mean(t.realised_pnl for t in wins) if wins else 0.0
    mean_loss = mean(t.realised_pnl for t in losses) if losses else 0.0
    expectancy = win_rate * mean_win + (1 - win_rate) * mean_loss
    rr = abs(mean_win / mean_loss) if mean_loss < 0 else 0.0

    # Max drawdown
    running = 0.0
    peak = 0.0
    max_dd = 0.0
    for t in sorted(trades, key=lambda x: x.exit_date):
        running += t.realised_pnl
        peak = max(peak, running)
        max_dd = min(max_dd, running - peak)

    # Daily P&L stdev for sharpe-like
    by_day: dict[date, float] = {}
    for t in trades:
        by_day[t.exit_date] = by_day.get(t.exit_date, 0.0) + t.realised_pnl
    daily = list(by_day.values())
    sigma = stdev(daily) if len(daily) > 1 else 0.0
    sharpe_like = (mean(daily) / sigma) * (252 ** 0.5) if sigma > 0 else 0.0

    return {
        'n': len(trades),
        'win_rate': win_rate,
        'mean_win': mean_win,
        'mean_loss': mean_loss,
        'expectancy_per_trade': expectancy,
        'reward_risk_ratio': rr,
        'total_pnl': sum(t.realised_pnl for t in trades),
        'max_drawdown': max_dd,
        'sharpe_like': sharpe_like,
    }


def print_report(strategy: str, trades: list[Trade]) -> None:
    agg = aggregate(trades)
    print(f'\n===== {strategy} =====')
    if not trades:
        print('  No trades.')
        return
    print(f'  trades:     {agg["n"]}')
    print(f'  win rate:   {agg["win_rate"]:.1%}')
    print(f'  mean win:   ${agg["mean_win"]:,.0f}')
    print(f'  mean loss:  ${agg["mean_loss"]:,.0f}')
    print(f'  expectancy: ${agg["expectancy_per_trade"]:,.0f} / trade')
    print(f'  R/R:        {agg["reward_risk_ratio"]:.2f}')
    print(f'  total P&L:  ${agg["total_pnl"]:,.0f}')
    print(f'  max DD:     ${agg["max_drawdown"]:,.0f}')
    print(f'  sharpe-like: {agg["sharpe_like"]:.2f}')
