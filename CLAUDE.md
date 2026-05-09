# CLAUDE.md — Cash Moves

> Onboarding document for any AI agent or developer touching this repo.
> Read this before changing code. Decisions in here were made deliberately.
>
> **Brand history:** the project started as **Pharma Edge** (biotech catalysts),
> rebranded to **Wiley Edge**, and now ships as **Cash Moves** (cashmoves.io)
> focused on GEX, options flow, and dealer positioning. The repo directory,
> GitHub repo (`plugforsuccess/pharma-edge`), Fly.io app (`pharma-edge`),
> and Supabase ref (`rghoynbaykeyjbhqmaff`) keep their original names — those
> are infrastructure identifiers, not customer-facing, and renaming would
> orphan production. **The product name is "Cash Moves" everywhere
> user-visible. Never expose old names in UI, emails, push subjects, OG
> tags, or shareable copy.**
>
> Naming conventions to apply consistently:
>   * Main dashboard → "The Tape"
>   * Individual alert / signal → "A Move" (plural "Moves")
>   * Watchlist → "Tracking"
>   * Premium tier → "Cash Moves Pro"
>   * Top tier → "Inner Circle"
>   * GEX dashboard → "HeatPulse™"
>   * Zero-gamma level → "The Flip"
>   * Largest dealer position → "The Wall"
>
> The DB table `signals` and column names are **not** renamed — the
> immutability/hash trigger contract depends on them. Apply the
> naming conventions to UI strings only.

---

## Status

**The biotech-catalyst pipeline was fully retired on 2026-05-09.** The app
is now GEX/options-flow only. The legacy 90-day paper-trading wall was
sunset on 2026-05-09 (`signals.trade_type` is still tracked per signal so
TrackRecord can filter, but the wall is no longer enforced).

**Database (`rghoynbaykeyjbhqmaff`):** Core: `profiles`, `watchlist`,
`signals`, `outcomes`, `scanner_runs`, `alerts`, `claude_calls`,
`push_subscriptions`, `order_history`, `tastytrade_sessions`,
`gex_snapshots`, `dxlink_quotes`. Retained but no longer written:
`scanner_candidates`, `candidate_drafts` (legacy biotech queue +
autosave; kept so historical RLS + foreign keys still resolve, with no
new rows post-sunset). View: `public_record`. `gex_snapshots` is the
5-minute response cache for `compute-gex` (shared across users — market
data, not user data; authenticated SELECT, service-role write only).
`dxlink_quotes` is the live price cache populated by the `dxlink-worker`
Fly.io service: per-symbol bid/ask/mid/iv/gamma/delta/theta/vega/open_interest/day_volume/prev_close,
upserted on every dxFeed frame; authenticated SELECT, service-role write
only. RLS on all tables, immutability + server-side hash triggers on
`signals`/`outcomes`. `outcomes` is 1:1 with `signals` (UNIQUE).
`claude_calls` is the per-user rate-limit + cost ledger (write-once via
service role; SELECT own + admin SELECT all). `push_subscriptions` stores
the user's PushSubscription tuples. `order_history` is the broker-order
audit log — SELECT-own for authenticated, INSERT/UPDATE/DELETE
service-role only. `tastytrade_sessions` is a singleton (`id=1`) caching
the broker session token; service-role only. The hash triggers compute
SHA-256 over a manually-built JSON payload (`to_json` per value, no
whitespace) so JS `JSON.stringify` of the same data is byte-identical
and verification is real. Admin-only views (`admin_cost_daily`) gate on
`profiles.is_admin`.

