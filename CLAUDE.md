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

**Typography:** System monospace for hash values and trade data. Default
Tailwind sans for UI copy.

**Line height** is opened up app-wide in `@theme` (text-xs 18px, text-sm
22px). **No (i) info pop-ups for now** (removed 2026-10-02 at the
owner's request until the copy and the pop-up behavior are designed).
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
- **Charts.** Price history is `leaps_position_marks` (PK position +
  day; a SECURITY DEFINER trigger on `leaps_positions` upserts the day's
  mark on every insert / value change; users SELECT own rows only).
  Each holding's history starts at its cost on its purchase date. After-
  tax values are figured as of each date (holding period then). Cards:
  **Gain over time** (investments, before / after tax, vs break-even —
  gain, not value, so new money doesn't read as growth); one holding at a
  time (chips) with cost, hit targets and the next target as flat lines
  (a target over 1.6× the chart's high is named under it instead), and
  long-term / roll window / exit-or-roll dates as markers (within ~18
  months); **Where it sits, after tax** (by type); **Gain after tax, by
  holding**. Charts are plain SVG (`components/LineChart.jsx`, no chart
  library) — tap or drag to read a date.
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
