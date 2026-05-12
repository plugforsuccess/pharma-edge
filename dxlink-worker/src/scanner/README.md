# Massive (Polygon) options-flow scanner

Second process in the `pharma-edge` Fly app — see
`dxlink-worker/fly.toml` `[processes].scanner`. Shares the app's Fly
secret bag with the dxlink-worker process (`SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, etc.) plus a Polygon API key.

## What it does

Polls Polygon (rebranded Massive) options-trade feed every 5s during
RTH, qualifies prints against each active user's
`profiles.bot_config` filter, upserts rows into
`public.whale_tail_alerts`, and fires `bot-execute-entry` for prints
that pass the filter.

## One-time setup

```bash
# Add the Massive API key to the existing pharma-edge Fly app.
# Supabase credentials are already on this app — don't re-paste them.
flyctl secrets set --app pharma-edge \
  MASSIVE_API_KEY=<paste-from-massive.com>

# Optional — restrict to specific users during paper-trade burn-in
flyctl secrets set --app pharma-edge SCANNER_USER_IDS=<uuid1>,<uuid2>

# Trigger a deploy so the new "scanner" process picks up the secret
flyctl deploy --app pharma-edge --config dxlink-worker/fly.toml
```

## How it scales

- One Fly machine for the scanner process, `shared-cpu-1x` / 1GB
  (matches the worker; scanner only needs ~200MB).
- CPU is near-zero outside RTH; CPU during RTH is mostly waiting on
  Polygon HTTP responses.
- Universe is ~50 tickers (see `universe.ts`). Each scan loop fetches
  one chain snapshot per ticker + N trade-list fetches for contracts
  with qualifying day volume. Polygon's Options Advanced tier is
  "unlimited" REST, so the rate ceiling is wall-clock, not quota.
- Loop interval: 5s during RTH, 60s off-hours.
- Deduplication: each consolidated print is keyed
  `<option_ticker>:<ts_ms>` and upserted via
  `ON CONFLICT (user_id, uw_trade_id) DO NOTHING`.

## How to test without live capital

The scanner writes `whale_tail_alerts` and triggers `bot-execute-entry`.
That function reads `profiles.bot_config.mode` — set `mode='paper'` and
the order routes to the sandbox account. Set `bot_config.dry_run=true`
to log alerts but skip the broker call entirely.

## Files

- `main.ts`     — scan loop + market-hours gate + per-user qualify
- `scanner.ts`  — per-underlying chain fetch + trade consolidation
- `polygon.ts`  — Polygon REST client + OCC ticker parser
- `filter.ts`   — qualification rules (mirrors `botRiskEval.js`)
- `supabase.ts` — service-role client + idempotent upserts
- `universe.ts` — curated ticker list
