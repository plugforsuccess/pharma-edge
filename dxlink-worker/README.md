# Cash Moves — DXLink Quote Worker

Long-running Deno process that maintains a single WebSocket connection
to Tastytrade's dxFeed (DXLink) gateway and streams real-time quotes,
greeks, and open interest for a curated universe of tickers into
`public.dxlink_quotes`. The `compute-gex` Supabase Edge Function reads
from that table to render the GEX heatmap on `/markets`.

## Why this exists

Tastytrade's REST `/market-data/*` endpoints return 502 on production —
real-time quotes only ride DXLink streaming. A persistent worker
subscribes once and feeds a price cache; the edge function answers
client requests with a single Postgres query (~50 ms) instead of
opening a new WS per request.

## Architecture

```
TRACKED_TICKERS (~15 tickers)
        │
        ▼
fetchNestedChain (REST)        ← strikes + OCC + streamer symbols
        │
        ▼
DxLinkClient (WebSocket)       ← bidirectional dxFeed stream
        │  Quote / Greeks / Summary frames
        ▼
shadow Map<symbol, QuoteRow>   ← in-memory merge of partial events
        │  flush every 750 ms
        ▼
public.dxlink_quotes (Supabase)
        ▲
        │  SELECT
        ▼
compute-gex Edge Function
        ▲
        │  POST /functions/v1/compute-gex
        ▼
/markets (React)
```

## Deploy to Fly.io

One-time:

```bash
# 1. Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
# 2. Sign in
fly auth login

# 3. From this directory:
cd dxlink-worker

# 4. Launch (creates the app — answer "no" to "deploy now")
fly launch --copy-config --no-deploy

# 5. Set secrets (use the same values as the Supabase edge function):
fly secrets set \
  TASTYTRADE_USERNAME=... \
  TASTYTRADE_PASSWORD=... \
  SUPABASE_URL=https://rghoynbaykeyjbhqmaff.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=...

# 6. Deploy
fly deploy
```

Subsequent deploys after code changes:

```bash
cd dxlink-worker
fly deploy
```

## Verify it's working

```bash
# Watch the live log
fly logs

# You should see lines like:
#   [main] tastytrade session OK
#   [main] streamer auth OK; url=wss://tasty-openapi-ws.dxfeed.com/realtime
#   [plan] SPY: spot=480.5 expirations=2 options=120
#   [main] sent 3000+ subscription specs
#   [store] symbols=3015 dirty=400 last_flush=400rows 2s ago

# Then check the DB directly:
#   SELECT count(*), count(*) FILTER (WHERE updated_at > now() - interval '1 minute')
#   FROM dxlink_quotes;
```

A healthy worker writes a few hundred rows per flush cycle during
market hours and zero between sessions (markets closed → no quote
updates). The flush log line should appear every 30s.

## Local development

```bash
cd dxlink-worker
cp .env.example .env  # then fill in
deno task dev
```

`--watch` re-runs on source changes. Note that running locally still
writes to your real `dxlink_quotes` table — there's no separate dev DB
unless you point `SUPABASE_URL` at a Supabase branch.

## Adding tickers

Edit `src/tickers.ts` `TRACKED_TICKERS` and redeploy. The chain plan
refreshes every 4h on the running instance, so new tickers will start
populating shortly after deploy without a full restart.

## Notes

- One shared-cpu-1x VM is enough for ~50 tickers worth of subscriptions
  (~10,000 streamer symbols total). Past that, scale to a 2x VM.
- The worker doesn't accept HTTP — Fly's health check is just "process
  running." If you want a `/health` endpoint, add a small server in
  `main.ts` and a `[[services]]` block to fly.toml.
- During market-closed hours dxFeed sends almost nothing. That's
  normal; the periodic `[store]` log line confirms the WS is still up.
