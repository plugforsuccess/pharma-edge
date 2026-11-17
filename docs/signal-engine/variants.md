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

### 2026-10-26, the two research gaps (owner: "Make changes")

Run 40382557061, same universe and factors. **Survivorship, sized:** 770 of
2,752 float-range filers (28%) have no listed ticker today — delisted,
acquired or gone dark — and none of them is in any table above. Every
faller rate recorded here is a floor. (Buying delisted-inclusive prices
would raise the faller rates; it cannot lower the doubler rates, which are
among the survivors.) **By calendar year, score ≥ 70 vs the universe:**

| year | months | flagged | fell 40% | base | doubled | base | 6M median | universe |
|---|---|---|---|---|---|---|---|---|
| 2022 (down year) | 447 | 4 | 75.0% | 41.4% | 25.0% | 4.5% | −21.1% | −22.5% |
| 2023 | 2,706 | 29 | 55.2% | 26.8% | 31.0% | 8.6% | −13.3% | −2.4% |
| 2024 | 3,234 | 59 | 66.1% | 28.6% | 35.6% | 10.4% | −38.0% | −4.8% |
| 2025 | 4,074 | 142 | 54.2% | 22.5% | 33.1% | 17.4% | −14.1% | +4.4% |
| 2026 (open) | 1,633 | 45 | 57.8% | 20.8% | 28.9% | 12.2% | −28.6% | +4.2% |

Reading. The shape is the same in every year: fallers at roughly 2× base,
doublers at 2–5× base, the median under the universe. 2022 has only 4
flagged months (the universe starts in 2022 and the look-backs eat most
of it), so the down-year reading rests on 2023's first half more than on
2022 itself; in a year where the universe median was −22.5%, the flag's
−21.1% added nothing. The doubler rate is highest in the strongest years
(2024–25), consistent with the variance reading. Nothing here reopens
the closed verdict.

### 2026-10-26, the straddle test (owner: "how am I supposed to use this to profit?" → "Start it")

Pre-registered the same day (preregistration.md, "the straddle test"):
if the flagged names fall 2× as often **and** double 2× as often, the
tradeable claim is not direction but *movement* — so buy both sides.
An at-the-money call + put on the flag day, Black-Scholes on 60-day
realised vol × a premium (1.0 / 1.3 / 1.6 — real IV on these names sits
above trailing vol), 2% slippage each way, 126-day expiry; variant: out
at 2× the premium paid, marked daily. Pass: the flag's average straddle
return ≥ 10 points above the universe control on ≥ 100 months at the
1.3 premium, held to expiry. Run 40391936751, `src/utils/straddle.js`
(`npm run straddle:check`).

| rows (test, 2024 →) | premium | exit | n | avg | median | win | lost ½ |
|---|---|---|---|---|---|---|---|
| universe control | 1.3 | expiry | all | −18.6% | −45.7% | 24% | 47% |
| **B' both facts lit** | **1.3** | **expiry** | **305** | **−37.6%** | **−55.7%** | **18%** | **54%** |
| universe control | 1.3 | 2× target | all | −20.6% | | | |
| B' both lit | 1.3 | 2× target | 305 | −24.4% | | | |
| B' both lit | 1.0 | expiry | 305 | −21.3% | −46.2% | | |
| scan definition (20 sessions below, SI +15%, price −10%) | 1.0 | expiry | — | −18.9% | | | |
| universe control | 1.0 | 2× target | all | −0.2% | | | |
| B' both lit | 1.0 | 2× target | 305 | −4.7% | | | |
| scan definition | 1.0 | 2× target | — | −9.1% | | | |
| B' both lit | 1.6 | expiry | 305 | −47.5% | | | |

