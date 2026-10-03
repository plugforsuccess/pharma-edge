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
>   * Premium tier → "Pro" (formerly "Cash Moves Pro")
>   * Top tier → "Elite" (formerly "Inner Circle")
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
`claude_calls` is the per-user rate-limit + cost ledger AND the
full-fidelity post-mortem record: each row carries `ticker`,
`prompt_input` (system + messages sent), `prompt_output` (the entire
Anthropic response), `matrix_at_call` (GEX matrix visible to Claude at
the moment of the call), `duration_ms`, and `error`. Write-once via
service role; SELECT own + admin SELECT all. The companion FK lives on
`signals.originating_claude_call_id` with the chosen play stored at
`signals.claude_chosen_play` and the counterfactual rejected plays at
`signals.claude_other_plays` — together these let every future trade be
reconstructed with the exact prompt, response, matrix, and "what else
was on the table". `push_subscriptions` stores
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
Confirm), `Calendar`, `Rules`, `Settings` (display name, leaderboard username +
visibility toggle, risk fields, watchlist, sign-out), `OptionCalculator`
(standalone calculator at `/calculator`), `Markets` (HeatPulse +
Suggested Plays), `Flow`,
`Reasoning` (regime/confidence drift), `Glossary`, `LearnIndex` + 5 learn
articles, `Admin` (owner-only — gated by `profiles.is_admin`),
`Leaps` (`/leaps`, after-tax LEAPS + Exit Targets) and `LeapsOnboarding`
(`/leaps/onboarding`).

**Cut from the MVP (2026-10-02):** `TrackRecord` (`/record` → redirects
to `/leaps`) and the public profile (`/u/:slug`, legacy `/r/:slug` →
redirect to `/`), plus the Vercel edge middleware and `/api/og/[slug]`
share-preview route that only served them. Signal hashing + GitHub
anchoring are unchanged — the proof layer still exists, it just has no
public page. The `profile-public-data` / `profile-view-track` edge
functions are still deployed but unused by the app.
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
  bypasses. Yahoo path uses cookie+crumb auth. Every successful matrix
  compute also UPSERTs into `gex_history` keyed to a 5-min bucket — cron
  callers (`archive=true`) await the write; user calls fire-and-forget
  via `EdgeRuntime.waitUntil` so the time-series stays populated even
  when the GitHub Actions snapshot cron is broken.
- `ldp-onboarding` v2 (`verify_jwt=true`). The only write path into
  `ldp_risk_profiles`. Used by `/leaps/onboarding` (first run) and
  `/settings` (partial updates: risk answers, catalyst plays, Exit
  Target ladder, tax — each optional). Changing risk answers needs the
  current disclosures accepted in the request or already on file. Takes
  the LEAPS bot answers, computes the risk tier
  (`_shared/ldpRiskTier.ts`, a mirror of `ldp/risk.py` kept in parity
  by `ldp/tests/fixtures/risk_tier_cases.json` + `npm run ldp:risk:check`),
  and writes `ldp_risk_profiles` (service role) + `leaps_tax_profiles`.
  Never sets `account_tier` — new users default to self-directed.
  Requires the current `LDP_DISCLOSURES_VERSION` to be accepted.
- `entry-scan` (`verify_jwt=true`, **service-role only**; owner,
  2026-10-03: "ensure the next entry"). Daily after the close
  (`.github/workflows/entry-scan.yml`, 21:20 UTC weekdays;
  `workflow_dispatch` defaults to a dry run). For users with
  `profiles.entry_alerts` (default on; Settings → Entry Alerts, saves on
  tap) it checks their Tracking (`watchlist`) + open share / option
  holdings tickers (max 80, shared across users, Yahoo in batches of 6)
  and alerts when the **LEAPS buy zone turns YES** (default thresholds —
  users' adjusted thresholds live on their devices; one alert per
  buy-zone cluster, started within the last 3 trading days) or a **weekly
  Hardening bull** fires in the last two completed weeks (the current
  week counts once the latest daily bar is a Friday). Each alert is an
  `alerts` row (`alert_type` `entry_buy_zone` / `entry_hardening_bull`,
  new `ticker` + `event_date` columns, unique index `alerts_entry_once`
  on (user_id, alert_type, ticker, event_date) — re-runs are no-ops) plus
  web-push to the user's devices (skipped without VAPID keys); the bell
  shows them and tapping opens `/charts/entry/:ticker`. The decision is
  `src/utils/entryEvents.js` (`npm run entryevents:check`); the edge
  function runs **generated copies** of `entryEvents.js`, `indicators.js`
  and `signalSuite.js` in `_shared/` — edit `src/utils/`, then
  `npm run indicators:sync` (`indicators:check` fails when a copy is
  stale). POST `{ dry_run: true }` reports without writing.
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
│       ├── Leaps.jsx                ← /leaps — after-tax LEAPS + Exit Targets
│       ├── LeapsOnboarding.jsx      ← /leaps/onboarding
│       ├── Rules.jsx
│       ├── Settings.jsx
│       ├── OptionCalculator.jsx
│       ├── Markets.jsx
│       ├── Flow.jsx
│       ├── Reasoning.jsx
│       ├── Glossary.jsx
│       ├── LearnIndex.jsx
│       ├── learn/                   ← 5 learn articles
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

**Vercel Edge Middleware + OG image** — REMOVED 2026-10-02 with the
public profile page; the vars below are no longer read and can be
deleted from Vercel. (Kept here for history.) (set in Vercel → Project Settings →
Environment Variables, scope: all environments):
```
SUPABASE_URL=                  # same value as VITE_SUPABASE_URL
SUPABASE_ANON_KEY=             # same value as VITE_SUPABASE_ANON_KEY
APP_URL=https://pharma-edge.vercel.app
```
The middleware (`middleware.js`) and OG image route (`api/og/[slug].js`)
run at the **edge runtime**, where `VITE_*` vars are NOT exposed —
those are inlined into the client bundle at build time only. The
middleware emits an `x-cash-moves-middleware: pass:missing-env` response
header (visible via `curl -I`) when these are unset; that's the
diagnostic if SSR share previews stop working.

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
tax_year_config     ← federal brackets / LTCG thresholds / NIIT per tax year (is_current = one row)
state_tax_rates     ← per (tax_year, state) ordinary + LTCG brackets, confidence flag
leaps_tax_profiles  ← per-user after-tax inputs (portfolio, allocation, filing status, income, state, targets, CPA override)
leaps_positions     ← per-user LEAPS positions (basis, current value, purchase date) — manual today
ldp_risk_profiles   ← LDP engine risk tier + capping rule per user (service-role write only)
ldp_audit_log       ← LDP append-only audit of every trade / suggestion / skip / hold
leaps_position_marks ← one value per holding per day (trigger-written on every price save) — feeds /charts
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
- **GEX spread auto-trade minimum: $25,000 NLV** (owner, 2026-10-03).
  The bot places no spread auto-trades below it, and live mode must read
  NLV from the broker — a typed-in `profiles.account_size` can't unlock
  live spread auto-trading. `MIN_AUTO_TRADE_NLV` / `accountMinimumBlock`
  in `supabase/functions/_shared/risk_gate.ts`, checked in `evaluateRisk`
  (multi-leg spreads). **Spreads only:** it does not apply to LEAPS (the
  `ldp/` engine), single-leg entries, or manual orders.

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

Palette (2026-10-02) is **tastytrade-adjacent**: neutral black /
charcoal surfaces, white type, red for losses — but a **gold** brand
accent (not red) and a softer money **green** for gains. Tokens live in
`@theme` in `src/index.css`; Tailwind's `amber-*` (brand), `green-*`
(gains) and `red-*` (losses) ramps are remapped there, so use those
classes or the tokens — never hard-code hex in components.

