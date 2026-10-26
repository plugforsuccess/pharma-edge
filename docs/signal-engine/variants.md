# Signal engine — variant log

Every rule variant tested, newest last. Date · what changed · grid · periods · result vs the pre-registered control (docs/signal-engine/preregistration.md).

_(empty — nothing tested since pre-registration on 2026-10-05)_

## 2026-10-05 — cross-sectional momentum (secondary rule)

12-1 return, top decile among names above the 200-day, month-end
rebalance, ≥ 30 names scored. One grid point, no search. Added after the
Triple event's first universe run (285 events, median stock return under
the random control at 3 / 6 / 12 months). Result: pending the next universe
run.

## 2026-10-05 — index call (SPY at month ends)

One rule, no grid: the SPY 0.75Δ ~2-year call at each completed month end,
exit playbook. Added after the first momentum run (momentum +38% / buy
setup +19% vs the paired SPY control +77%). Result: pending the next
universe run.

## 2026-10-05 — swing exit grid (16 variants)

Price target {+10%, +15%, +20%, nearest confirmed pivot high} × hold cap
{63, 126 bars} × stop {none, stock −8%}, on the existing entry rules.
Measured on hit rate and expectancy, by period and by signal year, with
the random-entry control beside. Result: pending the next universe run.

## 2026-10-19 — Leaders fix test (owner: "what must we do to fix this?")

`scripts/leader-fix-test.mjs` (`.github/workflows/leader-fix-test.yml`, run
39290867986, 544 tickers). Every variant held as a monthly basket — every
qualifying stock at a month's first close, equal weight, max 4 per industry
group (strongest 12-1 first), close to close — vs SPY and an equal-weight
any-stock basket. Train = Nov 2022 – Dec 2023 (14 months), test = 2024 – Sep
2026 (33 months). Thresholds fixed before results (smooth cut = train median
share of up days, 52.8%).

| Variant | Train / yr | Test / yr | Test worst drop | Avg names |
|---|---|---|---|---|
| Today's rule (cap 4/group) | +8.6% | **+35.3%** | −13.8% | 48.5 |
| Today's rule, no cap | +9.0% | +37.0% | −13.8% | 54.3 |
| + steady climb | +4.6% | +23.6% | −12.5% | 35.9 |
| + < 35% above the 200-day | +10.3% | +24.0% | −11.9% | 43.8 |
| + group beating the S&P | +19.5% | +18.6% | −28.6% | 15.5 |
| + cash in violent markets | +8.6% | +16.2% | −13.8% | 41.5 |
| steady + unstretched + group | +19.8% | +12.8% | −30.6% | 10.5 |
| Any stock (equal weight) | +17.6% | +16.7% | −10.5% | — |
| S&P 500 (SPY) | +19.3% | +19.1% | −7.5% | — |

By year, today's rule vs SPY: 2023 +21.5% vs +24.1%; 2024 +29.0% vs +23.7%;
2025 +74.3% vs +16.9%; 2026 (9 mo) +2.1% vs +11.8%.

**Result: no variant beat today's rule out of sample — none adopted.** The
group filter (and the combo) won on train and lost on test — the overfit the
split exists to catch. The basket of today's rule beat SPY over the test
period, but almost all of it is 2025; without 2025 it is roughly level with
SPY, with about twice the worst drop. 47 months is too short to call it an
edge. Caveats: today's ticker list (survivorship), groups from the last 120
days (hindsight in the cap and group variants), no costs or dividends.

## 2026-10-19 — Leaders portfolio test (owner: "tweak the leaders to beat the S&P")

`scripts/leader-portfolio-test.mjs` (`.github/workflows/leader-portfolio-test.yml`,
run 39336201843). Same rule and data as the fix test; only how the basket is
held. Pass mark fixed before the run: beat SPY over 2024 →, win ≥ 3 of
2023–2026, worst drop no deeper than 1.5× SPY's (−11.2%).