Train (< 2024) has the same shape: B' at 1.3 to expiry −40.1% on 50
months. **FAIL (primary).** Long volatility on the flagged names loses
*more* than the universe at every premium and every exit — the gap runs
19 points the wrong way at the pre-set premium. The moves the Fade
Screen finds are already in the option price: a name that has doubled
or halved one time in three carries the implied vol to match, and the
one-in-three doubler does not pay for the two-in-three that bleed
premium. Only an optimistic premium (1.0 — the option priced at trailing
realised vol, which these names never trade at) with a 2× take-profit
gets the universe to break-even, and the flag still trails it. Nothing
long-vol ships; `/charts/tape` stays a watch list of facts (the same
rows the risk facts show on a holding), with no play attached. That
closes the profit question the owner asked: the information says which
holdings are not holding their story, not which options to buy.

### 2026-10-27, the second jump (owner: "use the losers list and wait for a positive milestone then buy then ride up" → "Run it")

Pre-registered the same day (preregistration.md, "the second jump").
Run 40453079474, `src/utils/secondJump.js` (`npm run secondjump:check`).
Shares bought at the open after a jump (≥ 10% on ≥ 3× volume) on a stock
that was on the tape list (scan definition) on one of the 60 sessions
before; one jump per stock per 21 sessions.

| test, 2024 → | n | 21-session median | 63 | 126 | avg 126 | higher at 126 | fell 40% | doubled |
|---|---|---|---|---|---|---|---|---|
| **listed: second jump** | **175** | **−13.3%** | **−24.0%** | **−39.4%** | −22.1% | 25% | **71%** | 28% |
| listed, short ≥ 15% of shares | 44 | −15.4% | −10.5% | −31.5% | −20.1% | 25% | 61% | 25% |
| listed, short < 15% of shares | 118 | −11.9% | −26.1% | −40.1% | −23.5% | 23% | 75% | 28% |
| control A: jumps not listed | 877 | −3.8% | −7.2% | −12.4% | +10.7% | 39% | 45% | 25% |
| control B: any day | 8,955 | +0.1% | +0.3% | +1.0% | +10.1% | 51% | 24% | 14% |

The +40% target exit: listed median +0.3% (hit 47%) vs +7.6% on other
jumps. By year (126-session median, listed vs not listed): 2023 −8.8% vs
−19.8% (16 jumps), 2024 −40.1% vs −14.9%, 2025 −29.1% vs −6.6%, 2026
−46.8% vs −9.4%. Train (< 2024) has only 19 listed jumps: −14.1% median,
68% fell 40%.

**FAIL (primary).** The second jump on a listed stock is the worst entry
measured in the whole series: the typical one is 39% lower six months
on, 27 points under other jumps, and seven in ten fall 40% or more,
three times the any-day rate. High short interest does not rescue it
(−31.5%, 61% fell): the squeeze reading is not in the data. The doublers
are real and huge — DBVT +960%, CAPR +314%, QBTS +199% — but one in four,
with no trait found that picks them in advance. The best 8 and worst 8
are in the job log.

Reading the same table from the holder's side (not the graded question,
stated as such): a listed stock's second jump has been followed by a
lower price in three cases of four at every horizon measured, starting
from the next open. For someone already holding one, the jump has more
often been the best price of the next six months than the start of a
run. Consequence as pre-registered: the list stays a watch list of facts,
nothing on it suggests a buy. Survivors only — the delisted names would
make every listed number worse.

### 2026-10-27, the bear side of the second jump (owner: "why not short or long put a stock on this list after a jump" → "Run it")

Pre-registered the same day (preregistration.md). Run 40458050754,
`src/utils/jumpBear.js` (`npm run jumpbear:check`). The same 175 listed
second jumps on test (2024 →), entered at the open after the jump; σ =
premium × 60-day realised vol on the jump day; 2% slippage per fill.