**Frontend:** Vite + React + Tailwind v4 PWA. Pages: `Login`, `Dashboard`
("The Tape" — GEX strip + Suggested Plays + Open Positions + watch-only
moves), `SignalDetail` (`maybeSingle`, formatted market cap, hash badge,
`LogOutcomeModal` + `StopLossCheck` + `StrikePriceCalculator` wired in;
legacy biotech rows render their drug/indication/catalyst-type fields
conditionally on `signal_source='biotech_catalyst'`), `LogSignal` (4-step
GEX-only flow: Trade Setup → Strike & Thesis → Pre-trade Checklist →
Confirm), `Calendar`, `TrackRecord`, `Rules`, `Settings` (display name,
slug, public toggle, risk fields, watchlist, sign-out), `OptionCalculator`
(standalone calculator at `/calculator`), `PublicRecord` (no-auth
`/r/:slug`), `Markets` (HeatPulse + Suggested Plays), `Flow`,
`Reasoning` (regime/confidence drift), `Glossary`, `LearnIndex` + 5 learn
articles, `Admin` (owner-only — gated by `profiles.is_admin`).
Components: `LogOutcomeModal`, `StopLossCheck`, `StrikePriceCalculator`
(40% premium cap, spreads only — no naked options, position size from
2% rule), `SuggestedPlays`, `MarketPulse`, `OpenPositions`,
`NotificationCenter`, `InstallPrompt`, `ErrorBoundary`. Hook:
`useDteMonitor` runs once per day per session, idempotent on
`alerts(signal_id, alert_type='stop_loss_triggered', sent_at::date)`,
fires when DTE < 21 on active real-money signals. Lazy loading: most
non-critical pages are code-split, with `Suspense` wrapping the layout
`<Outlet />`. Plus env-var guard in `supabase.js`, SHA-256 verifier
(`utils/hash.js`) matching the DB triggers, timezone-safe `daysUntil`
helper, service worker (production-only registration), iOS safe-area
handling.

**Hash anchoring:** Two scripts in `scraper/` driven by
`.github/workflows/anchor-signals.yml` on `0 12:30 * * *` cron (= 7:30am
ET standard, 8:30am ET DST). `anchor_signals.py` reads the canonical
`signal_hash` (DB-trigger computed) from any signal where
`github_commit_sha IS NULL`, writes a `<YYYY-MM-DD>.json` file into the
public-record repo, and persists the anchored signal IDs to
`_anchored_ids.json`. The workflow then commits + pushes the public-record
repo, captures `git rev-parse HEAD`, and runs `update_anchor_shas.py`
which UPDATEs `signals.github_commit_sha` + `hash_anchored_at`.
**Prerequisites:** create a public GitHub repo (e.g.
`plugforsuccess/pharma-edge-public-record`); add a `GH_PAT` secret with
write access to that repo only; set the `PUBLIC_RECORD_REPO` Actions
variable to its full name; set `VITE_PUBLIC_RECORD_REPO` in Vercel env.

**Edge functions:**
- `suggest-plays` v33+ (`verify_jwt=true`). Given a ticker, fetches the
  live GEX matrix from `compute-gex` and asks Claude Sonnet 4.6 to
  propose 0–5 spread trade ideas that fit the GEX playbook (regime A/B,
  walls, flip, secondary Greeks DEX/VEX/CEX) AND the Cash Moves rules
  (R/R ≥ 1:1.5, 2% sizing, 21+ DTE except pin trades, max 40%
  debit-of-width, no naked options). Server-filters every play that
  doesn't clear R/R ≥ 1.5 + EV edge ≥ 0. Per-user rate limit via
  `claude_calls` (30/hr default, configurable via
  `CLAUDE_RATE_LIMIT_PER_HOUR`). 5-min response cache via
  `play_suggestions` table. Logs token attribution + cost to
  `claude_calls`. **Requires `ANTHROPIC_API_KEY`.**
