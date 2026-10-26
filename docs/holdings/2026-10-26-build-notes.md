# Build notes — 2026-10-26: the Fade Screen test series, risk facts on holdings, the milestone ledger

Branch `claude/app-changes-f928yu`, 18 commits ahead of `main` (28 files,
+1,939 / −14). Everything below is pushed, built clean, and the database
changes are already applied to production (`rghoynbaykeyjbhqmaff`).

---

## 1. What was asked, in order

1. Run the owner's **Fade Screen** spec as a pre-registered test instead of
   shipping it as a score.
2. After the first result: exclude flagged months with a dated binary;
   re-run on the two carrying factors alone.
3. Ship **failed catalyst** and **shorts pressing** as plain risk facts on a
   holding; keep runway as a displayed fact; the **milestone ledger** stands
   on its own.
4. The **v2 spec** (post-test): two sentences, no color, no score; slips /
   source / evidence on ledger rows; cash and burn as plain numbers;
   earnings-call alerts; pre-register and test the long-side inverse.
5. Make the holding card one screen, not a scroll; make the ledger rows
   catch the eye; put the deadlines in full weight.

---

## 2. The research (nothing here changes a live rule)

All four runs are pre-registered in `docs/signal-engine/preregistration.md`
(pass marks fixed before each run) and recorded in
`docs/signal-engine/variants.md`. Workflow: `.github/workflows/fade-test.yml`
→ `scripts/fade-test.mjs`, artifact `fade-test.json`.

### 2.1 The universe (built from SEC data, never hand-picked)

`scripts/lib/secUniverse.mjs`: every filer whose public float
(dei:EntityPublicFloat, mid-year frames 2022–2025) sat in $100M–$2B →
listed ticker → compact XBRL facts (`compactFacts` in `src/utils/fade.js`:
annual revenue, operating cash flow, cash, shares out). Pre-revenue = annual
revenue known on the day < $25M or none. Liquid = 20-day average dollar
volume > $1M.

| step | count |
|---|---|
| filers in the float range | 2,752 |
| with a listed ticker | 1,982 |
| pre-revenue today | 678 |
| with ≥ 300 daily bars (survivors) | 658 |
| stock-months at month starts, point in time | 12,094 (train < 2024: 3,153 · test 2024→: 8,941) |