| test, 2024 → | n | avg | median | win | lost ½ | worst | verdict |
|---|---|---|---|---|---|---|---|
| **long put, 126d, prem 1.3** (primary) | 175 | −14.1% | −14.9% | 42% | 39% | −100% | **FAIL** (2024 −15%, 2025 −21%, 2026 +5%) |
| long put, 63d, prem 1.3 | 175 | −15.5% | −26.3% | 37% | 43% | −100% | |
| long put, 126d, prem 1.6 | 175 | −27.6% | −28.8% | 37% | 43% | −100% | |
| **put spread, 63d, prem 1.3** (primary) | 113 (62 skipped, debit > 40%) | −5.3% | −25.6% | 39% | 38% | −98% | **FAIL** (2024 −9%, 2025 −10%, 2026 +8%) |
| put spread, 63d, prem 1.6 | 92 | −13.6% | −29.9% | 32% | 39% | −94% | |
| short, borrow 30%, stop +50% | 175 | −19.6% | −6.2% | 49% | 43% | −373% | |
| **short, borrow 30%, stop +100%** (primary) | 175 | −10.9% | +14.6% | 59% | 25% | −373% | **FAIL** (2024 −18%, 2025 −11%, 2026 +1%) |
| short, borrow 30%, no stop | 175 | +3.6% | +21.2% | 64% | 15% | −998% | |
| short, borrow 100%, any stop | 175 | −31% to −45% | | | | | |

The same trades on jumps in stocks not listed (control A) did far worse
every time — long put 126d −32.5%, spread −11.6%, short with +100% stop
−28.5% — so the list carries real information about direction. It is
not enough to pay for the trade. **All three primaries FAIL.**

Reading. Puts: the post-jump premium is about what the typical drop
delivers; the put wins 42% of the time and loses half or more 39% of the
time. Spread: the 40% debit cap skips a third of the jumps (vol is too
high to buy a spread that cheap), and the −50% stop fires on 40%.
Short: the typical short makes money (median +14.6%, 59% win), but the
+100% stop fires on one in five and each one costs 100%+; without a stop
the average turns barely positive (+3.6%) only by riding DBVT to −998%,
which no account survives. At a 100% borrow fee every short loses.
Stops hurt the short here as they hurt every swing variant before. The
only positive rows are the no-stop short at 30% borrow (not a primary,
fatal tail) and 2026 alone (35 jumps, open year). Nothing ships;
survivors only, so the true bear-side numbers are somewhat better than
these — not enough on this evidence to change a fail into a pass.

### 2026-10-28, the bear side on list entry (owner: "it's your job to figure an algo to short or long puts" → "ensure these stocks have enough volume to trade options")

Pre-registered the same day, addendum 1 before any result (preregistration.md).
Run 40768205647. Entry = the open after the first session a stock lands on the
list (scan definition) after 63 sessions off it; same pricing as the 2026-10-27
bear test. Graded on the options-tradeable subset (close ≥ $3, 20-day dollar
volume ≥ $10M).

The stock after list entry (test, 2024 →): all 189 — median −3.6% / −7.8% /
−17.6% at 21 / 63 / 126 sessions, 49% fell 40%, 25% doubled (any day: +0.9%,
24%, 14%); tradeable 62 — −2.6% / −0.0% / −8.7%, 42% fell 40%, 27% doubled.

| test, 2024 → | set | n | avg | median | win | verdict |
|---|---|---|---|---|---|---|
| **long put 126d, prem 1.3** | tradeable, 2% slip | 62 | −49.1% | −78.9% | 21% | **INCONCLUSIVE** (< 100) |
| same | tradeable, 5% slip | 62 | −52.0% | −80.2% | 16% | |
| same | all list entries | 189 | −41.6% | −53.9% | 24% | |
| **put spread 63d, prem 1.3** | tradeable, 2% slip | 58 (13 skipped) | −21.6% | −51.3% | 28% | **INCONCLUSIVE** |
| same | all list entries | 157 | −18.4% | −33.7% | 30% | |
| **short, borrow 30%, stop +100%** | tradeable, 2% slip | 62 | −35.3% | −12.3% | 42% | **INCONCLUSIVE** |
| same | all list entries | 189 | −44.7% | −3.3% | 48% | |
| short, borrow 30%, no stop | all list entries | 189 | −24.2% | −1.1% | 49% | |
| any-day control: put 126d / spread / short +100% stop | universe | ~9,000 | −38.5% / −19.1% / −28.0% | | | |

