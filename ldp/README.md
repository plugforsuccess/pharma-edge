# LDP — LEAPS Diversified Portfolio engine

Long-dated, low-maintenance LEAPS on sector ETFs (core) plus risk-gated
small-cap satellites, executed through Tradier.

- **Risk tolerance decides what the bot may buy.**
- **The user's tax rate decides when it sells.**
- **Risk always beats tax.** A broken position is never held to reach long-term rates.

Every threshold is in `ldp/config.py` (overridable with a TOML file; see
`defaults/ldp.default.toml`). Tax figures are per-year data in
`tax_year_config` / `state_tax_rates`. `ldp/data/tax_<year>.json` is an
offline snapshot regenerated from the migration with
`python -m ldp.tools.export_tax_seed`, and a test fails if it drifts.

## Modules

| Module | Responsibility |
|---|---|
| `risk` | Risk tier from onboarding answers (lowest cap wins); per-sleeve permission (auto / suggest / blocked); managed-account compliance gate; UI copy |
| `scoring` | Core sector-ETF ranking → top tier |
| `satellite` | Research-tool candidates (thesis + sources), small-cap signals, hard rejects (runway, catalyst blackout) |
| `contracts` | Hard-reject contract filters (DTE, delta band, IV rank, spread, OI) and selection |
| `sizing` | Satellite per-name / total caps, shrink-to-fit, skip under one contract; core budget |
| `allocator` | Annual buy / re-entry plan |
| `tax` | Incremental tax `T(income+gain) − T(income)`, LT stacked on ordinary, NIIT above threshold, state effective rates, §1256 60/40, overrides, holding period |
| `ladder` | After-tax exit ladder, solved at the rate if sold today |
| `rules` | Daily sell rules in priority order |
| `orders` | Limit-only execution: mid → ask in steps, cancel after N |
| `engine` | Orchestration: buys, daily checks, execute vs suggest, audit |
| `audit` | Append-only records (memory / JSONL / Supabase `ldp_audit_log`) |
| `store` | Persists risk profiles to `ldp_risk_profiles` |
| `backtester` | Replays daily marks through the sell rules |
| `brokers` | `TradierBroker` (sandbox default; `TRADIER_ENV=live` for live) and `DryRunBroker` |

## Cadence

- **Buys:** once a year per user inside their buy window (default Jan 15 + 21 days), plus re-entry after a sell.
- **Sell checks:** daily, every open position.
- **Idle cash** stays in the sweep. The engine never trades it.

## Who can auto-trade

| Tier | Core | Satellites |
|---|---|---|
| Conservative | auto | never traded or suggested |
| Moderate | auto | suggestion, user approves each |
| Aggressive | auto | auto, within 5% per name / 15% total |

Auto-trading also requires `account.tier == "managed"`. Self-directed
accounts get suggestions only, whatever the tier. The DB enforces this:
`ldp_audit_log` rejects a `trade` row unless it is `auto` on a managed
account.

## Sell rules (first match wins)

1. Price stop (−50% from entry), broken thesis, or a satellite hard-reject condition → sell now
2. Under 180 DTE → roll to a passing contract; none → sell
3. After-tax profit rung hit at today's rate → sell that rung
4. Short-term, in profit, thesis intact, ≤ 60 days to long-term → hold (shows days and tax saved)
5. Core sector out of the top tier at the annual review → rotate

## Running tests

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r ldp/requirements-dev.txt
python -m pytest -q ldp
```

## Environment

| Variable | Use |
|---|---|
| `TRADIER_ACCESS_TOKEN` | Tradier API token. Never logged. |
| `TRADIER_ENV` | `sandbox` (default) or `live` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Audit log + risk profiles. Server-side only. |

Tax figures are estimates. Actual taxes depend on the user's full tax
situation, and they should consult a tax professional.