```
bg          #0c0c0d    card        #161618    border   #27272a
fg          #f2f2f3    subtle      #9a9aa1    muted    #5f5f68
brand/gold  #f0b44c    gain/green  #2fd17c    loss/red #e5484d
```

**Signal colors:**
- Long Put → red
- Long Call → green
- Watch → zinc/grey

**Typography** (owner, 2026-10-03 — mono numbers clashed with the copy):
one family, Inter Tight, for copy **and** numbers; numbers get tabular
(fixed-width) digits via `.font-mono-tab` (the name is historical — it
no longer sets a monospace font), so columns still line up. Monospace
(`font-mono`, JetBrains Mono) only for hashes, commit SHAs and OCC
symbols. Prefer one size scale per screen: 11px meta / eyebrows
(uppercase + tracking only for eyebrows and badges), 12px secondary,
14px body, 16px tile titles, larger only for hero numbers.

**Line height** is opened up app-wide in `@theme` (text-xs 18px, text-sm
22px). **No (i) info pop-ups for now** (removed 2026-10-02 at the
owner's request until the copy and the pop-up behavior are designed;
one exception: the entry chart's gold (i) beside each unmet buy-zone
condition, which expands its "what it needs" line inline).
`components/InfoTip.jsx` is kept but unused; don't add footnote
paragraphs back under cards either. Tax screens keep one visible line:
"All tax figures are estimates, not tax advice. Consult a tax
professional before acting on them."
**Tax rates** on `/leaps` aren't a card: the Tax profile card's 4th
slot, "Estimated tax rate", is a "View rates" link that opens the
breakdown (long / short-term, §1256 blend) in a `Modal`.
**Card notices** (tax-wait, take-gains, roll window, time stop) use the
`Notice` component in `Leaps.jsx`: bold title and body at the same size
(text-sm), plus a small X on the title row, top right (the body runs full width below) that dismisses it on this device (localStorage,
per position and per notice). A dismissed time stop returns the next day;
a roll-window warning stays dismissed until it escalates.
**Badges:** green = long-term, amber = short-term, violet = §1256 (index options, also the add-form badge); type
badges for holdings without a tax status on the card: **Cash** in
blue (`blue-*`, the $100-bill ribbon) and **Real Estate** in brick
(`orange-*`) — real estate shows its type, not long/short-term (owner,
2026-10-02). `BADGE_TONE` in `Leaps.jsx`.
**Holdings collapse:** each holding is a tap-to-expand card (summary:
name (real estate drops "• Primary home / Rental" until expanded), dates, tax badge, after-tax value with its gain on cost — "+17.8%
after tax" — and the roll-window / time-stop flag; expanded cards show
"+17.8% after tax · +25.0% before tax" under the hero value (after-tax % green, before-tax % gold; either turns red only on a loss). Tapping that line flips every card to **annualized** ("+5.9%/yr
after tax · +6.7%/yr before tax", `annualizedReturn` in `afterTax.js`:
(1 + total)^(365.25 / days) − 1); the choice is remembered on the device
(`cm:gain-mode`). Under a year the line just shows the total (no
annualizing, no extra label); cash has
no gain line).
**Bought line** (owner, 2026-10-03): under the name it reads "Bought 5
days ago" ("today" / "yesterday"; "Exercised …" for exercised stock);
tapping it (dotted underline; doesn't open the card) flips every card to
the date, "Bought Sep 28, 2026", remembered on the device
(`cm:date-mode`). `BoughtLine` in `Leaps.jsx`.
Open state is remembered on the device (`cm:holdings-open`); new
holdings open; "Expand all / Collapse all" sits by the Holdings title.
**Exit Targets rows** keep the original card format: "100% gain • 2x" /
"−35 contracts" (gold, no "Target 1" label; the runner reads "−7
contracts" too) on the left, the whole-position sell
value on the right, that sale's after-tax gain on its own row under
the sell line ("+$1,999 after taxes", green; the value itself never
gets a "+", it's a price trigger), a progress strip under each, the runner as a last row with
its after-tax gain if the trail fired today (`runnerAfterTax`; a loss
shows red "−$X loss at today's trail"). Every target's left label reads "N% gain •
Nx" — a $ target too (its value sits on the right, with the price per
share / coin under it: "$769,231 / $BTC"; options show the premium per
share). In the editor a target is "% gain", "$ per share" (crypto: "$
per $BTC") or "$ total"; per-unit entries save as the whole-position
value (× shares, coins or contracts × 100), and saved $ targets reopen
per unit. Crypto counts
keep up to 8 decimals ("−0.1625 $BTC"), shares 2. When custom targets
sell less than the whole position, a **Kept** row closes the panel
("3.0875 $BTC not in a target · 95% of position") so the rows add up. Custom
targets can add a **runner** (`leaps_positions.runner_trail_pct`,
NULL = off): the editor's Runner row (Off / On + trail %, default 30%)
runs whatever the targets don't sell on a give-back from its peak, shown
on the card like the playbook runner (`runnerPlan` with the custom sell
shares). Targets selling 100% leave nothing to run (save is refused
with the runner on). With the runner off the rest shows as Kept. No tax-math line and no Long-term line (option-price targets sell
at the same price either way). The form toggle reads "Default" /
"Custom". Titles read "RXRX • 50 contracts" / "NAUT • 3,500 shares" / "BTC • 0.5 $BTC" (crypto counts in `$TICKER`, never "coins": "sell 0.35 $BTC");
options show "$5 Call • Exp Jan 21, 2028" below, then "Bought …".

**No page zoom** (owner, 2026-10-03): viewport `maximum-scale=1,
user-scalable=no`, `html { touch-action: pan-x pan-y }` (no pinch /
double-tap zoom, scrolling unaffected), Safari `gesturestart` /
`gesturechange` cancelled in `main.jsx`, and inputs stay 16px on phones
so iOS doesn't zoom into a focused field. Charts keep their own pinch
zoom (lightweight-charts handles touches in JS).

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

## Product tiers & page plan (decided 2026-10-02)

LEAPS drives growth. Tiers:

| Tier | Includes |
|---|---|
| **Pro** ($45/mo) | LEAPS dashboard (home), Positions + Exit Targets (manual entry, later Tradier sync), Simulator, Research bot, later government alerts, LEAPS bot |
| **Elite** (price TBD) | Everything in Pro + HeatPulse + King Board + the bot placing **spread** trades |

Other revenue: Tradier referral fees; managed accounts (auto-trading)
only after the adviser-registration question is settled with counsel.

Nav (owner, 2026-10-03): **Home · Portfolio · Charts · Pulse · Taxes**
— five equal tabs; Charts is the middle tab and looks like the others
(no raised button). The mobile bar is solid (`bg-bg`, no glass) and
pinned with `fixed inset-x-0 bottom-0` — no centering transform, which
lets a fixed bar drift on iOS — and the page doesn't rubber-band
(`overscroll-behavior-y: none`). Pulse is Elite (locked teaser for Pro). Portfolio is
`/leaps` (page title "Portfolio"). The desktop rail adds LEAPS bot,
Simulator, Settings and an "Add a holding" CTA; on mobile the Simulator
and the bot are reached from Home. Research (`/reasoning`) is out of
the nav until the research bot ships (route kept). Hidden indefinitely via `src/lib/features.js` (code
kept; each flag gates the route AND every entry point to it — flip to
true to restore): Wheel + Picks, Log a Move (`/log` → `/leaps?add=1`),
signal / play detail, Flow, Leaderboard. Hidden routes redirect, never
404. Position detail returns when the Elite spread bot ships.
Learn stays for SEO, out of nav. Data: Tradier (orders, quotes,
chains) + Massive/Polygon (IV history, bars, backtests); Tastytrade
dxLink keeps feeding HeatPulse for now.

---

## Home (`/`) — the LEAPS dashboard

Built 2026-10-02; the old GEX "The Tape" (`Dashboard.jsx`) moved to
`/tape` behind `FEATURES.tape` (off). Home reads the same numbers as
Positions through **`src/hooks/useHoldings.js`** (load + every after-tax
figure; `Leaps.jsx` uses it too — change the math there, not in a page).
Top to bottom: net worth after tax / before tax (links to Positions,
investments' after-tax return under it); **Needs action**, most urgent
first — time stop (act), targets the current value has reached ("PLTR
hit 100% gain · Sell 7 contracts · +$4,971 after taxes"), runner trail
hit (only once every target has hit), roll window open, long-term within
60 days and worth waiting for, prices older than 7 days; **Next exit
targets** (closest unhit target per holding, top 3, "Needs +36% from
here"); after-tax goals reached + income after tax; quick actions (Add
holding, Update prices, Simulator). The empty "Nothing today" card has a small X; it stays closed (`cm:home-clear-closed`) until something needs action again. ROC holdings have no targets/goals
here either. Nothing on Home edits; every row links to Positions. Hits
come from the last entered price until Tradier sync lands. With no
holdings, Home shows a welcome card with "Add your first holding".

---

## Settings (`/settings`) — where users edit their LEAPS setup

Settings is the single place to edit: account name, risk profile
(answers → server recomputes the tier), tax profile, goals (LEAPS
allocation + target returns), and the exit plan (1–5 pre-tax targets
on the option + share of the position sold at each, and the runner's
trail %; "Reset to playbook" restores the defaults). One **Save** button
persists every changed section. `/leaps` shows these read-only (no
edit links; an "Add tax details" link appears only when none exist).

**Sign-in prompt:** `components/OnboardingGate.jsx` (mounted in
Layout) sends a user with no `ldp_risk_profiles` or no
`leaps_tax_profiles` row to `/leaps/onboarding?prompt=1&next=…` once
per sign-in (keyed on `user.last_sign_in_at` in localStorage, so
reloads don't re-prompt). "Skip for now" lets them in; the next
sign-in prompts again until both rows exist.

**Number fields:** use `components/NumberInput.jsx` for every money /
count input — it shows `1,000,000` while handing the parent the plain
string `"1000000"`, so parsers stay unchanged. Managed vs self-directed is
read-only for users (set by the owner after a signed managed-account
agreement; admin control not built yet). Disclosure text + version
live in `src/lib/ldpDisclosures.js` and must match the edge function.

---

## After-Tax LEAPS (`/leaps`)

Shows what LEAPS positions are worth **after tax** and the multiple
needed to hit each after-tax return goal. Math is pure and lives in
`src/utils/afterTax.js`; `npm run aftertax:check` runs the spec's
required cases (rate derivation, 7-row target table, live after-tax
value, holding period) and must pass before any edit to that file lands.

- Tax figures are **data, not code**: `tax_year_config` (federal) and
  `state_tax_rates` (state). Each January, add a new year's rows from
  the IRS inflation-adjustment Rev. Proc. and state revenue
  departments, then flip `is_current`. NIIT thresholds ($200k single /
  HoH, $250k MFJ, $125k MFS) are statutory and do not inflate.
- Rates are combined marginal: federal LTCG or ordinary + NIIT + state,
  with brackets picked at income **plus** the projected gain.
- State component is the **effective** rate on the gain slice, derived
  from the stored schedule + `ltcg_exclusion_pct` + `ltcg_applies_to`
  (never a single flat number — WA's gain-only tax above its deduction
  and partial exclusions depend on the gain size). Federal + NIIT stay
  marginal.
- Long-term = sold on or after anniversary + 1 day. Days until
  long-term = (anniversary + 1) − today. A Feb 29 purchase anniversaries
  on Feb 28, so it goes long-term Mar 1 (tested).
- `leaps_positions.instrument_type`: `equity_option` (normal holding
  period), `index_option_1256` (SPX/XSP/NDX/RUT/VIX… — §1256 60% LT /
  40% ST at any holding period, no countdown; ETF options like SPY are
  NOT §1256), `stock`.
- Exercise (`exercise_leaps_position()` RPC, atomic, security invoker)
  closes the call (`close_reason='exercised'`) and opens a `stock` row:
  basis = premium + strike × shares, `purchase_date` = exercise date,
  `exercised_from_id` → the call. The option's clock never carries
  forward. Mirrors `exerciseCall()` in `afterTax.js` — keep in sync.
- **Puerto Rico** is a residency option (`state_tax_rates` row `PR`,
  `federal_exempt = true`). Bona fide PR residents exclude post-move
  gains from federal tax (IRC §933), so federal + NIIT are 0 and only
  PR tax applies. `leaps_tax_profiles.pr_act60_rate` holds an Act 60
  decree rate (0 = decree by 2026-12-31, 0.04 = 2027+, NULL = none),
  which replaces the PR schedule. Both `afterTax.js` and `ldp/tax.py`
  honor it. The PR row is `confidence = 'low'` (15% LTCG rate and MFJ
  upper thresholds not re-verified); pre-move appreciation staying
  federally taxable is shown as a caveat, not modeled. UI says
  "Residency", not "State".
- **Per-position Exit Targets** (`leaps_positions.exit_targets`, jsonb,
  NULL = use the account ladder from Settings): up to 5 user-set
  targets `{kind: 'pct'|'usd', value, sell}` — `pct` = gain on basis
  (1.0 = +100%), `usd` = whole-position value, `sell` = share sold
  (0–1, may total < 1; the rest is held). `customExitTargets()` in
  `afterTax.js` shows proceeds, tax and after-tax dollars per sale
  (rate at that sale's realized gain, each sale taxed on its own).
  The add form has "Save & add another" for entering many positions.
- The add form starts with **Options / Shares**. Options take contracts,
  call/put, a required expiration (after the purchase date) and an
  optional strike. §1256 is never asked: it's detected from the ticker
  (`suggestInstrumentType`, SPX/XSP/NDX/RUT/VIX…) and shown as a badge. Cost & value can be entered **per share** (default;
  options = premium × 100 × contracts) or as **totals**; only totals are
  stored (`cost_basis`, `current_value`).
- **No LEAPS basis / allocation.** Each position is independent; the
  portfolio is the sum of the open positions (total cost, value,
  after-tax value). **No portfolio target table on the page**
  (owner, 2026-10-02). Each holding has its own after-tax goal,
  `leaps_positions.goal_pct` (fraction of cost; NULL = the default in
  Settings → Goals, `leaps_tax_profiles.selected_target_pct`), set in the
  holding editor's **After-tax goal** section: one % field (no hint; an
  empty field fills with the default when the editor opens or on blur,
  and saving the untouched default stores NULL so it keeps following
  Settings), the line
  "+$1,800 after taxes" (amount in green) / "Needs 1.37x long-term" / "Needs 1.42x
  short-term" (one per row), and a
  "Show all targets" tap that expands the full 50%–20% table on that
  holding's cost (tap a row to pick it; §1256 shows its 60/40 column).
  The card's goal bar uses the holding's goal — "30% after-tax goal ·
  now 1.25x" / "Needs 1.37x long-term · 1.42x short-term". No goal on
  ROC holdings.
  `leaps_tax_profiles.leaps_allocation_pct` / `portfolio_size` are no
  longer read by `/leaps` (columns kept; Settings no longer shows the
  allocation field).
- **Holding types** (2026-10-02): `leaps_positions.instrument_type` also
  takes `crypto` (ticker = coin, quantity in `shares`, taxed like stock,
  exit plan applies), `cash` (`name`, cost_basis = current_value =
  balance, `details.apy` / `account_kind`) and `real_estate` (`name`,
  cost_basis = purchase price + improvements, `details.kind` primary |
  rental, `mortgage`, `selling_cost_pct`, `depreciation`,
  `exclusion_eligible`). `ticker` is nullable for cash / real estate.
  Math in `afterTax.js`: `cashAfterTax` (interest at the ordinary rate;
  T-bills skip state tax), `cashYieldComparison`, `realEstateAfterTax`
  (6% selling costs default, §121 $250k / $500k MFJ exclusion for a
  primary home lived in 2 of 5 years, rental depreciation recaptured at
  ≤25% + NIIT + state, rest at LT rates; after-tax equity nets the
  mortgage). The Portfolio card leads with **after-tax net worth**
  (investments + cash + real-estate equity) when cash or property
  exist, with **Before tax** in gold beside it (two equal columns, same label row
  and number size) (investments at
  current value + cash balances + property value − mortgage) and, only after
  tapping the Before tax number, a line under both: "−$X tax & selling
  costs if everything sold today" ("tax"
  alone without property); cost / gain / return and the target table cover investments
  only. **Yield comparisons live in the editor, not on the page**
  (owner, 2026-10-02): the Cash editor's "Compare after tax" section
  compares savings / money market / T-bills / CD on the balance entered,
  and the Income editor's compares the income categories on the value
  entered (`YieldCompare`), both at the user's after-tax rate — categories only, no named
  products (named partners wait on counsel); rates are user-entered,
  prefilled with example rates (`cm:cash-yield-apys`).
- **Retirement accounts are an account, not a holding type** (owner,
  2026-10-03: "the 6 we have now are sufficient"). Options, Shares,
  Income, Crypto and Cash carry `leaps_positions.account_type`
  (`ACCOUNT_TYPES`: taxable — default — / traditional / roth / hsa,
  labelled **Taxable · Traditional IRA · Roth IRA · HSA** (owner: those
  are the labels; 401(k) / 403(b) and Roth 401(k) ride along in the hint);
  the add form's **Account** row, 2 × 2; real estate is always taxable). The tax
  follows the account, not the asset: **traditional** (401(k) / 403(b) /
  traditional or SEP IRA) — nothing taxed inside (sales, dividends,
  interest); after tax = value × (1 − federal − state ordinary rate), as
  if withdrawn today, no NIIT (CPA override → its ordinary total); its
  cost went in pre-tax, so `after_tax_basis` = cost × (1 − rate) and the
  card's after-tax % uses it; the 10% before-59½ penalty shows in the tax
  detail line, never taken off. **Roth / HSA** — tax-free. No long /
  short-term countdown, wait-for-long-term notices or capital-gains
  netting for any of them; badges read Traditional IRA / Roth IRA / HSA (teal).
  `accountRates` (the rate resolver per account), `shelteredPosition`,
  `withdrawalRate` in `afterTax.js`; `useHoldings` runs every holding
  on its account's rates (goals, exit targets, runner, payouts too).
  Taxes and the Simulator cover taxable holdings only.
- **Cars and debts** (owner, 2026-10-03) aren't holdings: Settings →
  **Net worth** has two optional totals, `leaps_tax_profiles.other_assets`
  (cars, etc.) and `other_debts` (cards, student / car / personal loans;
  mortgages stay on the property). Both count in net worth (debts
  subtract) on Portfolio and Home (`others.after` / `others.before` in
  `useHoldings`); the Total card lists only the parts the user has.
- **Peers** (owner, 2026-10-03; **free**): the Total card has two pages,
  Totals and Peers — swipe it sideways or tap one of the **two dots above
  "N holdings"** (top right; owner chose dots over pills), remembered in
  `cm:totals-view`. Peers shows net worth **before tax** against
  US households from the Federal Reserve's **Survey of Consumer Finances
  2022** (summary-extract microdata, CPI-U adjusted). The tables are
  **data built by a script, never typed in**: `scraper/build_net_worth_benchmarks.py`
  (run by `.github/workflows/net-worth-benchmarks.yml` — federalreserve.gov
  and api.bls.gov aren't reachable from the dev sandbox) writes
  `src/data/netWorthBenchmarks.json`: weighted percentiles (1–99, 99.5,
  99.9) for all households and by age band, couple / single, homeowner,
  income band (SCF INCCAT cut points), education, race / ethnicity and
  single women / men, each also within the age band when the sample has
  ≥ 100 households. Re-run it (workflow_dispatch) to refresh the CPI
  month; bump it when the SCF 2025 data ships. The public SCF has no
  geography — no state / region comparison. Headline = the user's age
  band (from `leaps_tax_profiles.birth_date`, full date — owner); rows
  for all households, couple / single (filing status: joint or separate
  = couple), homeowners (a primary home among holdings), similar income,
  and only when shared: single women / men (singles only — owner),
  education, race / ethnicity (`sex`, `race_ethnicity`, `education`
  columns, Settings → **About you**, each "Prefer not to say" = NULL).
  These live on `leaps_tax_profiles` (own-row RLS, no anon policy) —
  never on `profiles`, which has public read policies. The similar-income row names its band ("Income $104K–$173K") and every
  row's median reads "Median net worth" (owner asked: it read as income). Each
  row also shows the weighted **average** (`mean` per group in the JSON) and,
  beside "Top N%", the percentile ("96th percentile", rounded down). Ranks read "Top
  18%" in the top half, "30th percentile" below the median. Math in
  `src/utils/peers.js` (`peerComparisons`; `npm run peers:check`), card in
  `components/PeersView.jsx`.
- **Dividend income.** The add form's 6th type, **Income** (Options ·
  Shares · Income / Crypto · Cash · Real estate), is a `stock` row with
  the income type and a required yield; a stock row with a yield or ROC
  reopens as Income, and plain Shares no longer ask for a yield. It can carry
  `details.dividend_yield` (fraction) + `dividend_kind` (`INCOME_KINDS`:
  qualified → LT rate; ordinary → ordinary rate; reit → ordinary
  federal × 0.8 (§199A) + NIIT + state; muni → state only; treasury →
  federal + NIIT, no state; roc → 0 now, `deferred_tax` at the LT rate
  because return of capital lowers basis and is taxed at sale; a CPA
  override uses the ordinary total, never for roc). ROC cards show
  Payouts / Tax now / Tax at sale; the income comparison ranks ROC on
  `after_tax_yield_at_sale` so a deferral never reads as tax-free. The
  kind is user-picked, never inferred from the ticker (an issuer's ROC
  status depends on its earnings & profits each year). **No exit plan on
  ROC holdings** (owner, 2026-10-02): STRC-style preferreds trade near
  par, so the card hides Exit Targets / runner / tax-wait notices and
  the form hides the Exit Targets section (saves `exit_targets` NULL).
  `dividendAfterTax` / `incomeYieldComparison` in `afterTax.js`. The
  card shows dividends / yr, after tax / yr and after-tax yield; the
  Portfolio card adds an "Income after tax" row (cash interest +
  dividends). The income comparison lists categories (dividend ETF,
  REIT, covered-call, muni, Treasury fund, BTC preferred), marked
  "prices can move" — categories only, user-entered yields.
- **Payouts received** (owner, 2026-10-03). Income holdings count what
  they've paid since purchase: `details.payouts_received` (optional,
  the 1099 total, Income editor's "Payouts received so far"), else an
  estimate = yield × today's value × years held (shown "Received
  (est.)"). The gain line is price change + payouts (after tax: sale
  proceeds after tax + payouts after their tax − cost). Taxed kinds
  keep basis at cost (card: Received / Tax paid / Kept). **ROC lowers
  basis by the payouts** (floor 0; ROC past cost is a gain when paid),
  so the sale gain, sale tax and after-tax value use the lowered basis
  (card: Received / Cost basis now / Tax if sold). Portfolio and Home
  after-tax return add payouts after tax; net worth doesn't (the cash
  already went wherever it went). `incomeHoldingReturn`, `payoutsSoFar`,
  `rocAdjustedBasis` in `afterTax.js`; the Simulator starts ROC
  holdings from the lowered basis.
- Per-position values are never netted; the portfolio card shows a
  netted figure labeled as an estimate.
- Every tax figure in the UI is labeled an estimate with a
  consult-a-professional note. Keep it that way.

---

## Charts (`/charts`), LEAPS bot (`/bot`), Taxes (`/taxes`)

Built 2026-10-03; all three read `useHoldings` like Home and Portfolio.
- **Charts** (owner, 2026-10-03) = **price charts of the stocks where
  the app suggests a LEAPS trade**, the trade drawn on the chart. **No
  GEX plays here — they live on Pulse** (owner). Groups, ideas first:
  **Search** (owner, 2026-10-03): the header's Search opens the same
  `TickerDrawer` as Pulse (with `feedLabels={false}` — no "real-time /
  15-min delayed" labels, since Charts reads daily prices for every
  ticker; the 11 sector ETFs first, then the app's ticker list, the
  user's Tracking list, and "Use XYZ" for any other symbol). Any ticker
  gets a chart with the drawing tools; a ticker that already has an idea
  or holding call opens that item. Other searches show as **Searched**
  ("No suggested trade"), the last 8 kept on this device
  (`cm:chart-recent`, Clear). `price-history` maps share classes to
  Yahoo's form (BRK.B → BRK-B).
  **List rows** (owner, 2026-10-03) are cards: ticker + verdict badge,
  what happened ("Hit 100% gain"), the instruction ("Sell 7 contracts ·
  +$2,982 after taxes"), then actions — "Show on chart" (also a tap on
  the row; scrolls up to the chart, "On the chart" when shown) and
  "Open in Portfolio" for holdings (`/leaps?open=<id>`: expands that
  holding and scrolls to it; Home's Needs action / Next exit targets and
  the LEAPS bot's checks link the same way) or "Entry chart" for ideas
  and searches.
  **LEAPS ideas** — buys from the **`suggest-leaps`** edge function, and
  LEAPS bot suggestions (`ldp_audit_log` kind `suggestion`, last 30
  days, newest per ticker, skipped where an idea covers the ticker;
  strike from the OCC `payload.contract`); **Your holdings** — today's
  sell / roll / exit calls (`dailyDecisions`; options show strike +
  break-even, shares / crypto your cost + the target's price per unit).
  **Market data is Yahoo** (owner, 2026-10-03 — the Polygon/Massive
  subscription was cancelled): `supabase/functions/_shared/yahoo.ts`
  (`yahooBars` via /v8 chart, `yahooOptions` via /v7 options with the
  cookie + crumb bootstrap shared across parallel callers, `callDelta`
  Black-Scholes since Yahoo gives IV but no greeks). **`suggest-leaps`**
  (`verify_jwt`, Yahoo, 30-min in-instance cache, market-wide) mirrors the
  LDP core sleeve — keep it in sync with `ldp/scoring.py`,
  `ldp/contracts.py` and `ldp/config.py`: the 11 SPDR sector ETFs scored
  on 3m / 6m / 12m return + 12m relative strength vs SPY (0.20 / 0.30 /
  0.30 / 0.20, min-max normalised), below the 200-day average = not
  eligible, top 3; for each, the call clearing DTE ≥ 540, delta
  0.70–0.80, vol rank ≤ 70, spread ≤ 10% of mid, OI ≥ 100, closest to
  730 DTE → delta 0.75 → tightest spread. Delta is Black-Scholes from
  each contract's Yahoo IV (4% rate, no dividends). **Vol rank is the 20-day
  historical-vol rank over a year of closes**, a stand-in for the
  engine's IV rank (`iv_history` doesn't cover the sector ETFs). No pick
  → a "Watch" row with the reason. The card shows strike, break-even
  (strike + mid), cost per contract (mid × 100). Suggestions only;
  nothing is ordered. Prices: the **`price-history`** edge function
  (`verify_jwt`; Yahoo OHLC + volume: **1D = 5-minute and 1W = 30-minute
  candles** (times as ET wall clock read as UTC, 2-min cache; 1D change is
  vs the previous close), 1M–2Y daily, **5Y weekly, All monthly**
  (Yahoo `max`); `crypto: true` prices
  the coin in USD; 15-min cache, no table). **The chart is TradingView
  Lightweight Charts** (`lightweight-charts`, Apache-2.0). Its on-chart logo is
  **off** (owner); the licence then requires the attribution notice
  (kept in `PriceChart.jsx`) and a visible link to tradingview.com — the
  "Open-source licenses" line at the bottom of Settings (owner: no
  credit on /charts). Don't remove that line while the logo is off) in
  `components/PriceChart.jsx`: **candlesticks only** (owner — no line
  chart, no toggle), volume band, magnet crosshair driving the quote
  header's OHLC / volume and the **% gain / loss from the start of the
  range to the candle under the finger** (owner; 1D measures from the
  previous close; "since Apr 3, 2025" while scrubbing), the trade's levels as dashed price
  lines with axis tags (autoscale widened so every level stays in view —
  except 1D / 1W, where it would flatten the candles),
  pinch / drag to zoom and pan; colors read from the theme tokens at
  runtime. Pass it a stable `levels` array (memoized) or it rebuilds on
  every hover. **Drawing tools** (owner, 2026-10-03), a row under the
  ranges: **Measure** — tap a candle for pin A, another for B (each snaps
  to that candle's high or low, whichever is nearer the tap; with both
  set, a tap moves the nearer pin; **drag a pin** to move it — a press
  within 24px grabs it, the chart's pan / zoom is held off until release,
  and it snaps to each candle's high or low as it moves; the readout's
  ‹ › step a pin one candle, same side, never crossing the other —
  `stepPin`); the readout shows % and $ change,
  both dates and prices, and trading days / calendar days (candles on
  1D / 1W, weeks on 5Y, months on All). **Auto** — the biggest swing in
  view (largest % rise from a low to a later high, or fall from a high
  to a later low; ties → most recent) becomes the pins, Fib on.
  **Fibonacci** (toolbar order Measure · Fibonacci · Auto, only Auto has an icon — owner, 2026-10-03) — retracements 0 / 23.6 / 38.2 / 50 / 61.8 / 78.6 / 100% back
  from B toward A, extensions 127.2 / 161.8 / 261.8% past B (green on an
  up swing, red on a down swing; 50 and 61.8 in gold), as price lines
  with axis tags and a list under the chart; the scale fits the
  retracements and 127.2%. Labels say which end a level hangs from
  (owner, 2026-10-03 — B read as A): axis tags "Fib 0% · B" … "Fib 100%
  · A" and "Ext 127.2%", and the list splits into "Pullback from B
  toward A" and "Targets past B" (the trading convention: retracements
  measure the pullback from B, extensions run past B as multiples of
  A→B). **X** clears. Pins + Fib are saved **on this
  device only**, per ticker (`cm:chart-tools:TICKER`); pins land on the
  nearest candle of any range (by calendar day across intraday / daily)
  and show "Your pins are outside this range" when they don't fit. Pins
  and Fib draw on the live chart (markers, a line series, price lines),
  so zoom survives a new pin. Math is pure in `src/utils/chartTools.js`
  (`snapPin`, `placePins`, `measure`, `fibLevels`, `autoSwing`);
  `npm run charttools:check` must pass before changing it. **Full
  screen** (owner, 2026-10-03): the violet maximize button at the end of
  the OHLC line opens the chart over the whole screen (ranges, tools and
  readout stay; the trade card hides; Esc or the minimize button closes).
  The axis price tag is a price line at the **latest close** — the
  library's own last-value tag followed the last candle in view, so a
  panned-back chart showed an old price. `components/LineChart.jsx` (plain SVG) is kept for the
  hidden holding charts. **Holding
  charts are hidden for now** (owner); `leaps_position_marks` (one value
  per holding per day, SECURITY DEFINER trigger on `leaps_positions`,
  SELECT own) keeps collecting history for when they return.
- **LEAPS entry chart** (`/charts/entry/:ticker`, "Entry chart" on the
  Charts card; owner, 2026-10-03). Data: the **`leaps-entry`** edge function
  (`verify_jwt`; 5 years of Yahoo daily bars, stored `iv_history.iv_30d`
  with values outside 2%–300% dropped, and today's ATM IV from the
  expiry nearest 30 days out; 15-min cache). The math is
  `src/utils/indicators.js` (`entryModel`; `npm run indicators:check`),
  run in the browser so thresholds apply live. `components/EntryChart.jsx`
  draws one chart with stacked panes: candles + 200 SMA (bold, green
  while its 20-day slope is up, red while down) + 50 SMA + weekly 50 EMA
  (no look-ahead), golden / death crosses, buy triangles, lighter MACD
  confirmation dots, buy-zone shading; then % from the 200 (±band), RSI 14
  (30 / level / 70), MACD 12-26-9, IV Rank 252 (cutoff line), IV vs HV20.
  Panes toggle (`cm:entry-panes`) — the chip rows are labelled groups
  ("Panels", "On price"; `ToggleGroup` in `LeapsEntry.jsx`): on = violet
  tint + check, off = neutral outline + plus, so an off chip reads as
  "add", never as disabled. **Buy zone** = every condition on the
  same day: within ±band of the 200, 200 rising, 50 > 200, RSI below the
  level within the lookback and up today, IV Rank below the cutoff.
  MACD cross up within 5 days = optional confirmation. **Next entry**
  (owner, 2026-10-03): each unmet condition gets a gold (i) after its
  label; tapping it shows what it still needs in gold under the label
  (hidden until tapped, owner) (`entryGaps` in `indicators.js`: "Fall 3.2% to
  $381.40 or lower", "Needs a dip below 40", "Needs to drop 7 points",
  "4.4% below — needs to cross above", "Still falling — needs to turn
  up"), and a NO shows the entry price zone (the ±band around the
  200-day) under the headline. Thresholds (band,
  RSI level, IV Rank cutoff, lookback) are inputs saved on the device
  (`cm:entry-params`). **IV Rank falls back to the 20-day HV rank** until
  200 of the last 252 days have real IV (labelled "HV rank stand-in").
  Backtest: one trade per cluster (a signal counts when none fired in
  the previous 20 trading days), stock returns after 63 / 126 / 252 days,
  win rate and average per horizon — stock, not option, returns.
- **Confluence** (owner, 2026-10-03: lows should line up with the suite;
  confluence across panels; history should inform entries). Math in
  `src/utils/confluence.js` (`npm run confluence:check`), always on the
  **daily** signals: the score = how many of five fired within the last
  **5 trading days** (look-back only, today included) — buy zone (all 5
  conditions), Bravo bull ◆, Echo bull, Tango bull, MACD cross up. It sits
  **beside** the YES / NO (advised, owner agreed — YES / NO stays the rule
  and drives alerts): a "Confluence · last 5 days — N of 5" block in the
  status card with the five chips and this setup's record on this ticker
  ("This setup: 7× in 5 years · 50% near a low · 12M +31% avg, 83% win";
  under 5 exact matches it falls back to every setup with at least today's
  score and says so; one signal alone isn't a setup). **Swing lows /
  highs** (lowest low / highest high 10 bars either side) are hindsight:
  they only grade history (a setup is "at a low" with a swing low within
  ±5 bars), never feed the live score. Setups = each cluster of
  score ≥ 2 bars counts every distinct combination once, at its first bar.
  Chart: a **Confluence** pane (0–5 bars, 3+ in violet / 4+ green, daily
  only; panes key `cm:entry-panes:v3`) and a **Swing lows** price layer
  (violet dots under lows, grey over highs). Backtest → **Confluence**:
  every combination, how often it sat at a low, 3M / 6M / 12M averages;
  plus the **agreement window** comparison (±3 / ±5 / ±10 days, all graded
  on the same ±5 so a wider window can't win by being wider). Single-ticker
  history is small — the card flags "few cases". Colour token
  `--color-confluence` (hex — the chart canvas needs it). **The Bravo
  band is gone** (owner: not needed); the suite card's Bravo row jumps to
  the latest Bravo diamond.
- **Two-sided confluence + the nightly ranking** (owner, 2026-10-03:
  "identify lows (buy entries) and extended highs (exits)"). Confluence
  has a **sell** side too: Extended (RSI ≥ 70, or % above the 200-day in
  the top 10% of its last year), Bravo bear ◆, Echo / Tango bear, MACD
  cross down — graded against swing **highs** (a sell "wins" when the stock
  fell). The status card shows Buy · lows and Sell · extended highs; the
  Confluence pane diverges (buy up, sell down); the backtest has a Buy /
  Sell switch. **Ranking:** `scripts/rank-confluence.mjs` in
  `.github/workflows/confluence-rank.yml` (21:40 UTC weekdays = full;
  dispatch defaults to rank-only; a push to a feature branch touching it
  re-ranks without alerts) runs the same `src/utils/` math on 5 years of
  Yahoo bars for every ticker in `CHART_TICKERS` (~564), pools every
  ticker's setups per side and combination (`confluence_pool`), blends
  each ticker's own record of today's combination toward the pool
  (`blendedEstimate`: (n·own + 10·pool) / (n + 10)) and ranks
  (`confluence_ranks`, one row per side × ticker, rank NULL = not
  eligible): **buy** = score ≥ 2, 200-day rising, blended 6M avg > 0, best
  6M first; **sell** = score ≥ 2, blended 3M avg < 0, most negative first.
  Both tables are shared market data (authenticated SELECT, service-role
  write). Charts opens with **Confluence leaders** (Buy · lows / Sell ·
  highs, Top 10 / Yours = Tracking + holdings; rows open the entry chart);
  the entry card falls back to the pool's record ("across 564 tickers:
  312×") when the ticker has < 5 cases. **Alerts** (full mode, users with
  entry alerts on): a Tracking / holding ticker entering the buy top 10
  (`confluence_top_buy`) or a holding entering the sell top 10
  (`confluence_top_sell`) → an alerts row (bell) + one email per user via
  **Resend — a placeholder**: skipped (logged) until the `RESEND_API_KEY`
  Actions secret and a verified `RESEND_FROM` (Actions variable, default
  `Cash Moves <alerts@cashmoves.io>`) exist. No push from this job yet.
- **Replay + Signal record** (owner, 2026-10-03: NOW +84% — "how can the
  app suggest this trade and signal the exit?"; advised: it can't be
  guaranteed without look-ahead, so measure it honestly). `src/utils/replay.js`
  (`npm run replay:check`, which also proves no look-ahead: each day's
  signals equal a model built on the bars up to that day) walks a ticker
  day by day: entry rules **Confluence** (buy score reaching 2, 200-day
  rising), **Buy zone** (turns YES), **Bravo ◆** (200-day rising); a signal
  at a close buys the next open; the call is ~730 DTE at 0.75 delta,
  **priced with Black-Scholes** from trailing 60-day vol (floor 15%), 2%
  slippage per fill — estimates, not quotes. Exits: **Targets** (the exit
  playbook: 70% at +100%, 15% at +200%, runner on a 30% trail once both
  hit), **Signals** (all out on 2+ sell signals), **Both** (targets first;
  after target 1, 2+ sell signals close the rest); time stop at 6 months
  left; no hard stop. Big moves (swing low → +30% within 126 bars) are
  found with hindsight only to grade: caught = a signal from 10 bars before
  the low to the half-way bar; misses say why (200-day falling / no or one
  signal / late / already holding). The entry chart's **Replay** card runs
  it live (rules saved in `cm:replay-rules`; rows jump the chart).
  **Puts** (owner, 2026-10-03: "have we considered puts?" — advised: test
  before suggesting; long-dated puts fight the drift, so the test is
  **put debit spreads under the spread rules**): `replayPutSpreads` —
  entry = the sell score reaching 2 (`BEAR_RULES`: 200-day falling / any
  trend), ~90 DTE, long put at the money, short put one expected move
  lower (S·σ·√T), debit ≤ 40% of width or skipped, +100% sell half, +200%
  another quarter, −50% out, 2+ buy signals = thesis flip → out, out at 21
  DTE (`PUT_MODEL`). Graded against big drops (swing high → −20% within
  63 bars, `bigDrops` / `gradeDrops`). Shown as a Puts strip on the
  Replay card and a Puts card on Signal record. **Nothing suggests a put
  yet** — the LEAPS bot stays long only; bear trades would sit with the
  spread rules if the test holds up.
  **Universe:** `scripts/replay-universe.mjs` in
  `.github/workflows/replay-universe.yml` (Saturdays, dispatch, branch
  pushes touching it) replays every ticker, pools trades per rule pair,
  catch rate + miss reasons, the 60 biggest misses, **walk-forward** (each
  confluence trade judged only by setups whose 6M result was known before
  its signal, own blended toward the pool) and by-year → one `replay_runs`
  row (authenticated SELECT, service-role write); `/charts/record` (Signal
  record, linked from the leaders card and the Replay card) shows the
  latest. Both Actions jobs fetch bars through `scripts/lib/marketData.mjs`:
  Yahoo with the cookie + crumb session (runners get 429 without it), else
  the `leaps-entry` edge function with the service-role key.
- **Signal suite on the entry chart** (owner, 2026-10-03: "for better
  entries and sell signals"). A JS port of the TradingView suite in
  `plugforsuccess/wiley-indicator-suite` (Bravo trend, Echo momentum,
  Tango money flow, Hardening ★ confluence, Exit Meta) in
  `src/utils/signalSuite.js` (`suiteModel`; `npm run suite:check`), with
  the Pine defaults. UI names: the pillar names only — never "Wiley"
  (old brand). Two fixes vs the Pine: the Bravo "regime flip" exit and
  Hardening's daily agreement read Bravo's **regime** (close and fast EMA
  above / below the basis) instead of its cooldown-gated signal stream,
  which dropped to 0 the bar after every signal. `leaps-entry` also
  returns SPY + ^VIX daily closes (relative-strength booster, VIX < 30
  gate for bulls). Entry chart: Echo and Tango panes (adaptive rails,
  dots where they cross); price layers (`cm:entry-layers`) Hardening ★
  (gold ▲ bull under the candle, red ▼ bear above), Exits (small red
  squares, E / T / B) and the Bravo band (off by default); a **Signal
  suite** card under the status panel — Entry (latest Hardening bull)
  and Sell (fresh Hardening bear, else fresh exit, else the latest)
  tiles, "fresh" = within 10 trading days, plus each pillar's state; the
  backtest has tabs Buy zone / Hardening ▲ / Sell signals (sell "win" =
  the stock fell after), and the Hardening tab lists near-misses by gate.
  Each pane has a **header strip above its data** (owner, 2026-10-03):
  the title and live values sit on their own row — the pane's top scale
  margin is the header height (46px price, 30px others) over the pane
  height, recomputed on resize; 0–100 scales blank tick labels past 100.
  **Pillar signals are diamonds in the suite's colors** (owner,
  2026-10-03): blue = bull, pink = bear (`--color-suite-bull` /
  `--color-suite-bear` tokens, signals only — gains / losses stay green /
  red), styled after TradingView's (owner's reference): a soft fill, a
  bright outline in the same hue and a thin background-color ring. Echo /
  Tango diamonds sit in a **signal lane** along the bottom of their pane
  (a faint strip; the line keeps a bottom margin above it), and their
  areas are blue above zero / pink below. On the price chart (owner,
  2026-10-03): **Bravo diamonds** (layer "Bravo ◆", on by default) — solid,
  "B" inside, blue under the candle where Bravo's bull condition turns on,
  pink above where the bear one does, at most one per 5-bar cooldown
  (`bravo.bullOn` / `bearOn`); **exits** are hollow pink diamonds above
  the candle with the reason inside (E / T / B), stacked over a Bravo
  bear diamond on the same day. Letters go inside the diamond. Drawn by
  `components/chartDiamonds.js` (a series primitive — the library has no
  diamond marker). Hardening keeps its gold ▲ / red ▼ arrows.
  Every pane has a **violet title** (`PANE_TITLES`) and a small violet
  maximize button at its top right that opens that pane alone full
  screen (`FullPane` in `LeapsEntry.jsx`; Esc or X closes).
  **Hardening is hidden** (owner, 2026-10-03: "prevents trades and isn't
  helpful" — maybe rebuilt later): `FEATURES.hardening = false` hides its
  layer, the buy-zone confirmation row, the backtest tab / with-without
  table, and the Signal suite tiles fall back to the **Bravo diamonds**
  (Entry = latest Bravo bull, Sell = fresh Bravo bear or exit); the
  backtest tabs read Buy zone · Bravo ◆ · Sell signals (Bravo bears +
  exits). The Hardening entry alert is off too (`HARDENING_ALERTS` in
  `entryEvents.js`; entry-scan v2 is deployed with a buy-zone-only subset
  of the shared files — redeploy from the full `_shared` copies to bring
  it back). The Hardening code and checks stay.
  **Bravo diamonds = TradingView's** (owner, 2026-10-03: "extremely
  important"): exactly the Pine's plotted event — the bar the raw
  condition turns on, **no cooldown** (`bravo.bullOn` / `bearOn`); the
  layer setting moved to `cm:entry-layers:v2` (default Bravo ◆ + Exits),
  since choices saved before the layer existed left it off. **Panes:**
  Echo and Tango sit right under the price (`SUB_PANES` order);
  `EntryChart` creates every pane up front (`chart.addPane(true)`) — the
  library appends a pane when a series asks for an index past the last,
  so out-of-order series landed in the wrong pane.
  **Timeframe: Daily (default) · Weekly · Monthly** (owner, 2026-10-03;
  daily = the chart's own bars, like TradingView on a daily chart — no
  extra fetch; Daily came back once Hardening was hidden). The card's
  switch (`cm:suite-tf:v2`) runs the whole suite on that interval, and
  **the candles follow it** (owner, 2026-10-03): Weekly / Monthly draw
  those bars with the same indicator math run on them (200W / 50W
  averages, "% vs 200-week", weekly RSI / MACD, the suite on its own bars;
  `INTERVALS` / `paneTitle` in `EntryChart.jsx`) and drop what only exists
  daily — buy-zone shading and arrows, MACD-confirm dots, the IV Rank /
  IV vs HV panes, the W50 line; the status card stays daily. Tiles and
  backtest rows jump to their bar on whichever chart is shown (daily rows
  map to their week / month). **Every pane has a date row** under it
  (owner: dates missing on the minimized view) — years always, months in
  the gaps under a two-year view, ≥ 56px apart; Echo / Tango lanes sit
  above it (`laneOffset`); the last pane keeps the chart's own axis.
  Older notes on the interval:
  `leaps-entry` with `suite: '1wk' | '1mo'` returns the ticker's full
  Yahoo history ("max") plus SPY / ^VIX on the same interval (the
  200-bar warm-ups need it). `normalizePeriods` merges Yahoo's live
  duplicate bar; `suiteOnDays` places each period's values on the daily
  candle its week / month closes on (the current period on today), so
  nothing shows early, and the Echo / Tango panes ("Echo · Weekly") and
  the Bravo band draw as steps. Ages read in weeks / months; "fresh" =
  within 2 weeks / 1 month. The Hardening ▲ and Sell backtests use the
  period bars over the full history, returns after 13 / 26 / 52 weeks or
  3 / 6 / 12 months; rows on the daily chart jump to it. The buy-zone
  confirmation window is 10 trading days (weekly) / 21 (monthly). No
  yearly: the 200-bar warm-ups never finish on yearly bars.
  **Everything in the Signal suite card is tappable** (owner, 2026-10-03):
  the Entry / Sell tiles jump the chart to that signal ("View on chart":
  ~3 months either side, crosshair on the bar — `jump` prop on
  `EntryChart`); Echo / Tango rows open their pane full screen; the
  Bravo row turns the Bravo band on; position rows open the holding in
  Portfolio. Backtest rows jump the chart to their date too.
  **Where the suite applies** (owner, 2026-10-03): its exits suit **GEX
  spreads and share holdings**, not LEAPS. The Signal suite card lists the
  user's open positions in the ticker: shares → "the sell signals apply";
  LEAPS → "your exit plan decides". Charts' share-holding rows add a
  violet "Signals" link to the entry chart. **Hardening is a
  confirmation, not a buy-zone condition** (advised, owner asked): a
  status row "Hardening confirmation (optional)" when a Hardening bull
  fired within 10 trading days, and the Buy zone backtest splits trades
  into with / without Hardening (avg 3M / 6M / 12M) — promote it to a
  condition only if confirmed trades clearly do better across tickers.
  **Advisory only:** sell signals don't change the LEAPS exit playbook
  or the bot's decisions. With the Pine gates (ATR expansion ≥ 1.1× in 5
  bars, Echo ≥ 15 points in 5 bars) daily Hardening signals are rare.
- **LEAPS bot.** Mode (places trades only on managed accounts, else
  suggests), risk tier, **Today's checks** — one decision per holding
  from `dailyDecisions` in `src/lib/holdingChecks.jsx` (time stop →
  targets → runner trail → roll window → wait for long-term → hold; the
  same checks feed Home's Needs action via `needsAction`) — and
  **History** from `ldp_audit_log` (newest 50). Linked from Home's Needs
  action card.
- **Taxes.** Tax if sold today (investments netted + real estate) and
  tax on income / yr; gains by character; **Waiting for long-term**
  (short-term winners, date, savings); **Losses you could use** (biggest
  first, each limited to the gains left to offset + the $3,000 ordinary
  deduction, the rest carries forward; one wash-sale line); income tax
  by kind (ROC shown as due at sale); the rate breakdown
  (`components/RateBreakdown.jsx`, shared with Portfolio's View rates).

## Simulator (`/simulator`)

After-tax what-if sandbox; nothing is saved. Same math as `/leaps`.
- **Grow** — add money over time. Opens on the user's largest share /
  income / crypto holding (prefilled; income holdings start at 0% price
  growth); the list also has **All holdings** (every share / income /
  crypto holding at its own yield and income type, cash at its APY —
  T-bills as Treasury, the rest as ordinary interest — ROC preferreds
  flat, new monthly money in its own sleeve; real estate and options
  left out; `portfolioProjection()` sums per-sleeve `growthProjection`
  runs, sale tax per sleeve) and a new investment; monthly contribution, years, price growth, yield, income
  type, reinvest or take payouts as cash. `growthProjection()` in
  `afterTax.js` runs month by month (payouts taxed as paid via
  `incomeTaxRate`, reinvested after tax into basis; ROC lowers basis and
  is taxed past zero) and shows the after-tax value if sold at each year
  end at long-term rates.
- **Sell** — opens on the largest investment. One sale (from a holding or new: cost, sell price, bought /
  sell dates) under your setup vs a what-if residency, filing status and
  income, side by side, plus what waiting for long-term would keep. CPA
  rate overrides carry over only while the what-if matches your setup.

---

## LDP engine (`ldp/`) — automated LEAPS

Python package (stdlib only, 3.11+) that buys long-dated LEAPS on sector
ETFs (core) plus risk-gated small-cap satellites through **Tradier**,
and decides daily when to sell using each user's after-tax math. Start
with `ldp/README.md`. Tests: `python -m pytest -q ldp` (CI:
`.github/workflows/ldp-tests.yml`).

- **Its own trading rules.** LDP buys single-leg long calls, not
  spreads, and sizes satellites at 5% per name / 15% total. That
  deliberately differs from the Cash Moves spread rules above (spreads
  only, 2% per spread), which still govern the manual / GEX flows. LDP
  thresholds live in `ldp/config.py`; never hard-code them in rule
  modules.
- **Compliance gate.** Auto-trading only when the account is
  `managed`; self-directed accounts get suggestions, whatever the risk
  tier. `ldp_audit_log` has a CHECK that rejects a `trade` row unless
  it is `auto` on a managed account. Do not remove it.
- **Exit playbook (owner, 2026-10-02) — the default everywhere.** Every
  LEAPS is risk capital that can go to zero: **no hard price stop**, cut
  only when the thesis breaks (failed trial, dilution, broken business).
  Target 1 **+100% on the option → sell 70%** (cost back plus profit);
  Target 2 **+200% → sell 15%** (half of what's left); the last 15% is
  the **runner, exiting on a 30% give-back from its peak**. Time stop:
  roll window at **9 months** left, **exit or roll at 6**. Taxes come
  after the plan: wait for long-term only if it lands before the roll
  window opens. Buy with **18–24+ months** to expiry. When a buy fills
  the engine rests a **GTC limit sell for Target 1**. Targets are
  pre-tax; every sale still shows its after-tax dollars. Stored in
  `ldp_risk_profiles.exit_ladder` / `rung_fractions` (total ≤ 1, rest =
  runner) / `runner_trail_pct`; position peaks in
  `leaps_positions.peak_unit_value`. Engine: `ldp/config.py` ExitConfig,
  `ldp/ladder.py`, `ldp/rules.py`; app mirror: `EXIT_PLAYBOOK`,
  `allocateWithRunner`, `runnerPlan`, `timeStop`, `longTermFitsPlan` in
  `afterTax.js` (same contract split, ties go to selling). Change the
  rules only with the owner. This playbook is separate from the spread
  rules above (−50% stop etc.), which still govern GEX spreads.
- **Risk beats tax.** Sell rules 1–3 (thesis / satellite hard reject /
  time stop / runner trail) run before any tax-motivated hold. Keep that
  order.
- `ldp_risk_profiles` and `ldp_audit_log` are service-role write only.
  Users read their own rows. Users must never be able to edit their own
  tier or account tier.
- Limit orders only. `LimitOrder` can't express a market order; keep
  it that way.
- Thresholds the edge function needs come from
  `supabase/functions/_shared/ldpConfig.generated.ts`, generated by
  `python -m ldp.tools.export_edge_config`. After changing a risk rule
  or threshold in Python, regenerate it and the parity fixtures
  (`python -m ldp.tools.export_risk_fixtures`), then run
  `npm run ldp:risk:check`.
- Changing the onboarding disclosure text means bumping
  `LDP_DISCLOSURES_VERSION` in both `LeapsOnboarding.jsx` and the
  `ldp-onboarding` function.
- The engine's tax math is incremental (`T(income+gain) − T(income)`,
  NIIT only above the threshold). The `/leaps` page (`afterTax.js`)
  uses combined marginal rates per its spec, so the two can differ
  slightly for gains that straddle a bracket.

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

5:40pm ET  — confluence-rank.yml (weekdays, 21:40 UTC)
             Ranks ~564 tickers on buy / sell confluence → confluence_ranks
             + confluence_pool; top-10 alerts (bell + Resend email placeholder)

Saturday   — replay-universe.yml (14:17 UTC)
             Day-by-day LEAPS replay of every ticker → replay_runs (/charts/record)

5:20pm ET  — entry-scan.yml (weekdays, 21:20 UTC)
             Entry alerts: LEAPS buy zone YES / weekly Hardening bull
             on each user's Tracking + holdings tickers → bell + push

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