Reading. Inconclusive on the count (only 62 tradeable entries in the test
years), but no row is close: every instrument loses on average in every set,
at both slippages, and in train. The stocks do fall (−17.6% median at six
months, twice the any-day rate of 40% falls), yet the put priced at these
names' volatility costs more than the typical fall delivers, and one in four
doubles. The short's typical trade roughly breaks even before the doublers:
a 17.6% fall minus ~15% borrow for six months minus slippage. Nothing ships;
the list-entry bear side is closed with the second-jump bear side.

**Delisted filers (descriptive, same run).** 770 float-range filers have no
listed ticker today: **427 acquired (55%)**, 247 delisted other (many of the
pre-revenue ones are SPACs that merged or liquidated), **79 bankruptcies
(10%)**, 17 with no delisting filing. From the mid-year float filing to the
delisting: median 1.2 years (middle half 0.9–1.6). From the exchange's first
warning (8-K 3.01) to the delisting: bankruptcy median 196 days, delisted
other 285 days, acquired 0 days (the notice is filed at closing). Pre-revenue
only (434): 184 acquired, 25 bankruptcies, 215 other; warning → delisting
median 182 days. **Correction to earlier readings:** this series has called
the survivorship gap "the fallers the test cannot see" and every bear number
"a floor". Most missing names were bought out (usually at a premium — a loss
for a short) or were SPACs; bankruptcies are one in ten. The gap does not
clearly favour the bear side.

## 2026-11-14 — Short windows after a jump: results (run 43635097704, commit 66aeee9, addenda 1–4)

Pre-registered 2026-11-14 with addenda 1–4 (preregistration.md). Test = 2024 →.
Entries: E0 1,256 · E3 954 · E5 850 · D10 501 · any-day control 11,798.

**Path from the jump close (addenda 2–4)**: median change · share below the jump close.

| after | 2026 jumps | 2025 | test 2024 → | test · earnings | 2026 · earnings | 2026 · other | any day |
|---|---|---|---|---|---|---|---|
| 1W | −3% · 60% (378) | −3% · 57% | −2% · 58% | −1% · 56% (162) | −2% · 59% (69) | −3% · 61% (309) | 0% · 50% |
| 2W | −6% · 64% | −5% · 57% | −4% · 60% | −2% · 54% | −3% · 63% | −7% · 64% | 0% |
| 1M | −7% · 64% (355) | −6% · 57% | −6% · 61% | −4% · 56% | −6% · 61% | −8% · 65% | −1% |
| 2M | −10% · 65% (333) | −8% · 57% | −10% · 62% | −4% · 54% | −6% · 59% | −13% · 66% | −1% |
| 3M | −16% · 68% (315) | −9% · 57% | −11% · 62% | −5% · 56% | −6% · 62% | −18% · 69% | −1% |
| 6M | −23% · 64% (206) | −11% · 58% | −17% · 62% | −1% · 51% (136) | 0% · 49% (43) | −30% · 68% (163) | 0% |

Deepest drop so far (median), all test jumps: −11% by 1W, −19% by 1M, −29% by
3M, −39% by 6M (any day: −4% / −8% / −14% / −19%). Earnings tag = SEC 8-K 2.02
from jump −3 to +1 days; every ticker had filings (unknown = 0). **Reading:
the fade is the non-earnings jumps. Jumps on an earnings report hold at the
median (−1% at 6M, 2024 →); other jumps fall (−18%, 2026: −30%).** Descriptive,
no pass mark.