| Version | 2024 → /yr | Worst drop | 2023 | 2024 | 2025 | 2026 (9 mo) | Won | Pass |
|---|---|---|---|---|---|---|---|---|
| Every leader (max 4/group) | +35.3% | −13.8% | +21.5% | +29.0% | +74.3% | +2.1% | 2/4 | fail |
| Strongest 10 | +61.7% | −23.4% | +53.2% | +99.4% | +77.2% | +6.1% | 3/4 | fail (drop) |
| Strongest 20 | +49.7% | −15.8% | +31.4% | +61.6% | +86.9% | +0.5% | 3/4 | fail (drop) |
| 70% SPY + 30% leaders | +24.1% | −9.4% | +23.4% | +25.4% | +32.8% | +8.9% | 2/4 | fail |
| 50% SPY + 50% leaders | +27.4% | −10.7% | +22.9% | +26.4% | +44.0% | +6.9% | 2/4 | fail |
| Leaders while winning, else SPY | +24.3% | −13.3% | +21.4% | +20.8% | +40.0% | +7.5% | 1/4 | fail |
| Any stock | +16.7% | −11.0% | +20.5% | +17.7% | +18.1% | +10.1% | 1/4 | — |
| S&P 500 | +19.1% | −7.5% | +24.1% | +23.7% | +16.9% | +11.8% | — | — |

**Result: nothing passed.** Concentration (strongest 10 / 20) won 3 of 4 years
by wide margins but failed the drawdown limit (−23% / −16% vs −11%); the
pass mark is not moved after the fact. Concentration is also where
survivorship and the missing costs (monthly turnover in 10 names) flatter
most. Next evidence: delisted-inclusive history, and a forward, append-only
record of the strongest-10 basket from today on — no backfill.

## 2026-10-19 — Leaders + cash-flow quality (funds exempt), as baskets vs SPY

Owner: "they should be strong cash flowing companies or gaining due to
politics" → "We need ETFs and oil too". `src/utils/quality.js` (thresholds
fixed before any run: FCF > 0, FCF ≥ 5% of revenue, net debt ≤ 3 years of FCF,
diluted shares up ≤ 5% in a year; latest 10-K filed by each month start, SEC
XBRL; funds exempt). `scripts/leader-quality-test.mjs`, same baskets and pass
mark as the portfolio test (beat SPY 2024 →, ≥ 3 of 4 years, worst drop no
deeper than −11.2%).

Runs: #1 had a data bug (first revenue tag ever filed → stale revenue: DXCM
673% FCF margin, MU 194%); #2 was throttled by SEC (198 of 441 companies) —
both discarded. #3 (clean, 441 of 441, thresholds unchanged):

| version | 2024 → /yr | worst drop | 2023 | 2024 | 2025 | 2026 (9 mo) | years won | pass |
|---|---|---|---|---|---|---|---|---|
| Every leader (max 4/group) | +35.3% | −13.8% | +21.5% | +29.0% | +74.3% | +2.1% | 2 | fail |
| Every quality leader | +36.8% | −9.4% | +11.6% | +30.4% | +65.2% | +9.9% | 2 | fail |
| Strongest 10 | +61.7% | −23.4% | +53.2% | +99.4% | +77.2% | +6.1% | 3 | fail |
| **Strongest 10 quality leaders** | **+46.0%** | **−10.6%** | +21.9% | +57.6% | +57.9% | +13.7% | 3 | **PASS** |
| Strongest 20 | +49.7% | −15.8% | +31.4% | +61.6% | +86.9% | +0.5% | 3 | fail |
| Strongest 20 quality leaders | +41.3% | −7.8% | +14.0% | +43.6% | +62.7% | +10.8% | 2 | fail |
| S&P 500 (SPY) | +19.1% | −7.5% | +24.1% | +23.7% | +16.9% | +11.8% | | |

