# Cash Moves — Pages, URLs & Navigation

A complete map of every route in the Cash Moves PWA, who can reach it, and what's on it. Pulled from `src/App.jsx` (router config) and `src/components/Layout.jsx` (nav config).

> Convention: paths are relative to the deployed origin (e.g. `pharma-edge.vercel.app`).
> Routes marked **(public)** require no auth; everything else needs a logged-in session via Supabase Auth.

---

## Top-level routes

| Path | Component | Auth | Purpose |
|---|---|---|---|
| `/login` | `Login` | public | Email/password sign-in. Email-confirmation flow handled by Supabase Auth. |
| `/r/:slug` | `PublicRecord` | public | Read-only track record for a user who flipped on the public toggle in Settings. The credibility layer — links each resolved signal to its GitHub commit hash. |
| `/` | `Dashboard` | auth | "The Tape" — primary landing. Signal cards, scanner-queue link, paper-trading countdown. |
| `/signal/:id` | `SignalDetail` | auth | Drill-down on one signal. Hash badge, formatted catalyst data, `LogOutcomeModal`, `StopLossCheck`, `StrikePriceCalculator`. |
| `/log` | `LogSignal` | auth | 4-step "Log a Move" flow: company → analysis → checklist → confirm + lock. |
| `/calendar` | `Calendar` | auth | Month grid + upcoming list. Urgency-coded by `daysUntil` to catalyst. |
| `/record` | `TrackRecord` | auth | Win rate, P&L, signal-type performance, rules discipline, calibration, equity curve, Web Share button. |
| `/rules` | `Rules` | auth | Account-size calculator + 6 sections of trading rules. |
| `/settings` | `Settings` | auth | Display name, public-record slug, public toggle, risk fields, push-notification opt-in, watchlist editor, sign-out. |
| `/scanner` | `ScannerCandidates` | auth | Review queue from the Python scraper (CT.gov + FDA + SEC EDGAR + biotech 8-Ks). Promote to signal or dismiss. |
| `/calculator` | `OptionCalculator` | auth | Standalone strike-price calculator (bear put / bull call spreads). 40% premium-of-width cap, 2% position-size rule. |
| `/markets` | `Markets` | auth | "HeatPulse™" — GEX/VEX/CEX/DEX/Velocity/Trinity heatmaps by strike × expiration. Suggested Plays card. Replay slider. |
| `/flow` | `Flow` | auth | Live options-print stream with UOA detection (volume ≥ 5x OI flagging). |
| `/reasoning` | `Reasoning` | auth | The deterministic-context engine: regime classification, walls, flip strike, expected move, pin probability per ticker. |
| `/learn` | `LearnIndex` | auth | Index of educational guides. |
| `/learn/dealer-positioning-guide` | `DealerPositioningGuide` | auth | Long-form: Regime A vs B, dealer hedging mechanics. |
| `/learn/gamma-flip-trading` | `GammaFlipTrading` | auth | Long-form: trading the zero-gamma flip. |
| `/learn/0dte-pinning-strategy` | `ZeroDtePinningStrategy` | auth | Long-form: 0DTE pin trade setup. |
| `/learn/vanna-exposure-explained` | `VannaExposureExplained` | auth | Long-form: VEX and IV-event setups. |
| `/learn/best-gex-tools` | `BestGexTools` | auth | Long-form: comparison of GEX tools. |
| `/glossary` | `Glossary` | auth | Definitions: GEX/VEX/CEX/DEX, The Flip, The Wall, regimes, etc. |
| `/position/:id` | `PositionDetail` | auth | Open-position detail: live P&L, wall-timing card, move-context card, triggers fired, manual close form. |
| `*` | redirect → `/` | — | Catch-all for unknown paths; sends authenticated users home, unauthenticated users to login (via `ProtectedRoute`). |

---

## Bottom navigation (mobile)

The bottom bar has 4 tabs + a center FAB for "Log a Move":

```
[ Tape ]   [ Gamma ]   ( + LOG )   [ Flow ]   [ Record ]
   /        /markets      /log       /flow     /record
```

Defined in `src/components/Layout.jsx` (`navLeft` + `navRight`). The FAB is visually dominant by design — Cash Moves is "log first, place second."

Settings and Reasoning are NOT in the bottom bar:
- **Settings** is reachable from the avatar in the Tape header.
- **Reasoning** is reachable from the Markets page header.

---

## Sidebar (desktop)

Same routes as bottom-bar mobile, plus Reasoning + Settings inline. Defined as `navFull`:

```
Tape         /
Gamma        /markets
Flow         /flow
Record       /record
Reasoning    /reasoning
Settings     /settings
```

---

## Cross-page navigation (deep links)

How users actually reach the routes that aren't in the primary nav:

| Destination | Reached from | Trigger |
|---|---|---|
| `/log` | Layout FAB, Dashboard "Log a Move" CTA, ScannerCandidates "Promote", SuggestedPlays "Use this play", Settings (no-op edge case) | Various buttons |
| `/scanner` | Dashboard scanner-queue link card | Card tap |
| `/signal/:id` | Dashboard signal cards | Card tap |
| `/position/:id` | OpenPositions component (rendered on Dashboard) | Row tap; `?close=1` query param to auto-open the close form |
| `/glossary` | Markets page header (book icon) | Header tap |
| `/learn/*` | Cross-links between learn articles + LearnIndex | Inline `<Link>` |
| `/calendar`, `/rules`, `/calculator` | Currently no top-level nav entry — reachable only by typing the URL directly. Candidates for a "More" overflow menu. | Manual URL |
| `/r/:slug` | External — shareable link from `/record` Web Share button | Out-of-app |

