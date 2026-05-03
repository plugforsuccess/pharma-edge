# CLAUDE.md — Pharma Edge

> This file is the onboarding document for any AI agent or developer working on this codebase.
> Read this entire file before touching any code. Every decision in here was made deliberately.

---

## Status

**Week 1 schema deployed (2026-05-03).** The Supabase project `pharma-edge` (`rghoynbaykeyjbhqmaff`) has 6 tables (`profiles`, `watchlist`, `signals`, `outcomes`, `scanner_runs`, `alerts`), the `public_record` view, RLS, and the immutability + server-side hash triggers. All Supabase advisor security lints (ERROR + WARN) and `auth_rls_initplan` perf lints are clean.

**Still pending (design spec):**
- Frontend (React/Vite/Tailwind) — `src/`, `public/`, `package.json` etc. don't exist yet
- Edge functions (`analyze-signal`, `send-alerts`, `kalshi-analysis`)
- Scraper (`scraper/`) and GitHub Actions workflows
- `pharma-edge-public-record` GitHub repo for hash anchoring
- Future tables: `scanner_candidates`, `kalshi_positions`, `combined_pnl` view (Week 2+)

Treat file paths and component names from the unimplemented sections as the build contract, not as things you can import.

---

## What This Project Is

**Pharma Edge** is a biotech catalyst signal scanner and immutable trade thesis tracker built by Cameron Wiley.

The app does three things:
1. Scans public data sources (ClinicalTrials.gov, FDA calendar, SEC EDGAR) for mispriced biotech catalysts
2. Uses Claude API to analyze public filings and generate a thesis with signal scores
3. Records every trade decision with a SHA-256 hash anchored to a public GitHub commit — creating a tamper-proof track record

The strategy is based on reading public FDA precedent and clinical trial data better than the retail market prices it. Primary instrument is bear put spreads on micro-cap biotech stocks ahead of PDUFA dates. Secondary instrument is Kalshi NO contracts on FDA approval markets when a market exists and edge ≥ 15 points.

**This is not a toy project. Real capital trades off these signals.**

---

## Repo Structure

