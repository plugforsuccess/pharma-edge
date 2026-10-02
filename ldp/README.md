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
| `ladder` | Exit playbook ladder (pre-tax targets + runner), with after-tax proceeds per sale |
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

## Exit playbook (owner, 2026-10-02)

Every LEAPS is risk capital that can go to zero, so there is **no hard
price stop**. Positions are cut only when the thesis breaks.

| Step | Default | Config |
|---|---|---|
| Target 1 | **+100%** on the option → sell **70%** of the contracts (cost back plus profit; the rest is free) | `exits.ladder[0]`, `rung_fractions[0]` |
| Target 2 | **+200%** → sell **15%** (half of what's left) | `exits.ladder[1]`, `rung_fractions[1]` |
| Runner | last **15%** trails: exit on a **30%** give-back from its peak mark | `exits.runner_trail_pct` |
| Time stop | roll window opens at **9 months** left; exit or roll at **6 months** | `exits.roll_warn_dte_days`, `roll_dte_days` |
| Taxes | after the plan: wait for long-term only if it's ≤ 60 days away **and** lands before the roll window opens | `exits.ltcg_wait_days` |
| Entry | 18–24+ months to expiry so the 1-year date and the time stop don't collide | `contracts.min_dte_days` / `target_dte_days` |
| Automation | when a buy fills, rest a **GTC limit sell** for Target 1's contracts at +100% (price rounded up to the tick) | `orders.place_target_order_on_entry`, `target_order_duration` |

Targets are pre-tax gains on the option; each rung still records the
estimated tax and after-tax proceeds of its sale. Contracts are split by
largest remainder across the targets and the runner, with ties going to
selling. `exits.stop_loss_pct` can opt a hard price stop back in.

The engine needs two per-position fields from whatever loads positions:
`peak_mark` (highest mark since entry, for the runner trail) and
`rungs_resting` (rungs with a working broker order, so the daily check
doesn't double-sell the GTC Target 1).

## Sell rules (first match wins)

1. Broken thesis (failed trial, dilution, broken business) or a satellite hard-reject condition → sell now
2. Under 180 DTE → roll to a passing contract; none → sell
3. All targets filled and the runner is 30% off its peak → sell the runner
4. Profit target hit → sell that rung, unless the tax wait fits (short-term, thesis intact, long-term ≤ 60 days away and before the roll window) → hold for long-term
5. Core sector out of the top tier at the annual review → rotate

Under 270 DTE, a plain hold is flagged as being in the roll window.

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