- `send-alerts` v2 (`verify_jwt=true`, **service-role-only**). Decodes
  the JWT and rejects anything that isn't `role: service_role`. Handles
  `catalyst_approaching_14d` / `catalyst_approaching_7d` /
  `catalyst_tomorrow` / `outcome_reminder`. Sends Resend email AND fans
  out web-push to every active row in `push_subscriptions` for the
  target user (404/410 subs auto-pruned). Push failures don't fail the
  request. **Requires `RESEND_API_KEY`, `APP_URL`** + (for push)
  `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Push is
  skipped silently when VAPID keys are unset.
- `place-order` v1 (`verify_jwt=true`). Submits a multi-leg debit limit
  order to Tastytrade. Derives `user_id` from the verified JWT (never
  trusts request body), validates that the signal is the user's and
  still active, refuses a second OPEN order while one is in flight
  (`409`), builds OCC option symbols, posts to
  `/accounts/:n/orders`, logs to `order_history` via service role, and
  reflects status onto the signal. **Auth: OAuth2 refresh-token grant**
  — requires `TASTYTRADE_CLIENT_ID`, `TASTYTRADE_CLIENT_SECRET`,
  `TASTYTRADE_REFRESH_TOKEN`. Sandbox base URL defaults to
  `api.cert.tastyworks.com`; override with `TASTYTRADE_BASE_URL` for
  prod.
- `get-account` v4 (`verify_jwt=true`). Lists Tastytrade accounts the
  bot has access to with balances. Treats every account on the cert
  (sandbox) base URL as paper for UX-warning purposes.
- `compute-gex` v6+ (`verify_jwt=true`). Returns Gamma Exposure (GEX) by
  strike for a single ticker so `/markets` can render the heatmap.
  **Primary: `dxlink_quotes`** (real-time from the dxlink-worker).
  **Fallback: Yahoo `/v7/finance/options/{symbol}`** (15-min delayed,
  Black-Scholes gamma in-edge) — used when the worker hasn't subscribed
  to the requested ticker, the rows are >30s stale, or DXLink is down.
  Response includes `source: 'dxlink' | 'yahoo'` so the UI can label
  freshness. 5-minute snapshot cache via `gex_snapshots`; `refresh:true`
  bypasses. Yahoo path uses cookie+crumb auth.
- `monitor-positions` v1+ (`verify_jwt=true`). Polls Tastytrade
  `/accounts/:n/orders` for active orders and reconciles fill status
  onto `order_history`. Triggered by
  `.github/workflows/monitor-positions.yml`.

**Retired (2026-05-09):**
- `analyze-signal` — biotech filing analysis. Source deleted; deployed
  function returns 410 Gone for any stale client.
- `fetch-filings` — SEC/CT.gov/FDA bundle fetcher used only by
  AnalyzeFilingPanel. Source deleted; deployed function returns 410 Gone.

Both are still listed in the Supabase dashboard but unreachable from
the frontend. Delete them via dashboard whenever convenient.

**DXLink streaming worker (`dxlink-worker/`):** Long-running Deno process
on Fly.io. OAuth refresh-token grant to mint a Tastytrade access_token,
exchanges it for a DXLink streamer token via `/api-quote-tokens`, opens
one WebSocket to `tasty-openapi-ws.dxfeed.com/realtime`, subscribes to:
equity `Quote` for ~15 curated tickers, and per-option `Quote` + `Greeks`
+ `Summary` for the front 2 expirations within ATM ± 25%. Every event
lands in an in-memory shadow Map keyed by streamer symbol; a 750ms flush
loop upserts dirty rows into `public.dxlink_quotes`. Reconnects with
exponential backoff (max 60s), refreshes the streamer token at ~22h,
refreshes the chain plan every 4h. Memory ~150MB, CPU near-zero outside
market hours. **Deploy:** see `dxlink-worker/README.md`. The worker MUST
run on Tastytrade production base URL (`api.tastyworks.com`) — sandbox
DXLink delivers mock data only.

**Catalyst alert worker:** `scraper/send_alerts.py` invoked by
`.github/workflows/send-catalyst-alerts.yml` on `0 13 * * *` (= 8am ET
standard, 9am ET DST). For each active signal it computes
`(catalyst_date - today)` and calls the `send-alerts` edge function with
the right `alert_type` (14d / 7d / 1d / outcome reminder day-after).
Idempotent: skips if `(signal_id, alert_type)` already in `alerts`.
LogSignal mirrors the spread expiry into `catalyst_date` at insert
time, so this worker fires "expiry approaching" alerts on GEX-flow
signals naturally — no GEX-specific code path needed. Required secrets:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

**In-app notifications:** `NotificationCenter` in the dashboard header
subscribes to `alerts` realtime (per-user channel `alerts:${user.id}`),
shows a 20-row dropdown with unread badge, marks read on open. PWA
service worker has `push` + `notificationclick` handlers wired.
Server-side push delivery: Settings → "Push Notifications → Enable" calls
`enablePushNotifications` in `src/utils/pwa.js` which subscribes via
`pushManager.subscribe`, upserts the `(endpoint, p256dh, auth)` tuple
into `push_subscriptions`, and `send-alerts` then fans out encrypted
web-push using the VAPID private key. Generate a keypair with
`npx web-push generate-vapid-keys`; the public half goes into
`VITE_VAPID_PUBLIC_KEY` (Vercel env), the private half into
`VAPID_PRIVATE_KEY` (Supabase secret) along with `VAPID_PUBLIC_KEY`
(server-side) and `VAPID_SUBJECT` (a `mailto:` URI).

**Still pending (post-MVP):**
- PWA icon binaries (`public/icon-192.png`, `public/icon-512.png`)
- `pharma-edge-public-record` GitHub repo (must be created manually) —
  anchor workflow will fail until it exists and `GH_PAT` +
  `PUBLIC_RECORD_REPO` are set
- Auto -50% stop-loss trigger needs a live option price feed;
  `useDteMonitor` only covers DTE < 21 today
- Resend `onboarding@resend.dev` sender works only for the Resend
  account owner — switch to a verified custom domain before opening
  signups
- Order monitoring expansion — fill-status polling exists, but
  automated profit-take + stop-loss close orders + push-on-fill alerts
  still pending
- Tastytrade auth flip from sandbox → prod base URL once paper trading
  is done

Treat file paths and component names from the unimplemented sections as
the build contract, not as things you can import.

---

## What This Project Is

**Cash Moves** (cashmoves.io) is a real-time options flow and gamma
exposure platform that surfaces where institutional money is actually
positioned. Built by Cameron Wiley.

Positioning: same brand tier as Unusual Whales — built for serious
traders who want dealer positioning, unusual options activity, and GEX
levels in one tape. Comparable, not feature-clone.

The app does four things:
1. **HeatPulse™** — live GEX by strike for the streamed-ticker universe
   (SPY/QQQ/IWM/AAPL/etc.) with "The Flip" (zero-gamma level) and "The
   Wall" (largest dealer position) called out. dxlink-worker streams
   Greeks + OI in real time during RTH.
2. **Flow** — live options-print stream with UOA detection. Surfaces
   where the size is going strike by strike.
3. **Suggested Plays** — Claude reads the GEX matrix + flow + secondary
   Greeks (DEX/VEX/CEX) and proposes 0–3 spread setups that fit the
   user's account-size rules.
4. **Immutable track record** — every signal locked is SHA-256 hashed
   and anchored to a public GitHub commit. Public profile at `/r/:slug`
   is the credibility layer.

**This is not a toy project. Real capital trades off these signals.**

---

## Repo Structure

```
pharma-edge/
├── CLAUDE.md
├── .env.local                       ← Never commit. Never log.
├── package.json
├── vite.config.js
├── index.html
│
├── public/
│   ├── manifest.json
│   ├── sw.js
│   ├── icon-192.png
│   └── icon-512.png
│
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   ├── index.css
│   │
│   ├── context/AuthContext.jsx
│   ├── lib/
│   │   ├── supabase.js
│   │   └── design.js
│   ├── utils/
│   │   ├── hash.js                  ← SHA-256 signal hashing. Do not modify.
│   │   └── pwa.js
│   ├── hooks/
│   │   ├── useDteMonitor.js
│   │   └── useSubscription.js
│   ├── components/
│   │   ├── Layout.jsx
│   │   ├── LogOutcomeModal.jsx
│   │   ├── StopLossCheck.jsx
│   │   ├── NotificationCenter.jsx
│   │   ├── InstallPrompt.jsx
│   │   ├── StrikePriceCalculator.jsx
│   │   ├── SuggestedPlays.jsx
│   │   ├── MarketPulse.jsx
│   │   ├── OpenPositions.jsx
│   │   └── ErrorBoundary.jsx
│   └── pages/
│       ├── Login.jsx
│       ├── Dashboard.jsx            ← The Tape
│       ├── SignalDetail.jsx
│       ├── LogSignal.jsx            ← 4-step GEX-only flow
│       ├── Calendar.jsx
│       ├── TrackRecord.jsx
│       ├── Rules.jsx
│       ├── Settings.jsx
│       ├── OptionCalculator.jsx
│       ├── Markets.jsx
│       ├── Flow.jsx
│       ├── Reasoning.jsx
│       ├── Glossary.jsx
│       ├── LearnIndex.jsx
│       ├── learn/                   ← 5 learn articles
│       ├── PublicRecord.jsx         ← /r/:slug — no auth required
│       └── Admin.jsx                ← Owner-only (is_admin = true)
│
├── supabase/
│   ├── migrations/
│   └── functions/
│       ├── compute-gex/
│       ├── suggest-plays/
│       ├── send-alerts/
│       ├── place-order/
│       ├── get-account/
│       └── monitor-positions/
│
├── dxlink-worker/                   ← Fly.io Deno streaming worker
│
└── scraper/                         ← Hash anchoring + catalyst alerts
    ├── db/supabase_client.py
    ├── anchor_signals.py
    ├── update_anchor_shas.py
    ├── send_alerts.py
    ├── requirements.txt
    └── .env.example
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React + Vite + Tailwind | Mobile-first PWA |
| Routing | React Router v6 | Lazy-loaded non-critical pages |
| Auth | Supabase Auth | Email/password only |
| Database | Supabase PostgreSQL | RLS on all tables |
| Edge Functions | Supabase Edge Functions (Deno) | Claude API, Tastytrade, Resend |
| AI Analysis | Anthropic Claude Sonnet | `claude-sonnet-4-6` (current Sonnet 4.x) |
| Email | Resend | Production requires a verified custom domain |
| Streaming Greeks | dxFeed (via Tastytrade DXLink) | Long-running Fly.io Deno worker |
| Options Execution | Tastytrade API | OAuth2 refresh-token grant |
| Hash Anchoring | GitHub public repo | `pharma-edge-public-record` |
| Hosting | Vercel | Auto-deploys from the repo's default branch |