```
pharma-edge/
├── CLAUDE.md                        ← You are here. Read before touching anything.
├── .env.local                       ← Never commit. Never log. Never expose.
├── .gitignore                       ← Confirms .env.local is excluded
├── package.json
├── vite.config.js
├── index.html
│
├── public/
│   ├── manifest.json                ← PWA manifest
│   ├── sw.js                        ← Service worker — careful editing this
│   ├── icon-192.png
│   └── icon-512.png
│
├── src/
│   ├── main.jsx                     ← Entry point. PWA registration here.
│   ├── App.jsx                      ← Router. ProtectedRoute. Lazy loading.
│   ├── index.css                    ← Tailwind only. No custom CSS elsewhere.
│   │
│   ├── context/
│   │   └── AuthContext.jsx          ← Supabase auth state. useAuth() hook.
│   │
│   ├── lib/
│   │   ├── supabase.js              ← Single Supabase client instance. Import from here only.
│   │   └── design.js                ← Color tokens, signal colors, catalyst labels.
│   │
│   ├── utils/
│   │   ├── hash.js                  ← SHA-256 signal hashing. Do not modify.
│   │   └── pwa.js                   ← Service worker registration + push permission.
│   │
│   ├── hooks/
│   │   └── useStopLossMonitor.js    ← Runs once per session. Checks active positions.
│   │
│   ├── components/
│   │   ├── Layout.jsx               ← Bottom nav + outlet wrapper
│   │   ├── AnalyzeFilingPanel.jsx   ← Claude API filing analysis input
│   │   ├── LogOutcomeModal.jsx      ← 3-step outcome logging modal
│   │   ├── StopLossCheck.jsx        ← Emotion check before holding through stop
│   │   ├── NotificationCenter.jsx   ← Bell icon + real-time alert feed
│   │   ├── InstallPrompt.jsx        ← PWA add to home screen nudge
│   │   ├── PaperTradingStatus.jsx   ← 90-day paper trading countdown widget
│   │   ├── StrikePriceCalculator.jsx ← Bear put spread / bull call spread calculator
│   │   ├── KalshiMarketPanel.jsx    ← Kalshi market search + edge calculation
│   │   └── CombinedPnlStats.jsx     ← Options + Kalshi combined P&L display
│   │
│   └── pages/
│       ├── Login.jsx                ← Auth screen
│       ├── Dashboard.jsx            ← Signal cards, stats, paper trading widget
│       ├── SignalDetail.jsx         ← Full signal view, calculator, Kalshi panel
│       ├── LogSignal.jsx            ← 4-step signal logging flow
│       ├── Calendar.jsx             ← Catalyst calendar with urgency coding
│       ├── TrackRecord.jsx          ← Win rate, P&L, signal history
│       ├── Rules.jsx                ← Trading rules + account size calculator
│       ├── Settings.jsx             ← Profile, public toggle, risk settings
│       ├── ScannerCandidates.jsx    ← Review scanner queue, promote or dismiss
│       ├── OptionCalculator.jsx     ← Standalone strike price calculator
│       └── PublicRecord.jsx         ← /r/[slug] — no auth required
│
├── supabase/
│   ├── migrations/                  ← Versioned SQL migrations (deployed)
│   │   ├── 20260503000001_init_schema.sql
│   │   └── 20260503000002_harden_security_and_perf.sql
│   └── functions/                   ← (pending)
│       ├── analyze-signal/          ← Claude API analysis edge function
│       │   └── index.ts
│       ├── send-alerts/             ← Resend email alerts edge function
│       │   └── index.ts
│       └── kalshi-analysis/         ← Kalshi market search + edge calc
│           └── index.ts
│
└── scraper/                         ← Separate Python repo or subfolder
    ├── .github/workflows/
    │   ├── daily-scan.yml           ← 7am ET cron
    │   ├── send-catalyst-alerts.yml ← 8am ET cron
    │   └── anchor-signals.yml       ← 8:30am ET cron
    ├── scrapers/
    │   ├── clinicaltrials.py
    │   ├── fda_calendar.py
    │   ├── sec_edgar.py
    │   └── finra_short.py
    ├── analyzer/
    │   └── claude_analyzer.py
    ├── kalshi/
    │   ├── client.py
    │   └── edge_calculator.py
    ├── db/
    │   └── supabase_client.py
    ├── main.py                      ← Scanner entry point
    ├── send_alerts.py               ← Catalyst alert checker
    ├── anchor_signals.py            ← GitHub hash anchoring
    ├── requirements.txt
    └── .env.example                 ← Template for scraper .env
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React + Vite + Tailwind | Mobile-first PWA |
| Routing | React Router v6 | Lazy-loaded non-critical pages |
| Auth | Supabase Auth | Email/password only |
| Database | Supabase PostgreSQL | RLS on all tables |
| Edge Functions | Supabase Edge Functions (Deno) | Claude API, Kalshi API, Resend |
| AI Analysis | Anthropic Claude Sonnet | `claude-sonnet-4-6` (current Sonnet 4.x) |
| Email | Resend | Production requires a verified custom domain. `onboarding@resend.dev` only delivers to the Resend account owner's verified address — never use it for end-user alerts. |
| Scanner | Python 3.11 + GitHub Actions | Cron at 7am ET daily |
| Options Execution | Tastytrade API | Paper trading first |
| Prediction Markets | Kalshi REST API | CFTC regulated — NOT Polymarket |
| Hash Anchoring | GitHub public repo | `pharma-edge-public-record` |
| Hosting | Vercel | Auto-deploys from the repo's default branch. Confirm `main` is the default in GitHub repo settings before relying on this — it isn't always. |

---

## Environment Variables

**Frontend** (`.env.local` — never commit):
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_VAPID_PUBLIC_KEY=
```

**Supabase Edge Function Secrets** (set via `supabase secrets set`):
```
ANTHROPIC_API_KEY=
SUPABASE_SERVICE_ROLE_KEY=
RESEND_API_KEY=
KALSHI_API_KEY=
```

