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