---

## Environment Variables

**Frontend** (`.env.local` — never commit):
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_VAPID_PUBLIC_KEY=
VITE_PUBLIC_RECORD_REPO=
```

**Supabase Edge Function Secrets** (set via `supabase secrets set`):
```
ANTHROPIC_API_KEY=
SUPABASE_SERVICE_ROLE_KEY=
RESEND_API_KEY=
TASTYTRADE_CLIENT_ID=
TASTYTRADE_CLIENT_SECRET=
TASTYTRADE_REFRESH_TOKEN=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=
APP_URL=
```

**GitHub Actions Secrets** (repo Settings → Secrets → Actions):
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ACCESS_TOKEN=
GH_PAT=
```

**Rules:**
- Never log any of these values anywhere
- Never hardcode any key in source code
- Never commit `.env.local`
- `SUPABASE_SERVICE_ROLE_KEY` is a superuser key — only use in
  server-side code (Edge Functions, GitHub Actions). Never in frontend.
- `VITE_SUPABASE_ANON_KEY` is safe for frontend — RLS protects the data

---

## Database — Critical Rules

### Supabase Project
- Project name: `pharma-edge`
- All tables have RLS enabled — do not disable it

### The Immutability Constraint
**This is the most important database rule in the entire project.**

The `signals` table has a trigger `enforce_signal_immutability` that
prevents editing `thesis`, `direction`, `catalyst_date`, `logged_at`,
`signal_hash`, and `user_id` after a signal is created. This is
intentional and permanent. Do not remove it. Do not work around it. The
entire credibility of the track record depends on this constraint.