**Trades (graded primaries, 2024 →):**
- E3 put 42d, −20% take: avg −24.4%, median −6.1%, 911 trades → **FAIL** (2024 −18%, 2025 −34%, 2026 −19%). Every put variant at every entry loses on average.
- E3 short (−20% target / +50% stop / 63d, borrow 30%): avg −7.8%, median +13.1%, win 58% → **FAIL** (avg < 0 every year).
- E3 **bear call spread** (ATM / +1 expected move, 21 sessions, return on max loss): avg **+6.7%**, median **+28.0%**, win 74%, lost half 15%, 929 trades → **PASS** (2024 +11%, 2025 +2%, 2026 +7%; train +6.0%). E0 / E5 / D10 and the +½-move short strike land in the same place (+4.9% to +6.9% avg).
- E3 short stock + ATM call (unlimited risk): avg −4.9%, median +13.0% → **FAIL** (2026 −16%). The +50% stop makes it worse.

**Caveats on the pass:** (1) priced off the model (σ = 1.3 × 60-day vol, 2%
slippage per fill), not quotes — the credit is the whole edge, and these names
quote wide; (2) **no trade met the app's credit rule** (credit ≥ 60% of width:
0 of 929) — the ATM / +1-move spread collects well under that, so it fails the
spread rules as written; (3) 2025 is thin (+2%); (4) survivors only. Next step
before any use: price it on real chains (quotes on the forward jump record),
not the model. Changes no live rule; nothing shown to subscribers.

## 2026-11-14 — Non-earnings jumps (addendum 5) and what the gainers had in common (run 43648352006, commit ac227d2)

**Addendum 5 — trades on non-earnings jumps only (test 2024 →):**
- E3 put 42d, −20% take: avg −23.8%, median −6.2%, 808 → **FAIL** (2024 −16%, 2025 −32%, 2026 −21%). All jumps: −24.4%.
- E3 short: avg −7.4%, median +13.3%, 790 → **FAIL** (avg < 0 every year). All jumps: −7.8%.
- E3 bear call spread (ATM / +1 move, 21 sessions): avg **+7.2%**, median +27.9%, win 75%, lost half 14%, 826 → **PASS** (2024 +13%, 2025 +3%, 2026 +7%). All jumps +6.8%; earnings jumps +4.2% (115). E5 non-earnings +8.0% (740) vs earnings −1.1% (101).
Reading: focusing on non-earnings jumps moves the spread a little (+0.4 points at E3, more at E5) and does nothing for the put or the short. Same caveats as before: model prices, 0 trades meet the 60% credit rule.

**What the jumps that gained had in common** (gained = 6M close above the jump close; discovery 2024–25 n 886, 38% gained; check 2026 6M n 206, 36%):
- **Holds · more gain:** on an earnings report — 48% gained (+10) / 2026 51% (+15), median −3% / 0%.
- **Holds · fewer gain:** already down 50%+ over the 6 months before the jump — 25% gained (−13) / 2026 18% (−18), median −43% both.
- Known later — **closed above the jump close one week later:** 51% gained (+13) / 2026 49% (+13), median +1% / −1%; **below it after a week:** 28% (−10) / 26% (−9), median −28% / −34%. Next day above: +9 / +8.
- Didn't hold: jump size, volume multiple, close near the high, 200-day, price, dollar volume, cash runway, shelf, short interest, S&P trend, a prior jump. Binary-prone industry +4 / +10 (missed in discovery); under $2 +24 in discovery but +1 in 2026 (too few); S&P below its 200-day too few.
~35 buckets were tested, so one hit is expected by chance; two at the jump close plus the one-week fact is more than chance, and all three point the same way as the earnings split. Descriptive; changes no live rule.

## 2026-11-15 — Bear call spread with a stop (addendum 6, run 43691073447, commit c6715c0)

Non-earnings jumps, test 2024 →, closes only, model prices (vol held fixed). avg / median / win / lost half / stopped.

| E3 | avg | median | win | lost half | stopped | 2024 / 2025 / 2026 |
|---|---|---|---|---|---|---|
| no stop | +7.3% | +28.0% | 75% | 14% | — | 13 / 3 / 7 |
| 25% of max loss | +6.7% | +24.3% | 64% | 4% | 32% | 11 / 4 / 5 |
| **50% of max loss (graded)** | +6.5% | +27.0% | 72% | 21% | 20% | 12 / 3 / 5 → **PASS** |
| 75% of max loss | +6.8% | +27.7% | 74% | 16% | 12% | 12 / 3 / 6 |
| 2× the credit | +6.2% | +25.5% | 67% | 8% | 28% | 11 / 3 / 5 |