First version to clear the mark — narrowly (drop −10.6% vs −11.2%; lost 2023
to SPY). Quality cuts the drawdown roughly in half and gives up return.
Today: 16 of 38 leaders pass; oil mostly fails (COP dilution — the Marathon
deal, OXY debt, PSX / VLO thin refining margins; XOM / APA no data) — only
USO, a fund, stays. Caveats: today's ticker list (survivorship), ~4 years,
one bull market, monthly close to close, no costs. Not adopted; no live rule
changed.

### 2026-10-20 — the looser oil rule (owner: "Looser oil rule, test first")

Fixed before the run (`QUALITY_OIL`, groups Oil / Refiners / Oil services /
Pipelines): FCF > 0, FCF ≥ 2% of revenue, net debt ≤ 5 years of FCF, shares
up ≤ 15% a year. Clean run (441 of 441):

| version | 2024 → /yr | worst drop | 2023 | 2024 | 2025 | 2026 (9 mo) | years won | pass |
|---|---|---|---|---|---|---|---|---|
| Strongest 10 quality leaders | +46.0% | −10.6% | +21.9% | +57.6% | +57.9% | +13.7% | 3 | PASS |
| **Strongest 10 quality, oil rule** | **+47.9%** | **−10.6%** | +21.5% | +57.6% | +57.9% | +17.8% | 3 | **PASS** |
| Strongest 20 quality, oil rule | +41.6% | −8.0% | +14.2% | +43.6% | +62.5% | +11.6% | 2 | fail |

Oil companies in the strongest-10 basket: 0.6 a month on average. Today COP,
OXY, PSX and VLO pass under the oil rule; XOM (no annual operating cash flow
under the known tags) and APA (no revenue under the known tags) still read
"no data". **Adopted 2026-10-20 (owner):** Leaders lists only cash-flow
passers (standard rule, oil rule for oil groups, funds exempt), and the
strongest-10 basket is logged forward in `basket_record`.

## 2026-10-20 — the weakness test (price + annual-report facts vs a 30% fall)

Owner: "find stocks that also indicate weakness and thus likely will go
down". Pre-registered (preregistration.md, "the weakness test"): nine facts
at each month start, outcome = a ≥ 30% fall to a later low within 126
trading days; pass = lift ≥ 2×, caught ≥ 30%, 6M median ≥ 5 points under
the universe. 544 tickers, 523 with SEC data, 22,455 stock-months (train
7,415 / test 15,040); base rate 6.8% train, 10.8% test. **FAIL.**

Test (2024 →), the chosen threshold and the rest:

| flag | months | fell 30% | lift | caught | 6M median (universe +4.6%) |
|---|---|---|---|---|---|
| score ≥ 1 (chosen on train) | 9,250 | 13.5% | 1.24× | 76% | +4.7% |
| score ≥ 3 | 2,408 | 20.1% | 1.85× | 30% | +4.5% |
| score ≥ 5 | 296 | 32.4% | 3.00× | 6% | +8.6% |
| crash (20%+ off the 20-day high) | 523 | 41.5% | 3.83× | 13% | +10.0% |
| stretched (35%+ above the 200-day) | 640 | 29.4% | 2.71× | 12% | +16.5% |
| negative free cash flow | 1,648 | 20.5% | 1.89× | 21% | +8.2% |
| dilution > 10% | 666 | 22.5% | 2.08× | 9% | +7.6% |
| leader + stretched (of 1,508 leader-months, base 11.1%) | 175 | 29.1% | 2.62× | 30% | +4.8% |

Reading: every strong flag raises the chance of a 30% fall **and** leaves
the median 6-month return at or above the universe — these facts find
volatile stocks, not falling ones (the same shape the upside signals had).
No price / business fact clears the mark on direction. One fact worth
stating on a row: a leader sitting 35%+ above its 200-day saw a 30%
drawdown in 29% of the following 6 months, 2.6× other leaders (the
existing "stretched" risk flag). Caveats: delisted names missing (hides
failures), ~4.5 years, one bull market. Consequence: research only; no
"Weak" label.

## 2026-10-20 — the insider / short-interest test (SEC Form 4 bulk + FINRA)