Other feeds: SEC Form 4 bulk (21 quarters, `scripts/lib/form345.mjs`, now
carrying each insider's role), FINRA consolidated short interest (655 of
658 symbols, `scripts/lib/finra.mjs`, now retrying empty bodies / 429 /
5xx), SEC submissions per company (658 of 658, `scripts/lib/secFilings.mjs`:
S-3 / S-3ASR / 424B5 / 8-K items + the company's SIC code).

### 2.2 The six factors, computed mechanically (`src/utils/fade.js`, `npm run fade:check`, 47 checks)

| factor | weight | mechanical definition |
|---|---|---|
| 1 shorts pressing | 25 | FINRA SI up ≥ 15% vs the settlement ≥ 30 days earlier → 10; and the close down ≥ 10% over the same span → 25 |
| 2 failed catalyst | 25 | an event day (close up ≥ 10% on ≥ 3× its prior-20-day volume, within 60 sessions) whose close a later close within 20 sessions undercut |
| 3 runway | 15 | cash ÷ latest-quarter operating burn (YTD rows differenced): < 3 q → 15, < 5 q → 8 |
| 4 insider selling | 15 | Form 4 code S in the prior 60 days with no buy; CEO / CFO 15, other officer 8 |
| 5 capital redirect | 10 | S-3 / S-3ASR within 365 days or a 424B5 within 180 days (added in run 2) |
| 6 trend break | 10 | 10+ closes under the 50-day, 50-day under the 200-day |

Outcomes within 126 trading days: fell ≥ 40%, rose ≥ 100%, 6-month return.
Second outcome (run 2): **raised within 6 months** = an 8-K item 3.02 or a
424B5 after the month start.

### 2.3 Results

**Run 1 — the primary (score ≥ 70, test 2024→): FAIL on one of four.**

| condition | required | found |
|---|---|---|
| months flagged | ≥ 100 | 246 |
| fell 40% within 6 months | ≥ 2× base (48.8%) | 57.7% (2.4×) |
| doubled within 6 months | ≤ base (13.9%) | **32.9% (2.4×)** |
| 6M median vs universe | ≥ 10 pts under | −22.2% vs +0.8% |

The first direction signal in the series — and it doubles one time in
three. Factors 1 + 2 carry it; insider selling adds nothing (−0.6% median);
a shelf is on 64% of fallers and nearly half the universe; "SI up, price
held" is mildly positive (+3.1%).

**Raise lead time:** runway < 5 q → raised at 1.52× base (pre-set ≥ 2×,
not met); runway + shelf 1.66× (pre-set ≥ 3×, not met). 68% of raises had
the runway flag lit the month before, but the median lead is **440 days**
— a balance sheet, not a timing signal. Runway leaves the score.

**AIRJ (the spec's worked example) does not reproduce:** scored 0 in
Feb–Mar 2024 while falling 53%; its only 70 was Dec 2025, after which it
rose 84%.

**Run 2 — follow-ups: both hypotheses rejected.** Not binary-prone (SIC
proxy): doublers 37.3% vs 9.4% base (4×). Two factors alone, both full
(305 months): doubled 32.5% vs 13.9%, median −18.4%. Variance-finding;
**the scored version is closed.**

**Run 3 — the long-side inverse:** the pair (catalyst held 20+ sessions +
shorts covering into strength) occurs in 8 months — inconclusive. Each
half alone fails in the wrong direction (held: 40% fell vs 24%; covering:
−8.3% median). Nothing long-side ships.

---

## 3. What ships: one card per holding

Owner spec v2 is kept verbatim at `docs/holdings/milestone-ledger.md`
with implementation notes. The card: **Promises** on top, **Tape** under
it, both refreshed daily; no score, tier, color-coded verdict or advice.

### 3.1 Risk facts (`ticker_risks`)

- **Table** `public.ticker_risks` (ticker PK, as_of, catalyst / shorts /
  runway jsonb; RLS: authenticated SELECT, service-role write) —
  `supabase/migrations/20261026010000_ticker_risks.sql`, applied.
- **Nightly job** `scripts/holding-risks.mjs` in
  `.github/workflows/holding-risks.yml` (weekdays 22:20 UTC; dispatch and
  branch pushes default to a dry run). Tickers = open share / option
  holdings ∪ every starred ticker, funds skipped. Bars via Yahoo / the
  edge function, FINRA short interest, SEC companyfacts. Already run live:
  rows exist for AIRJ, NAUT, NOW, PLTR, RXRX, STRC, WMT.
- **Math + copy** `src/utils/holdingRisks.js` (`npm run holdingrisks:check`,
  17 checks): `riskRow` (what the job stores), `holdingRiskFacts` (the two
  sentences), `riskRows` (the compact rows), `bothLitLine`, `cashLine`.
  - Failed catalyst shows at **20+ consecutive sessions** below the event
    close: "Below its Jul 2 close · 78 sessions · that close $5.90 · now $3.05".
  - Shorts pressing shows only when **both** halves hold (SI up ≥ 15% and
    price down ≥ 10%): "Shorts +25% · 61 days · price −48% · 17.4% of
    shares out" ("% of shares out", not "% of float" — XBRL carries float in
    dollars only).
  - Both lit → one small line with the test's reading of the both-facts
    row: "18% lower six months later at the median, and doubled one time in
    3." *Counsel has not reviewed showing a backtested figure; it is one
    sentence and easy to flag off.*
  - Cash and burn: "Cash $61M at Jun 30 · $17M used last qtr" — plain
    numbers in the Promises strip, never framed as a signal.
- **UI:** `components/RiskFacts.jsx` (`useTickerRisks`, `RiskSentences`,
  `RiskFactList`) — the holding card's **Tape** block (`RiskNotices` in
  `Leaps.jsx`) and a "Risks to watch" card on the entry chart
  (`LeapsEntry.jsx`).

### 3.2 Milestone ledger (`holding_milestones`)