---

## Page-by-page summary

### Public

**`/login`** — Sign-in / sign-up. Email-confirmation step handled by Supabase Auth (`AuthContext`).

**`/r/:slug`** — Read-only public track record. Loads from the `public_record` view (security_invoker=true, anon-readable subset). Each signal row links to its GitHub commit on the `pharma-edge-public-record` repo.

### Authenticated — primary nav

**`/` (Dashboard / "The Tape")**
- Signal cards filtered by current user
- Scanner-queue link card showing pending candidate count
- Paper-trading countdown widget (`PaperTradingStatus`)
- OpenPositions list (live P&L per spread)
- Notification bell (`NotificationCenter`) in header
- Avatar in header → links to `/settings`

**`/markets` (HeatPulse™)**
- Ticker pill picker (curated + watchlist; gated by `isPro` for free tier)
- View tabs: GEX / VEX / CEX / DEX / Velocity / Trinity
- Per-tab inference strip: Net GEX/VEX/CEX/DEX (per-tab headline), Expected ±, Pin prob, Wall
- Heatmap matrix (strikes × expirations)
- Suggested Plays card (`SuggestedPlays`)
- Replay slider (historical scrubbing through `gex_history` snapshots)
- Header: Replay toggle, Reasoning link (sparkles icon), Glossary link (book icon)

**`/flow`**
- Live options-print stream (per-strike volume + premium today)
- UOA detection: rows where today's volume ≥ 5× standing OI
- Filters by ticker, side (call/put), strike range

**`/record` (TrackRecord)**
- StatBoxes: Win rate, Wins, Losses, Avg P&L (wins), Avg P&L (losses), Cum P&L %, Calibration
- Filter tabs: All / Wins / Losses / Paper / Real
- Signal-type performance breakdown (sorted by win rate)
- Rules-discipline split (rules followed vs not, win rate of each)
- Equity curve (cumulative P&L %)
- Web Share button (with clipboard fallback)

### Authenticated — secondary nav

**`/reasoning`**
- Deterministic-context engine output per ticker
- Regime A/B/mixed classification
- Walls, flip strike, expected move, pin probability
- Hashes-and-history of past reasoning outputs

**`/settings`**
- Profile: display name, slug
- Public toggle (controls `/r/:slug` visibility)
- Risk fields: account size, max risk %
- Watchlist editor (the table that drives the personal-pass scanner)
- Push-notification opt-in (writes to `push_subscriptions` via `enablePushNotifications`)
- Sign-out

### Authenticated — drill-downs

**`/signal/:id` (SignalDetail)**
- Locked thesis + hash badge (verifies match between client SHA-256 and DB hash)
- AnalyzeFilingPanel (Claude streaming analysis)
- StrikePriceCalculator (40% premium cap, spreads only, DTE warning < 21d)
- LogOutcomeModal trigger
- StopLossCheck trigger
- Public link if `signals.is_public=true`

**`/position/:id` (PositionDetail)**
- Spread strike pair, contracts, expiration + DTE (amber tone if DTE ≤ 21)
- Live P&L %, last-poll timestamp
- Stats grid: entry debit, current mid, total risk, live value
- **Move context card**: today realized vs today expected ±, % consumed, expected ± over remaining DTE
- **Wall timing card**: dominant wall strike + expiration, peaks-in-N-days vs trade DTE, pin/break interpretation
- Triggers fired (stop-loss, profit-take, DTE-21, regime-shift, etc.)
- Thesis (read-only, immutable)
- Close Position button + manual close form

**`/log` (LogSignal — 4 steps)**
1. Company + catalyst info (ticker, drug, indication, catalyst type, date)
2. Claude filing analysis + StrikePriceCalculator
3. Pre-trade checklist (10 items, all required)
4. Confirm + lock — DB trigger generates SHA-256, immutability activates

**`/scanner` (ScannerCandidates)**
- Review queue from the Python scraper
- Per-row: ticker, source (CT.gov / SEC / FDA RSS), Claude triage score, raw data peek
- Actions: Promote → routes to `/log` with prefill state; Dismiss → updates row status

### Authenticated — utility

**`/calendar`** — Month grid + upcoming-catalyst list.
**`/rules`** — Trading rules + account-size calculator.
**`/calculator`** — Standalone StrikePriceCalculator (no signal context).
**`/glossary`** — Term definitions.
**`/learn`** — Index of long-form guides; each `/learn/*` is a single article.

---

## Routing notes

- All authenticated routes wrap in `ProtectedRoute` (`src/App.jsx:33-36`); unauthenticated users hit `/login` instead.
- All authenticated routes nest inside `<ProtectedLayout>` which renders `<Layout>` (mobile bottom nav + desktop sidebar) and an `<Outlet />` for the page.
- Lazy-loaded pages (split into separate JS chunks): `TrackRecord`, `Rules`, `Settings`, `ScannerCandidates`, `OptionCalculator`, `PublicRecord`. `Suspense` wraps the layout outlet.
- The wildcard `*` route uses `<Navigate to="/" replace />` — combined with `ProtectedRoute`, unknown paths bounce authenticated users to the dashboard and unauthenticated users to login.

---

*Last updated: 2026-05-09 (PRs #91–#95 merged: regime-shift alerts, per-Greek nets, multi-Greek prompts, wall timing, move context).*
