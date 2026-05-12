# massive-scanner

Long-running Fly.io Deno worker that polls Polygon (rebranded Massive)
options-trade feed, qualifies prints against each user's
`profiles.bot_config` filter, upserts rows into
`public.whale_tail_alerts`, and fires `bot-execute-entry` for prints
that pass the filter.

## Deploy

```bash
# First time — create the Fly app (uses fly.toml settings)
flyctl apps create cashmoves-scanner

# Set secrets (NEVER commit these to git)
flyctl secrets set --app cashmoves-scanner \
  MASSIVE_API_KEY=<paste-from-massive.com> \
  SUPABASE_URL=https://rghoynbaykeyjbhqmaff.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# Optional — restrict to specific users during paper-trade burn-in
flyctl secrets set --app cashmoves-scanner SCANNER_USER_IDS=<uuid1>,<uuid2>

# Deploy
flyctl deploy --app cashmoves-scanner
```

## How it scales

- One Fly machine, `shared-cpu-1x` / 512MB. CPU is near-zero outside
  RTH; CPU during RTH is mostly waiting on Polygon HTTP responses.
- Universe is ~50 tickers (see `src/universe.ts`). Each scan loop fetches
  one chain snapshot per ticker + N trade-list fetches for contracts with
  qualifying day volume. Polygon's Options Advanced tier is "unlimited"
  REST, so the rate ceiling is wall-clock, not quota.
- Loop interval: 5s during RTH, 60s off-hours.
- Deduplication: each consolidated print is keyed `<option_ticker>:<ts_ms>`
  and upserted via `ON CONFLICT (user_id, uw_trade_id) DO NOTHING`.

## How to test without live capital

The scanner writes `whale_tail_alerts` and triggers `bot-execute-entry`.
That function reads `profiles.bot_config.mode` — set `mode='paper'` and
the order routes to the sandbox account. Set `bot_config.dry_run=true`
to log alerts but skip the broker call entirely.