- **Table** `public.holding_milestones` (own rows, cached `auth.uid()`
  policies for select / insert / update / delete): title, `due_date`
  (first promised), `current_due` (latest restatement), `slips`, `source`
  ("Q4 2025 call"), `evidence` ("8-K naming the cert"), status pending /
  met / missed / **unmentioned**, resolved_on, note —
  `20261026020000_holding_milestones.sql` + `20261026030000_milestones_v2_alerts.sql`,
  applied.
- **Math** `src/utils/milestones.js` (`npm run milestones:check`, 13
  checks): `milestoneState`, `ledgerSummary` (next promise + days, due this
  quarter, past due with no evidence, unmentioned, on-time record, slips
  and average slip), `ledgerLines`, `callChecklist`.
- **UI** `components/MilestoneLedger.jsx`: the **Promises strip** on the
  card — three tiles (Next · This qtr · Past due) and the cash line; tap →
  a modal with every row: hero countdown on the left ("66d" / "26d late" /
  ✓ / ✗), title, **the deadline on its own full-weight line** (red past
  due, amber when moved, with "was Jun 30"), source, evidence, a status
  pill, and the actions **Met · Missed · Not mentioned · Date moved**
  (keeps the first date, bumps slips). Add form: what, by when, where it was
  said, what would confirm it. On every share / option holding (not
  crypto).
- **Call alerts** (bell): `milestone_call_tomorrow` (the day before an
  earnings date — the open rows due by quarter end the call must confirm)
  and `milestone_call_check` (the day after — what is still unconfirmed).
  Written by the nightly job from `earnings_calendar`; unique per user ×
  type × ticker × date; labels and routing in `NotificationCenter.jsx`.
  Web push is not wired to this job yet.

### 3.3 Fixed along the way

- **Modal off screen:** `Layout.jsx` puts a `translate3d(0,0,0)` on the
  main column (an iOS paint hack); a transformed ancestor turns
  `position: fixed` into "fixed to that box", so any `Modal` opened after
  scrolling down landed above the viewport. `components/Modal.jsx` now
  renders through a portal on `document.body` (the ticker drawer already
  did). Affects every Modal user (rates breakdown, add position, confirms).
- **FINRA loader** no longer crashes a run on an empty 200 body.
- **SEC filings loader** returns the company's SIC code.

---

## 4. Files

| area | files |
|---|---|
| research | `scripts/fade-test.mjs`, `.github/workflows/fade-test.yml`, `src/utils/fade.js`, `scripts/check-fade.mjs`, `scripts/lib/secUniverse.mjs`, `scripts/lib/secFilings.mjs`, `scripts/lib/form345.mjs`, `scripts/lib/finra.mjs`, `docs/signal-engine/preregistration.md`, `docs/signal-engine/variants.md` |
| risk facts | `src/utils/holdingRisks.js`, `scripts/check-holding-risks.mjs`, `scripts/holding-risks.mjs`, `.github/workflows/holding-risks.yml`, `src/components/RiskFacts.jsx`, `supabase/migrations/20261026010000_ticker_risks.sql` |
| ledger | `src/utils/milestones.js`, `scripts/check-milestones.mjs`, `src/components/MilestoneLedger.jsx`, `supabase/migrations/20261026020000_holding_milestones.sql`, `supabase/migrations/20261026030000_milestones_v2_alerts.sql`, `src/components/NotificationCenter.jsx` |
| pages | `src/pages/Leaps.jsx`, `src/pages/LeapsEntry.jsx` |
| shared | `src/components/Modal.jsx`, `package.json` (`fade:check`, `holdingrisks:check`, `milestones:check`), `CLAUDE.md`, `docs/holdings/milestone-ledger.md` |

---

## 5. Open items (owner's side)

- Counsel: the one "both lit" sentence shows a backtested figure to
  subscribers.
- Web push for the two call alerts (bell only today).
- "% of float" needs a float-in-shares source; the card says "% of shares out".
- Earlier standing items: `TASTYTRADE_REFRESH_TOKEN` (market-metrics job),
  `FRED_API_KEY`, `CENSUS_API_KEY`.
- Merge: say "merge" and the branch goes through the usual checks → PR →
  squash → reset.