Owner: "Run it". Pre-registered (preregistration.md, "the insider /
short-interest test"). Form 4: 21 quarters (2021q1 → 2026q1; 2026q2+ not
yet published), 510 issuers with open-market trades; FINRA short interest
for 523 symbols (history to 2017). 21,573 stock-months (train 7,121 / test
14,452), base rate 10.8% test. **FAIL on every flag.**

Test (2024 →):

| flag | months | fell 30% | lift | 6M median (universe +4.4%) |
|---|---|---|---|---|
| I1 insider sell cluster (≥ 3 sellers, no buyer, 90 d) | 4,543 | 10.7% | 0.96× | +4.7% |
| I2 insider net selling (≥ 10× bought, ≥ $1M, 180 d) | 9,094 | 10.7% | 0.95× | +4.3% |
| I3 insider buy cluster (mirror, ≥ 2 buyers) | 539 | 12.6% | 1.12× | +4.3% |
| S1 short interest up ≥ 50% in 3 months | 1,297 | 15.1% | 1.35× | +4.8% |
| S2 shares short ≥ 10% of shares out | 576 | 29.2% | 2.60× | +14.8% |
| S2 + weakness ≥ 3 | 300 | 35.7% | 3.18× | +17.5% |
| I1 + weakness ≥ 3 | 416 | 25.0% | 2.23× | +4.7% |
| leader + I1 or I2 | 1,212 | 11.3% | 1.01× | +5.8% |

Reading: insider selling carries **no** information on this universe — a
sell cluster's drop rate and 6-month return equal the universe (sales are
mostly compensation / diversification); insider buying (the
better-documented effect) gives +4.3% vs +4.4%, nothing, on 539 months.
Heavy short interest raises the chance of a 30% fall 2.6× **and** triples
the typical 6-month return (+14.8%): squeezes — volatility, not direction,
the fourth test with that shape. Consequence: research only; no
"insiders selling" / "heavily shorted" label. Data loaders
(`scripts/lib/form345.mjs`, `scripts/lib/finra.mjs`) stay for later tests.

## 2026-10-26 — the Fade Screen test (owner spec, 2026-10-26: "Go")

Pre-registered (preregistration.md, "the Fade Screen test" + the same-day
addendum: factor 5 from SEC submissions, the "raised within 6 months"
outcome). Universe built from SEC public-float frames ($100M–$2B in any
mid-year frame 2022–2025): 1,982 filers with a listed ticker → 678
pre-revenue today (annual revenue < $25M or none) → 658 with ≥ 300 daily
bars. Form 4: 21 quarters, 515 issuers with trades; FINRA short interest
655 of 658 symbols; SEC submissions 658 of 658. Stock-months at SPY month
starts, point in time: 12,094 (train 3,153 / test 8,941), 570 tickers.
Base rates on test: fell 40% within 6 months 24.4%, doubled 13.9%, 6M
median +0.8%. Workflow run 40352484409 (`fade-test` artifact).

**Verdict on the pre-registered mark (test, score ≥ 70): FAIL.** Three of
the four conditions pass, the doublers condition fails.

| condition (test, 2024 →) | required | found |
|---|---|---|
| months flagged | ≥ 100 | 246 |
| fell 40% within 6 months | ≥ 2× base (48.8%) | 57.7% (2.37×) |
| doubled within 6 months | ≤ base (13.9%) | **32.9% (2.37×)** |
| 6M median vs universe | ≥ 10 pts under | −22.2% vs +0.8% (23 pts) |

Per factor and tier on test:

| flag | months | fell 40% | doubled | caught | 6M median |
|---|---|---|---|---|---|
| score ≥ 70 (actionable) | 246 | 57.7% | 32.9% | 6.5% | −22.2% |
| score ≥ 50 (watch) | 1,683 | 50.6% | 28.5% | 39.1% | −17.2% |
| score ≥ 30 (caution) | 3,327 | 43.3% | 25.5% | 66.1% | −9.6% |
| 1 shorts pressing (SI up + price down) | 692 | 44.1% | 23.8% | 14.0% | −11.0% |
| 1 shorts up, price not down | 2,128 | 21.5% | 12.1% | 21.0% | +3.1% |
| 2 failed catalyst (mechanical) | 2,560 | 45.5% | 26.6% | 53.4% | −12.5% |
| 3 runway < 3 q | 2,768 | 41.0% | 24.0% | 52.1% | −7.5% |
| 4 CEO / CFO sale, no buy | 901 | 29.3% | 17.8% | 12.1% | −0.6% |
| 5 shelf / ATM on file | 4,276 | 32.6% | 18.3% | 63.9% | −1.7% |
| 6 trend break | 1,622 | 36.2% | 19.9% | 26.9% | −6.5% |
| 1 + 2 | 305 | 55.4% | 32.5% | 7.7% | −18.4% |
| 3 + 5 | 2,239 | 43.6% | 24.5% | 44.8% | −8.8% |

Train (< 2024) has the same shape on 33 actionable months (57.6% fell,
30.3% doubled, −13.3% median).

Reading. Unlike the weakness and insider tests, this score **does** point
down: the typical actionable stock is 22% lower six months on, and the
40%-fall rate is 2.4× the universe — the first direction signal any of the
tests has found. But one actionable stock in three also **doubles** inside
the same six months (2.4× the universe's rate, the opposite of the
pre-set condition), so the flag selects violent stocks, not just falling
ones. A long put at the spec's size would be stopped out or run to zero
on that third; the spec's trade cannot be called supported. Factors 1 + 2
(shorts pressing + failed catalyst) carry almost all of it; insider
selling (factor 4) adds nothing again (−0.6% median, 1.2× fall rate),
and factor 5 (a shelf on file) is on 64% of fallers but also on nearly
half the universe. Short interest rising while the price holds (the
"shorts up only" row) is mildly **positive** (+3.1%, fewer falls than
base).

Raised within 6 months (test; base 33.6% of stock-months): runway < 5 q
51.0% (1.52×; pre-set ≥ 2× — **not met**), runway + shelf 55.9% (1.66×;
pre-set ≥ 3× — **not met**), score ≥ 70 62.2% (1.85×). Lead time: of
1,829 raises on test, 68% had the runway flag lit at the prior month start,
but the median lead from the flag's first month is 440 days — the flag
stays on for over a year, so it is a description of the company (it burns
cash) rather than a timing signal; the stock fell a median 39.9% over that
lead and a median 3.2% in the raise week. A raise can be told early only
as "this company will raise at some point", which is already public from
its balance sheet.