**GitHub Actions Secrets** (repo Settings → Secrets → Actions):
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
RESEND_API_KEY=
ALERT_EMAIL=
KALSHI_API_KEY=
GH_PAT=
```

> Kalshi auth uses the API key only. Do not store `KALSHI_EMAIL`/`KALSHI_PASSWORD` as secrets — storing user credentials when an API key works is unnecessary blast radius.

**Rules:**
- Never log any of these values anywhere
- Never hardcode any key in source code
- Never commit `.env.local`
- `SUPABASE_SERVICE_ROLE_KEY` is a superuser key — only use in server-side code (Edge Functions, GitHub Actions). Never in frontend.
- `VITE_SUPABASE_ANON_KEY` is safe for frontend — RLS protects the data

---

## Database — Critical Rules

### Supabase Project
- Project name: `pharma-edge`
- All tables have RLS enabled — do not disable it
- Production Realm: check Supabase dashboard

### The Immutability Constraint
**This is the most important database rule in the entire project.**

The `signals` table has a trigger `enforce_signal_immutability` that prevents editing `thesis`, `direction`, `catalyst_date`, `logged_at`, `signal_hash`, and `user_id` after a signal is created. This is intentional and permanent. Do not remove it. Do not work around it. The entire credibility of the track record depends on this constraint.

Additionally, RLS does **not** grant DELETE on `signals` or `outcomes` — they are write-once. To retract a signal, set `status = 'dismissed'`. Never edit core thesis fields, never delete a signal.

### Server-Side Hashing
The canonical SHA-256 hash for signals and outcomes is computed by Postgres triggers (`signals_compute_hash`, `outcomes_compute_hash`) using `pgcrypto`. The frontend hash function in `src/utils/hash.js` is a verification tool — it must produce the same hash as the DB given identical inputs (same key order in `json_build_object` / `JSON.stringify`, same `logged_at` value, dates as `YYYY-MM-DD`). When the two diverge, the DB wins.

### Tables Overview

**Deployed (Week 1):**
```
profiles          ← extends auth.users, stores account_size + public settings
watchlist         ← companies under observation before signal confirmed
signals           ← core table, IMMUTABLE thesis fields after insert
outcomes          ← logged after catalyst resolves, also hashed
scanner_runs      ← audit log of every automated scan
alerts            ← notification history
public_record     ← VIEW (security_invoker=true) — anon-readable curated subset
```

**Pending (Week 2+):**
```
scanner_candidates ← scanner queue awaiting human review
kalshi_positions   ← Kalshi prediction market positions
combined_pnl       ← VIEW — joins signals + outcomes + kalshi_positions
```

### RLS Policy
Every authenticated policy uses `(select auth.uid()) = user_id` (cached form — required, see Supabase `auth_rls_initplan` lint). The `public_record` view runs as `security_invoker=true`; anon reads are governed by `*_select_public` policies on `profiles`/`signals`/`outcomes` plus column-level `GRANT SELECT (...) TO anon` that limits anon's column visibility to public-safe fields. Do not add policies that bypass user isolation. Do not GRANT additional columns to anon without auditing first.

---

## Signal Flow — How the App Works

Understanding this flow is mandatory before editing any signal-related code:

```
1. SCANNER (GitHub Actions, 7am ET)
   Python scrapes ClinicalTrials + FDA + SEC EDGAR
   Claude generates preliminary thesis
   Results pushed to scanner_candidates table

2. HUMAN REVIEW (ScannerCandidates page)
   User reviews candidates
   Promotes to signal or dismisses
   Prefill data passed to LogSignal

3. LOG SIGNAL (4-step flow)
   Step 1: Company + catalyst info
   Step 2: Claude analysis of filing text
            Strike price calculator runs
            Kalshi market panel searches for markets
   Step 3: Pre-trade checklist (all 10 required)
   Step 4: Confirm + lock
            SHA-256 hash generated
            Signal inserted — immutability trigger activates

4. POSITION MONITORING (send_alerts.py, 8am ET)
   Checks all active signals
   Sends catalyst approaching alerts (14d, 7d, 1d)
   Sends outcome reminder (day after catalyst)
   Checks Kalshi positions for resolution

5. HASH ANCHORING (anchor_signals.py, 8:30am ET)
   Fetches unhashed signals
   Writes hash file to pharma-edge-public-record repo
   GitHub commit SHA stored back to signal record

6. OUTCOME LOGGING (manual, user-triggered)
   3-step modal: what happened → P&L → rules followed
   Outcome hash generated
   Signal status → 'closed'
   Kalshi position auto-resolves separately

7. PUBLIC RECORD (/r/[slug])
   No auth required
   Reads public_record view
   Shows hashes + GitHub commit links
   Newsletter and copy trading credibility layer