Additionally, RLS does **not** grant DELETE on `signals` or `outcomes` —
they are write-once. To retract a signal, set `status = 'dismissed'`.
Never edit core thesis fields, never delete a signal.

### Server-Side Hashing
The canonical SHA-256 hash for signals and outcomes is computed by
Postgres triggers (`signals_compute_hash`, `outcomes_compute_hash`)
using `pgcrypto`. The frontend hash function in `src/utils/hash.js` is a
verification tool — it must produce the same hash as the DB given
identical inputs. When the two diverge, the DB wins.

### Tables Overview

```
profiles            ← extends auth.users; account_size, public settings, is_admin
watchlist           ← user-curated ticker list (no automated scanning)
signals             ← core table, IMMUTABLE thesis fields after insert
outcomes            ← logged after expiry resolves, also hashed
scanner_runs        ← legacy audit log (no new rows post-sunset)
alerts              ← notification history
public_record       ← VIEW (security_invoker=true) — anon-readable curated subset
scanner_candidates  ← retained empty (legacy biotech queue, no new writes)
candidate_drafts    ← retained empty (legacy biotech autosave, no new writes)
claude_calls        ← per-call rate-limit + cost ledger (suggest-plays writes)
push_subscriptions  ← VAPID push subscriber tuples
order_history       ← Tastytrade order audit log
tastytrade_sessions ← singleton id=1, OAuth access_token cache
gex_snapshots       ← compute-gex 5-min response cache
dxlink_quotes       ← live per-symbol price + greeks cache
admin_cost_daily    ← VIEW — daily cost rollup for /admin (security_invoker)
```