E5 the same shape: no stop +7.9%, 25% +7.0% (lost half 4%), 50% +6.9%, 75% +7.3%, 2× credit +6.8% (lost half 8%).
Reading: every stop lowers the average a little (−0.5 to −1.1 points) — it closes trades that would have recovered. The 50% stop
makes "lost half" worse (21% vs 14%: it locks in the loss on spreads that came back). The 25% stop and the 2× credit stop cut
the big losses sharply (4% / 8% lost half) for about −0.6 / −1.1 points of average and a lower win rate. The model holds vol
fixed, so real buy-backs on a rip cost more than shown — real stops look worse than this. Changes no live rule.

## 2026-11-17 — Jumps on bigger stocks, the missing factors, real quotes (runs 44013373568 / 44013373391 / 44014692459, commits 1df0e73 / 3c26971)

**Bigger stocks (chart universe, funds out; 523 with bars, all with SEC filings).** 569 jumps (test 2024 → 445, non-earnings 182). Path from the jump close — median · share below · down 20%+:

| after | non-earnings · test (182) | non-earnings · 2026 (51) | earnings · test (262) | any day · test |
|---|---|---|---|---|
| 1M | −1% · 53% · 16% | −3% · 57% · 13% | +1% · 45% · 4% | +1% · 46% · 2% |
| 3M | **+3% · 45% · 25%** | −11% · 60% · 34% | +1% · 47% · 9% | +2% · 45% · 7% |
| 6M | +4% · 47% · 26% | −19% · 69% · 46% | +3% · 47% · 15% | +4% · 41% · 10% |

**Q1 — NO FADE.** Non-earnings 3M median +3%, 45% below, same as any day (+2%, 45%). The tails are fatter (a quarter down 20%+ vs 7%) but the middle doesn't move. 2026 alone fades (−11% / −19%, n 35 / 26) — one weak year for jumpers, not the rule.
**Q2 — read as NO.** E3 non-earnings bear call: avg +2.8%, median +29.8%, win 67%, lost half 20%, 124 → FAIL (2024 +6%, 2025 −5%, 2026 +11%); at 5% slippage +0.6%. Any-day control −1.4% (17,596). Put 42d −27.9%, short −13.6%.
**Q3 — nothing holds** (2026 buckets mostly under 30). Earnings +2 / +11, closed above after a week +8 / +6, next day +8 / +7 — same direction as small caps, under the bar.

**Small caps, the new factors (Fade job).** cause, offering, earnings ahead, VIX, IWM trend, sale after: **none hold.** Offering-linked jumps (64) gained 31% (−7, too few in 2026); IWM below its 200-day +12 in discovery, 3 cases in 2026. Unchanged: on earnings → more gain (holds), down 50%+ before → fewer gain (holds); after a week above / below the jump close now holds both ways (+13 / +13 · −10 / −9).

**Real quotes, one night (Yahoo via the option-chain function, ~30 days, ATM / +1 move bear call):**

| | small-cap scan | bigger stocks |
|---|---|---|
| stocks · quoted both legs | 255 · 113 | 524 · 501 |
| mid credit ÷ formula | 0.84 | 0.92 |
| natural (bid/ask) ÷ formula | **0.00** | **0.72** |
| bid/ask gap ÷ mid credit | 2.00 | 0.40 |
| real IV ÷ formula vol | 0.98 | 0.88 |
| natural credit above zero | 44% | 93% |
| passes practical checks | 2% | 17% |

Reading: on bigger names the spread can actually be filled (most of the formula's credit survives at the natural price) — but there is no fade to sell there, so the edge isn't there either. On the small caps the fade is real but the credit disappears in the bid/ask. The formula's 1.3 × realised vol overstates bigger-stock IV by ~12%. One night only; changes no live rule.