```

---

## Claude API Usage

### Model
Always use `claude-sonnet-4-6` (current Sonnet 4.x). Do not use Haiku for signal analysis — the quality difference matters for medical/regulatory interpretation. When a newer Sonnet ships, bump deliberately and re-run the prompt regression set; do not auto-upgrade.

### Edge Functions Only
Claude API calls happen exclusively in Supabase Edge Functions. Never call the Anthropic API from the React frontend — the API key would be exposed.

### The Analysis Prompt
The signal analysis prompt in `analyze-signal/index.ts` is carefully tuned. Key constraints:
- System prompt establishes the analyst persona — skeptical, data-driven, cites specific data points
- Returns structured JSON only — no markdown, no preamble
- Includes signal scores for 5 specific signal types (enrollment, FDA precedent, protocol amendment, insider selling, cash runway)
- Returns strike suggestion percentages for the calculator

When modifying the prompt, always test with at least 3 different filing types before deploying. A bad prompt change can silently produce garbage JSON that breaks the UI.

### Token Budget
`max_tokens: 2000` for signal analysis. Do not reduce this — complex filings need the full budget.

---

## Kalshi Integration Rules

- **Legal instrument only:** Kalshi (CFTC regulated). Never add Polymarket integration. This is a hard rule — Polymarket is prohibited for US persons under CFTC regulations.
- Kalshi position size = **1% of account** (not 2%). Kalshi is binary — no stop loss possible. The smaller allocation reflects full-loss risk.
- Minimum edge threshold = **15 points** before recommending a Kalshi trade.
- Minimum R/R = **1.5** on the Kalshi position.
- Kalshi is the **overlay**, never the primary instrument. If no Kalshi market exists, proceed with options only.

---

## Trading Rules Embedded in the App

These rules are not suggestions — they are encoded in the pre-trade checklist and stop loss logic. Do not remove or soften them in the UI:

**Entry:**
- Minimum 2 confirmed signals before logging
- Never enter when stock is at all-time highs
- Never enter under 21 DTE
- 30–45 days before known catalyst
- 90–120 days for fuzzy timelines

**Position Sizing:**
- Max 2% of account per options trade
- Max 1% of account per Kalshi trade
- Max 20% total biotech sector exposure

**Stop Loss:**
- Option down -50% → exit immediately
- Thesis invalidated by new data → exit same day
- These are enforced via StopLossCheck emotion check UI

**Profit Taking:**
- +100% → sell 50% of position
- +200% → sell 75% of position
- Day before catalyst → consider full exit
- Sell into IV spike, not after announcement

**Strike Calculator Rules:**
- Never pay more than 40% of spread width in premium (caps R/R at 1:1.5; pay ≤33% for the 1:2 target)
- Minimum 1:1.5 risk/reward — target 1:2
- Always buy expiry 30–45 days PAST the catalyst date

---

## Design System

**Dark theme only.** No light mode. Never add light mode.

```javascript
// All colors from src/lib/design.js
bg:           '#0a0a0f'   // page background
bgCard:       '#111118'   // card background
border:       '#1e1e2e'   // default border
red:          '#ef4444'   // primary accent — long put, alerts, CTAs
green:        '#22c55e'   // long call, wins
yellow:       '#eab308'   // warnings, soon
blue:         '#6366f1'   // Kalshi accent only
textPrimary:  '#e8e8f0'
textSecondary:'#6b6b8a'
textMuted:    '#3a3a5c'
```

**Signal colors:**
- Long Put → red
- Long Call → green
- Watch → zinc/grey

**Typography:** System monospace for hash values and trade data. Default Tailwind sans for UI copy.

**Mobile-first.** Max width 448px (max-w-md) centered. Bottom navigation. All tap targets minimum 44px.

---

## What You Can and Cannot Change

### ✅ Safe to modify
- UI copy, labels, placeholder text
- Color accents within the design system
- Adding new pages or components
- Adding new Supabase columns (additive only — never remove)
- Scanner data sources (add new ones)
- Email template styling
- Calculator UI improvements

### ⚠️ Modify with caution — test thoroughly
- `analyze-signal` Edge Function prompt — test 3+ filings before deploying
- `send-alerts` Edge Function — test email delivery before deploying
- `StrikePriceCalculator` math — verify against manual calculations
- `KalshiMarketPanel` edge calculation — verify against Kalshi docs
- Service worker (`public/sw.js`) — test PWA install on device after changes

### ❌ Do not touch without explicit instruction
- `enforce_signal_immutability` database trigger (and its function `enforce_signal_immutability_fn`)
- `compute_signal_hash` / `compute_outcome_hash` triggers (server-side hashing)
- `generateSignalHash` in `src/utils/hash.js` (frontend verifier — must match DB hash exactly)
- `generateOutcomeHash` in `LogOutcomeModal.jsx`
- RLS policies on any table — including the `*_select_public` anon policies
- Column-level `GRANT SELECT (...) TO anon` on `profiles`/`signals`/`outcomes`
- The `public_record` view definition
- Pre-trade checklist items or count (10 required)
- Stop loss threshold (-50%)
- Position sizing rules (2% options, 1% Kalshi)

---

## Automated Jobs Schedule

```
7:00am ET  — daily-scan.yml
             Python scraper runs
             ClinicalTrials + FDA + SEC EDGAR
             Claude analyzes top 5 candidates
             Results → scanner_candidates table
             Digest email → ALERT_EMAIL