### RLS Policy
Every authenticated policy uses `(select auth.uid()) = user_id` (cached
form — required, see Supabase `auth_rls_initplan` lint). The
`public_record` view runs as `security_invoker=true`; anon reads are
governed by `*_select_public` policies on `profiles`/`signals`/`outcomes`
plus column-level `GRANT SELECT (...) TO anon`. Admin SELECT policies on
`claude_calls`, `profiles`, `signals`, `outcomes`, `scanner_runs` add
read-all for `is_admin = true` rows. Do not add policies that bypass
user isolation.

---

## Signal Flow — How the App Works

```
1. SUGGESTED PLAYS (interactive — /markets)
   User picks a ticker; suggest-plays edge function fetches GEX matrix
   from compute-gex, asks Claude Sonnet 4.6 for 0-5 spreads, server
   filters by R/R ≥ 1.5 + EV edge ≥ 0, returns top 3.

2. LOG SIGNAL (4-step flow — /log)
   Step 1: Trade Setup (ticker + spread expiration)
   Step 2: Strike & Thesis (calculator runs; spread strikes locked in)
   Step 3: Pre-trade Checklist (all 10 required)
   Step 4: Confirm + Lock
            SHA-256 hash generated by DB trigger
            Signal inserted — immutability trigger activates

3. POSITION MONITORING (send_alerts.py, 8am ET)
   Checks all active signals
   Sends 14d / 7d / 1d expiry-approaching alerts
   Sends outcome reminder (day after expiry)

4. HASH ANCHORING (anchor_signals.py, 8:30am ET)
   Fetches unhashed signals
   Writes hash file to pharma-edge-public-record repo
   GitHub commit SHA stored back to signal record

5. OUTCOME LOGGING (manual, user-triggered)
   3-step modal: what happened → P&L → rules followed
   Outcome hash generated
   Signal status → 'closed'

6. PUBLIC RECORD (/r/:slug)
   No auth required
   Reads public_record view
   Shows hashes + GitHub commit links
```

---

## Claude API Usage

### Model
Always use `claude-sonnet-4-6` (current Sonnet 4.x). When a newer Sonnet
ships, bump deliberately and re-run the prompt regression set; do not
auto-upgrade.

### Edge Functions Only
Claude API calls happen exclusively in Supabase Edge Functions. Never
call the Anthropic API from the React frontend — the API key would be
exposed.

### Prompt Caching
`suggest-plays` marks its system prompt with `cache_control: ephemeral`
so warm calls read the static prefix at the cache-read rate (~$0.30/M)
instead of the full input rate (~$3/M). Token attribution + cost are
logged on every `claude_calls` row at insert time using the model's
per-token rates, so historical rows preserve the price they were charged
at even when Anthropic's pricing changes later.

### Token Budget
`max_tokens: 2000` for `suggest-plays`. Do not raise without a reason.

---

## Trading Rules Embedded in the App

These rules are not suggestions — they are encoded in the suggest-plays
server filter (R/R + EV gate), the calculator's premium-of-width caps,
and the stop-loss UI. Do not remove or soften them.

**Entry:**
- Clear king-node thesis: trade is targeting the call wall, the put
  wall, or a flip break
- Regime supports the direction (Regime A → pin / fade / sell premium;
  Regime B → directional / breakout / long premium)
- EV edge ≥ 0: the IV-implied PoP must beat the breakeven PoP the
  structure mathematically needs
