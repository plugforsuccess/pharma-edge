# Cash Moves backtest harness

Validates each strategy (`whale_tail`, `iv_meanrev`, `earnings_crush`,
`opex_pin`) against historical Polygon options data BEFORE we put
real capital behind it.

The harness is the gate. Calendar-week staging in paper-trading costs
compounding; a backtest that survives a 2-year window with realistic
fills + slippage + commissions is a stronger signal that the strategy
generalises than 90 days of paper trades on whatever IV regime happens
to be in season.

## Layout

```
backtest/
├── README.md
├── requirements.txt
├── core/
│   ├── polygon_history.py     # Pulls options chain history (paid endpoint)
│   ├── fills.py               # Realistic fill model: bid/mid/ask + slippage
│   ├── pnl.py                 # P&L attribution per closed trade
│   └── reporting.py           # Win-rate, R/R, drawdown, Sharpe-like metrics
├── strategies/
│   ├── whale_tail.py
│   ├── iv_meanrev.py
│   ├── earnings_crush.py
│   └── opex_pin.py
└── run.py                     # CLI: `python run.py whale_tail 2024-01-01 2025-12-31`
```

## Cost discipline

Polygon historical options data costs API quota. The harness caches
every chain response to disk (`backtest/cache/<date>/<ticker>.json`),
so an iteration on the strategy code re-runs from cache, not from the
network.

## Workflow

1. **Build the strategy module** (`strategies/<name>.py`) — emits a
   stream of `Trade(side, structure, strikes, expiry, contracts)`
   tuples given a date + universe.
2. **Run the backtest**: `python run.py <name> <start> <end>`
3. **Read the report**:
   - Per-month P&L
   - Win rate / R/R / max DD
   - Distribution of trade outcomes
   - Equity curve PNG
4. **Iterate** until the strategy clears the bar (R/R ≥ 1.5, win rate
   ≥ 60%, max DD < 25% of capital, > 100 trades in the window).
5. **Ship to paper** with the same filter parameters the backtest used.

## What the harness will NOT model

- **Real-time fills** — the model assumes mid + N% slippage. Live
  conditions are stickier.
- **Realtime exit triggers** — only exit conditions a backtest can see
  (close-debit ≥ 2× entry credit, etc.) are modelled. The trailing-stop
  + thesis-invalidation triggers used live are out of scope here.
- **Borrow / margin calls** — these don't apply to defined-risk
  spreads, which is the entire bot universe.

## Status

Scaffold only. The Polygon client + a smoke-test runner are in this
PR; the strategy implementations are stubs that exercise the harness
plumbing. Real backtest runs come once the API key is set.