8:00am ET  — send-catalyst-alerts.yml
             Checks all active signals
             Sends 14d / 7d / 1d approaching alerts
             Sends outcome reminders (day after catalyst)
             Checks Kalshi positions for auto-resolution

8:30am ET  — anchor-signals.yml
             Fetches signals without GitHub SHA
             Writes hash file to pharma-edge-public-record
             Commits + pushes to public repo
             GitHub commit SHA stored back to signal
```

All jobs use `workflow_dispatch` for manual triggering during development. Always test with manual trigger before relying on the cron schedule.

---

## Public Record Repository

Separate public GitHub repo: `pharma-edge-public-record`

This repo is the immutability proof layer. Every signal hash is committed here. The commit SHA becomes part of the signal record. The public track record page links directly to these commits.

**Rules:**
- This repo must remain public forever
- Never delete commits from this repo
- Never force-push to this repo
- The `GH_PAT` secret must have write access to this repo only

---

## Common Tasks

### Adding a new data source to the scanner
1. Create `scrapers/new_source.py`
2. Follow the pattern in `clinicaltrials.py` — return list of dicts with standard fields
3. Add to `main.py` orchestration block
4. Add a new `source` value to the `scanner_runs.source` check constraint in Supabase
5. Test with `workflow_dispatch` before enabling cron

### Adding a new alert type
1. Add the new type to the `alert_type` check constraint in Supabase
2. Add handler in `send-alerts/index.ts`
3. Add HTML template function
4. Add trigger logic in `send_alerts.py`
5. Add icon mapping in `NotificationCenter.jsx`

### Applying database migrations
Migrations live in `supabase/migrations/` named `<YYYYMMDDHHmmss>_<name>.sql`. Apply via the Supabase CLI:
```bash
supabase db push --project-ref rghoynbaykeyjbhqmaff
```
Or via the MCP server (`apply_migration`) — pass the SQL as `query` and a snake_case `name`. After every schema change, run advisors and resolve any ERROR/WARN before merging:
```bash
# via CLI
supabase inspect db --project-ref rghoynbaykeyjbhqmaff
# or via MCP: get_advisors(type='security'), get_advisors(type='performance')
```
Never edit a migration that has already been applied to production. Add a new migration that supersedes it.

### Deploying Edge Functions
```bash
supabase functions deploy analyze-signal --project-ref rghoynbaykeyjbhqmaff
supabase functions deploy send-alerts     --project-ref rghoynbaykeyjbhqmaff
supabase functions deploy kalshi-analysis --project-ref rghoynbaykeyjbhqmaff
```
Always deploy to staging first if available. Edge Function errors are silent to the user — check Supabase logs after deploy.

### Running the scraper locally
```bash
cd scraper
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Fill in .env values
python main.py
```
Use a virtualenv. Never pass `--break-system-packages` to pip — it bypasses PEP 668 and pollutes the system Python.

---

## Security Rules

1. **Never log API keys** — not in console.log, not in error messages, not in scan_log.json
2. **Never expose SUPABASE_SERVICE_ROLE_KEY** to the frontend — it bypasses all RLS
3. **Never call Anthropic API from React** — always via Edge Function
4. **Never store financial account numbers** in the database
5. **Never add Polymarket** — legally prohibited for US persons under CFTC regulations
6. **Always validate user ownership** before any database write — RLS handles reads but double-check writes in Edge Functions

---

## Owner

**Cameron Wiley**
Conyers / Atlanta, GA

Questions about business logic, trading rules, or strategy decisions go to Cameron directly. Do not infer intent — ask.

---

*Last updated: 2026-05-03*
*Status: Week 1 schema deployed; frontend, edge functions, and scraper pending*