- R/R ≥ 1:1.5 (target 1:2) — server-filtered in suggest-plays before
  plays reach the client
- Don't enter at vol extremes (regime flip in progress, IV blow-off)
- Confirm flow + GEX agree; mismatch = transition signal, reduce
  conviction or wait

**Position Sizing:**
- Max 2% of account per spread (max-loss-per-spread × contracts ≤ 2%
  of NLV). Manual override allowed in PlaceOrderPanel + LogSignal step
  2 with a visible % warning when exceeded
- Max 20% of account in any single underlying

**Stop Loss:**
- Spread mark down −50% from entry → exit immediately
- Thesis invalidated (wall breaks, regime flips, flow flips against
  position) → exit same day
- 50% of DTE consumed with no thesis progress → reassess size or close
- Enforced via StopLossCheck emotion-check UI before holding through
  the trigger

**Profit Taking:**
- +100% on the spread → sell 50% of position
- +200% on the spread → sell 75% (keep 25% running into expiry)
- Spot reaches the target king node → consider full exit
- Sell into IV expansion, not after the move completes

**DTE Discipline:**
- R/R is the objective function; DTE is the parameter you optimize for it
- No same-day / 1 DTE entries unless it's an explicit Regime A pin
  (spot inside a tight wall cluster, theta is the edge)
- No 60+ DTE without a named catalyst — vega exposure dominates the
  P/L curve
- Pick the expiration that yields the cleanest R/R math, not a fixed
  bucket

**Strike Selection:**
- Anchor strikes to king nodes — call wall, put wall, or zero-gamma flip
- Debits: net debit ≤ 40% of spread width (caps R/R at 1:1.5; pay ≤33%
  for the 1:2 target)
- Credits: net credit ≥ 60% of spread width (same R/R floor, math
  inverted)
- Estimated PoP must beat Breakeven PoP — the +EV edge is what makes
  the trade work

**Regime Awareness:**
- Regime A (spot above flip, positive net GEX): dealers long gamma →
  sell rallies + buy dips → pin / vol-suppressed. Setups: short
  premium, pin trades, breakout calls AT the call wall
- Regime B (spot below flip, negative net GEX): dealers short gamma →
  buy rallies + sell dips → trend / vol-expansion. Setups: long
  premium, breakdown puts AT the put wall, vol-expansion plays
- Mixed regime / flow contradicting GEX = transition signal, half-size
  or wait for the new regime to settle

---

## Design System

**Dark theme only.** No light mode. Never add light mode.

```javascript
// All colors from src/lib/design.js
bg:           '#0a0a0f'
bgCard:       '#111118'
border:       '#1e1e2e'
red:          '#ef4444'
green:        '#22c55e'
yellow:       '#eab308'
blue:         '#6366f1'
textPrimary:  '#e8e8f0'
textSecondary:'#6b6b8a'
textMuted:    '#3a3a5c'
```

**Signal colors:**
- Long Put → red
- Long Call → green
- Watch → zinc/grey

**Typography:** System monospace for hash values and trade data. Default
Tailwind sans for UI copy.

**Mobile-first.** Max width 448px (max-w-md) centered. Bottom navigation
on mobile, sidebar on desktop. All tap targets minimum 44px.

---

## What You Can and Cannot Change

### ✅ Safe to modify
- UI copy, labels, placeholder text
- Color accents within the design system
- Adding new pages or components
- Adding new Supabase columns (additive only — never remove)
- Email template styling
- Calculator UI improvements

### ⚠️ Modify with caution — test thoroughly
- `suggest-plays` Edge Function prompt — the R/R + EV gate, regime
  classification, and king-node anchoring all live here. Test against
  3+ different ticker scenarios (Regime A pin, Regime B trend, mixed
  flow) before deploying
- `send-alerts` Edge Function — test email delivery before deploying
- `StrikePriceCalculator` math — verify against manual calculations,
  especially debit-vs-credit width caps
- Service worker (`public/sw.js`) — test PWA install on device after
  changes

### ❌ Do not touch without explicit instruction
- `enforce_signal_immutability` database trigger (and its function
  `enforce_signal_immutability_fn`)
- `compute_signal_hash` / `compute_outcome_hash` triggers (server-side
  hashing)
