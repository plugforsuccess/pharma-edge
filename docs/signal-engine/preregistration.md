# Signal engine — pre-registered test plan

Recorded 2026-10-05, **before** the matched controls, the implied-vol proxy or
the trade export existed in the code. This file is the decision rule. It is
not edited after the results are in; a change of mind is a new, dated section
below the original, with the reason.

## The question

Does the buy-zone entry (all five conditions on the same day, 200-day rising,
2+ confluence signals) earn more than a matched alternative that has no
timing information, once the option is priced and filled realistically?

## What is measured

**Unit:** one replay trade — a ~730-DTE call at 0.75 delta bought at the open
after the signal close, exited by the exit playbook (70% at +100%, 15% at
+200%, 30% trail, time stop at 6 months to expiry), one position per ticker
at a time. **Open trades count at their mark on the last bar.** Completed
trades are also reported on their own.

**Metric:** mean option return of strategy trades **minus** the mean under
a control built identically (same construction, same exits, same pricing,
same slippage). Reported alongside: median, share lost ≥ 50%, win rate.

**Controls**
1. *Primary — SPY LEAPS, same dates.* For every strategy trade, the same
   call on SPY entered on the same date. Measures what the timing is worth
   over simply being long the market with the same instrument.
2. *Secondary — random entries, same ticker.* Entries drawn at random on the
   same ticker with the same number of entries per calendar month, under the
   same one-position rule. **200 replications**; the strategy is compared
   against the distribution, not one draw.
3. *Reference — monthly DCA* into the same LEAPS on the same tickers: the
   product's real alternative for a monthly contributor. Reported, not a
   gate.

**Pricing used for the verdict.** Implied-vol proxy: IV ≈ premium × (0.3 ×
RV60 + 0.7 × RV252), premium calibrated on the tickers with real IV history,
vol held sticky through the trade, dividends and the risk-free rate in
Black–Scholes. Slippage tiered by dollar volume (2% / 4% / 7% per fill),
every fill counted. Results are reported at premium ∈ {1.0, 1.1, 1.2, 1.3};
**the verdict is read at the calibrated premium**; the 1.0 row is labelled
the optimistic case. The step-2 verdict is not read before the proxy is in,
because the low-vol filter and realized-vol pricing are correlated and bias
the comparison in the strategy's favour.

**Uncertainty.** 95% confidence interval from a bootstrap clustered by
**signal month** (trades on nearby dates are not independent), 2,000
resamples.

**Periods.** Two disjoint periods by signal date, both required:
P1 = 2022-01-01 → 2023-12-31; P2 = 2024-01-01 → the run's as-of date.
Also the whole sample, and a bucket by the **market's return over each
trade's own holding window** (SPY < 0% · 0–20% · > 20%), because signal-year
buckets leak the following year's rebound into "2022".

**Sample floor.** A period with fewer than 150 strategy trades or fewer than
20 distinct signal months is *inconclusive* whatever the numbers say.

## Decision rule

Against the primary control, at the calibrated premium, open trades included:

| Verdict | Condition |
|---|---|
| **Edge** | CI lower bound > 0 in **both** periods, **and** the strategy's mean sits at or above the 95th percentile of the random-entry distribution in both periods, **and** share lost ≥ 50% is not more than 5 points worse than the control in either period. |
| **No edge** | Point estimate ≤ 0 in **either** period, **or** CI upper bound ≤ +10 points of option return in both periods. |
| **Inconclusive** | Anything else (e.g. CI spans zero with an upper bound above +10 points; edge in one period only; sample floor not met). |

The market-regime buckets are reported with the verdict and do not change
it (the SPY < 0 bucket is small); they are evidence for the next step, not
a gate.

## Consequences, fixed in advance

- **Edge** → justifies buying delisted-inclusive price history (survivorship
  is the next test). **No live rule changes on this result alone**: the
  missing delisted names are exactly the wrecks this rule buys, so the edge
  must survive that data before any rule moves.
- **No edge** → stop adding indicators to the entry. The trend-quality
  gates and the indicator ablations still run, as a search for an edge, not
  a confirmation of one. The product's claim becomes disciplined LEAPS
  construction and risk rules, not entry timing, until a test says otherwise.
- **Inconclusive** → the trend-quality gate and stop/portfolio tests run
  next; no live rule changes.

## Bar for changing any live rule (unchanged from the review)

All of: edge against the matched control in both periods with a CI excluding
zero; share lost ≥ 50% not worse; ≥ 150 trades and ≥ 20 signal months per
period; neighbouring thresholds keep ≥ 70% of the improvement; holds under
the IV proxy and slippage tiers; holds on delisted-inclusive data; consistent
with 60–90 days of paper trading on live quotes.

## Variant log

Every rule variant tested is appended to `docs/signal-engine/variants.md`
with its date, grid, folds and result, so winners can be discounted by the
number of tries (White's Reality Check / deflated Sharpe when the count
grows). Two test periods, both mostly bullish, will produce a winner by
chance given enough tries.

## Trade export fields (so later tests need no re-run)

Per trade: ticker, signal date, fill date, fill price, strike, cost, vol used
and its source (real IV / proxy / RV), exit reason, exit date, days held,
option return, stock return, best stock move inside the trade, SPY return
over the holding window, drawdown from the 252-day high at entry, days since
the 200-day slope turned positive, confluence score and which signals fired,
whether IV Rank came from real IV or the HV stand-in, slippage tier.

## Data collection started alongside

A nightly job stores, for every ticker in the universe, the ATM 30-day IV
and the **bid / ask / mid of the ~0.75-delta, ~2-year call**, so the IV
proxy and the slippage tiers calibrate on the app's own quotes within a few
months instead of staying guesses.