AIRJ (the spec's worked example), scored mechanically month by month: 0 in
Feb–Mar 2024 while it fell 53% over the next six months; 40–50 through
mid-2024 (fell 47–55%); its only 70 was Dec 2025, after which it rose 84%.
The walkthrough in the spec does not reproduce from the inputs as
defined.

Caveats: survivors only (delisted names missing — the true faller rate is
higher, and the doubler share among all names somewhat lower, but the
survivor doublers are real); factor 2 is the mechanical event test, no
milestone ledger; factor 5 is shelf / supplement only; FINRA data is
bi-monthly and lags; one bull market in the test period.

Consequence (as pre-registered): no Fade Screen tier, label or put trade
ships. The failed-catalyst and shorts-pressing facts could be shown as
**risk facts** on a holding (wording like the risk flags, never a verdict)
if the owner wants them — a separate decision. Modules
(`src/utils/fade.js`, `scripts/lib/secUniverse.mjs`,
`scripts/lib/secFilings.mjs`) stay for later tests. Owner also asked
about delisted-inclusive price data: this result does not justify buying
it (the failure is the doublers, who are in the data).

### 2026-10-26, follow-up variants (owner: "Exclude flagged months with a dated binary … Drop insider selling and the shelf flag, re-weight to the two factors that carry it")

Pre-registered the same day (preregistration.md, second addendum). Run
40358351354. Binary-prone industries by SEC SIC code (pharma / diagnostics
/ biologics / bio research; vehicles / aircraft / parts / space) = 34% of
test months (SIC known for 94%). Same four conditions on each flag.

| flag (test, 2024 →) | months | fell 40% | base | doubled | base | 6M median | universe | verdict |
|---|---|---|---|---|---|---|---|---|
| A  score ≥ 70, **not** binary-prone | 118 | 57.6% | 15.2% | **37.3%** | 9.4% | −23.4% | +2.2% | FAIL |
| A' score ≥ 70, binary-prone | 128 | 57.8% | 42.2% | 28.9% | 22.7% | −19.6% | −7.9% | FAIL |
| B  two factors (catalyst 25 + SI ≥ 10) | 953 | 50.6% | 24.4% | 28.2% | 13.9% | −17.2% | +0.8% | FAIL |
| B' two factors, both full | 305 | 55.4% | 24.4% | 32.5% | 13.9% | −18.4% | +0.8% | FAIL |
| C  two factors ≥ 70, not binary-prone | 452 | 49.8% | 15.2% | 31.4% | 9.4% | −17.2% | +2.2% | FAIL |
| C' both full, not binary-prone | 152 | 56.6% | 15.2% | 34.2% | 9.4% | −19.6% | +2.2% | FAIL |

Actionable months by SIC (n · doubled · fell): 2834* 70·15·41, 2836*
42·16·21, 3569 13·3·10, 3690 9·4·5, 7371 8·2·5, 3841 7·4·5, 4522 7·3·7
(* binary-prone).

Reading. **Both hypotheses are rejected.** Outside the binary-prone
industries the doubler rate is *higher* relative to its base (37% vs 9%,
4×), so the doublers are not FDA dates, certifications or first deliveries;
they are the same violent names doubling on anything. Dropping the four
weaker factors moves nothing: the two carrying factors alone double at 2×
base (28–33%) exactly as the full score did. Per the owner's pre-set rule
("if that doesn't move the doubler rate, it confirms this is
variance-finding, not direction-finding"), **the scored version is closed.**
What ships (owner, same day): the two facts as dated sentences on a holding
and the milestone ledger, no score, no tier, no verdict —
`docs/holdings/milestone-ledger.md`.

### 2026-10-26, the long-side inverse (owner spec v2: "pre-register and test the long-side inverse … before any of it is shown to a holder")

Pre-registered the same day (preregistration.md, third addendum). Run
40360314832. Catalyst held = the latest event day ≥ 20 sessions back with
no close since below its close; shorts covering = SI down ≥ 15% vs the
settlement ≥ 30 days earlier while the close is up ≥ 10%. Pass: doublers
≥ 2× base, fallers ≤ base, 6M median ≥ 10 points **above** the universe,
≥ 100 months.

| flag (test, 2024 →) | months | fell 40% | base | doubled | base | 6M median | universe | verdict |
|---|---|---|---|---|---|---|---|---|
| D  held + covering | 8 | 50.0% | 24.4% | 25.0% | 14.0% | +9.4% | +0.9% | INCONCLUSIVE |
| D1 catalyst held alone | 102 | 40.2% | 24.4% | 11.8% | 14.0% | +2.1% | +0.9% | FAIL |
| D2 shorts covering alone | 318 | 29.6% | 24.4% | 19.8% | 14.0% | −8.3% | +0.9% | FAIL |
| D' both, not binary-prone | 4 | — | — | — | — | — | — | INCONCLUSIVE |

Reading. The pair almost never co-occurs (8 months in two years), so the
inverse as specified cannot be read. Each half alone fails in the wrong
direction: a catalyst that **held** 20 sessions is followed by *more* 40%
falls than the universe (40% vs 24%) and fewer doublers; shorts covering
into a rising price is followed by a −8% median. Nothing long-side is
shown to a holder, as pre-registered; the card stays the ledger plus the
two risk facts. **The Fade Screen test series is closed** (primary, two
follow-ups, inverse — all recorded above).