- `generateSignalHash` in `src/utils/hash.js` (frontend verifier — must
  match DB hash exactly)
- `generateOutcomeHash` in `LogOutcomeModal.jsx`
- RLS policies on any table — including the `*_select_public` anon
  policies and `*_select_admin` policies
- Column-level `GRANT SELECT (...) TO anon` on
  `profiles`/`signals`/`outcomes`
- The `public_record` view definition
- Pre-trade checklist items or count (10 required)
- Stop loss threshold (-50%)
- Position sizing rule (max 2% per spread / max 20% per ticker)
- The R/R ≥ 1:1.5 + EV-edge ≥ 0 server filter in suggest-plays — these
  are the two gates that keep broken-math plays from reaching the user

---

## Automated Jobs Schedule

```
8:00am ET  — send-catalyst-alerts.yml
             Checks all active signals
             Sends 14d / 7d / 1d expiry-approaching alerts
             Sends outcome reminders (day after expiry)

8:30am ET  — anchor-signals.yml
             Fetches signals without GitHub SHA
             Writes hash file to pharma-edge-public-record
             Commits + pushes to public repo
             GitHub commit SHA stored back to signal

Continuous — dxlink-worker (Fly.io)
             Streams Greeks + OI to dxlink_quotes during RTH

Periodic   — monitor-positions.yml
             Polls Tastytrade for fill status on open orders

Periodic   — snapshot-gex.yml
             Refreshes gex_snapshots cache for the curated tickers
```

All jobs use `workflow_dispatch` for manual triggering during
development. Always test with manual trigger before relying on the cron
schedule.

---

## Public Record Repository

Separate public GitHub repo: `pharma-edge-public-record`

This repo is the immutability proof layer. Every signal hash is committed
here. The commit SHA becomes part of the signal record. The public track
record page links directly to these commits.

**Rules:**
- This repo must remain public forever
- Never delete commits from this repo
- Never force-push to this repo
- The `GH_PAT` secret must have write access to this repo only

---

## Common Tasks

### Running the frontend locally
```bash
cp .env.local.example .env.local   # then fill in Supabase URL + anon key
npm install
npm run dev                        # http://localhost:5173
```
The service worker only registers in production builds (`npm run build &&
npm run preview`) so dev hot-reload isn't fighting cached assets.

### Applying database migrations
Migrations live in `supabase/migrations/` named
`<YYYYMMDDHHmmss>_<name>.sql`. Apply via the Supabase CLI:
```bash
supabase db push --project-ref rghoynbaykeyjbhqmaff
```
Or via the MCP server (`apply_migration`) — pass the SQL as `query` and a
snake_case `name`. After every schema change, run advisors and resolve
any ERROR/WARN before merging.

Never edit a migration that has already been applied to production. Add
a new migration that supersedes it.

### Deploying Edge Functions
On push to main, `.github/workflows/deploy-edge-functions.yml` detects
changed `supabase/functions/<name>/` directories and deploys each
automatically. For manual deploys, use `workflow_dispatch` with the
function name, or run locally:
```bash
supabase functions deploy <name> --project-ref rghoynbaykeyjbhqmaff
```
Edge Function errors are silent to the user — check Supabase logs after
deploy.

### Running scraper helpers locally
```bash
cd scraper
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Fill in .env values
python anchor_signals.py     # or send_alerts.py
```
Use a virtualenv. Never pass `--break-system-packages` to pip — it
bypasses PEP 668 and pollutes the system Python.

---

## Security Rules

1. **Never log API keys** — not in console.log, not in error messages
2. **Never expose SUPABASE_SERVICE_ROLE_KEY** to the frontend — it
   bypasses all RLS
3. **Never call Anthropic API from React** — always via Edge Function
4. **Never store financial account numbers** in the database
5. **Never add Polymarket** — legally prohibited for US persons under
   CFTC regulations
6. **Always validate user ownership** before any database write — RLS
   handles reads but double-check writes in Edge Functions

---

## Owner

**Cameron Wiley**
Conyers / Atlanta, GA

Questions about business logic, trading rules, or strategy decisions go
to Cameron directly. Do not infer intent — ask.

---

*Last updated: 2026-05-09 (biotech retirement)*
