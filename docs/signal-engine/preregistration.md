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

## Added 2026-10-05 (after the Triple result): cross-sectional momentum

Recorded before the code ran. The owner asked whether the Bravo / Echo /
Tango suite is "advanced enough"; the honest answer is that every
chart-pattern entry tested so far (confluence, buy zone, Bravo, Hardening,
Triple, recovery) has landed on the random-entry control, and that the one
entry family with out-of-sample academic support is slow momentum. So it
joins the test as a **secondary rule**, measured by the identical machinery:

- **Rule:** at each completed month end, score every ticker in the
  universe with ≥ 12 months of history by its return over the 12 months
  ending one month earlier (12-1); eligible = close above its 200-day
  average; the **top decile** of the eligible names (at least 30 scored
  that month) are the entries. The replay buys the next open, same call
  (0.75Δ, ~2 years), same exit playbook, one open trade per name.
- **Controls:** SPY same-date paired, 200 random-entry replications (same
  count per month), monthly DCA — all at the calibrated premium, slippage
  tiers, dividends, open trades at their mark. Same periods, same sample
  floor, same CI method.
- **Reading:** it does not change the primary rule or the verdict, which
  stay on the buy setup. If momentum clears its controls in both periods
  under the bar above and the buy setup does not, the consequence is the
  one already recorded for "no edge" on the chart signals, plus: the
  Charts list may lead with the momentum ranking after the walk-forward
  and the delisted-inclusive check — still never a live change from one
  run.
- **Known weaknesses, recorded now:** survivorship (the universe is
  today's names — momentum losers that delisted are missing, which flatters
  the *control* as much as the rule), a ~560-name universe rather than the
  whole market, five years of history (two bull periods), and no
  transaction-cost model beyond the slippage tiers.

## Added 2026-10-05 (after the momentum result): the index call as a rule

The first momentum run showed every single-name rule, momentum included,
well behind the SPY call bought on the same dates (+77% per trade vs +38%
momentum and +19% buy setup, all trades, calibrated premium). That column
is a control, not a rule, so the index call joins the test as a rule of
its own, recorded before it runs:

- **Rule:** buy the SPY 0.75Δ ~2-year call at each completed month end;
  same exit playbook; one open trade at a time (a month end while a trade
  is open is skipped).
- **Controls:** random entries on SPY (same count per month) and monthly
  DCA on SPY. The SPY-same-day paired control is the rule itself and reads
  zero by construction.
- **Reading:** the comparison that matters is this rule against the
  single-name rules on the same card, period by period, and its P1 (2022–
  23, a down year then a recovery) against P2. It does not change the
  primary rule or the verdict. If it keeps beating the single-name rules
  in both periods, the product consequence already follows from the "no
  edge" clause: the index / sector call plus the exit playbook is the
  claim, and single-name timing is context.
- **Displayed from today:** Charts shows the SPY and QQQ calls picked by
  the same contract rules above the sector ideas, with one sentence from
  this test. That is disclosure of what was measured, not a new rule.
- **Known weaknesses:** one bull market with one drawdown; a long-dated
  index call's result is mostly the index's drift times leverage, so a
  bear period would reverse the sign; survivorship does not apply to SPY
  but does flatter the single-name rules it is compared with.

## Added 2026-10-05 (owner: "swing trades, exit at pre-determined high prices"): the swing exit

The owner's framing, recorded before the run: the goal is not to beat a
random day. It is to **identify a swing in a stock, buy the LEAPS, and sell
when the stock reaches a price set at entry.** The existing export already
says the entries find swings — in 2023–2025, 80–90% of signal trades saw
the stock rise ≥ 10% inside the trade and 55–80% saw ≥ 20% — while only
~10% ever reached the exit playbook's first target (+100% on an 18-month
option) because the trade waited 500+ days for it. The mismatch is the exit,
so the exit is what this test changes. The entries are unchanged.

- **Rule (`exitRule: 'swing'`):** at entry, fix a stock price target. Exit
  the whole position at the option's marked value on the first close at or
  above the target; otherwise at a time cap; a stock stop is a variant.
  Instrument unchanged (0.75Δ, ~2-year call at the calibrated premium).
- **Grid (16 variants, all reported, none chosen in advance):**
  target ∈ { +10%, +15%, +20% above the entry price, **pivot** = the
  nearest confirmed swing high above entry (a high with ≥ 10 bars after
  it — known at entry; +15% when none sits within 40%) } ×
  hold cap ∈ { 63, 126 trading days } × stop ∈ { none, stock −8% }.
- **What is measured:** target hit rate; median days to the target; mean
  and median option return with every trade counted (open at mark);
  share lost ≥ 50%; expectancy = hit rate × mean hit return + miss rate ×
  mean miss return. By period P1 / P2 and **by signal year**, since the
  owner suspects the five-year look-back is too long: the last two years
  are reported on their own.
- **Controls, kept but secondary:** random entries in the same months
  with the same swing exit, so a bull-market hit rate is not mistaken for
  selection. The owner's question is the hit rate and the expectancy; the
  control is reported beside them, not in front of them.
- **Reading:** a variant is worth a live test when its hit rate is above
  60% in both periods, its expectancy is positive in both, and the
  neighbouring variants (±5% target, the other hold cap) agree within
  ~10 points. The Signal record card shows the grid; the Replay card gets a
  **Swing** sell option (pivot target, 126-day cap, no stop) so a single
  chart can be read the same way. Nothing changes live until the owner
  adopts a variant after that reading.
- **Known weaknesses:** no stop means a miss rides to the cap; the pivot
  target depends on a swing high existing above entry; five bullish years
  inflate every hit rate, which is what the random control is for.

**Amendment, same day, before the grid was read** (owner: "if options are
using leverage these targets may be met on 10–15% increases"): three
option-gain targets join the grid — exit when the call's mark reaches
**+25%, +50% or +75% of cost** — with the same hold caps and stops (28
variants in all). The two-ticker offline run already showed the leverage
these imply: a +10% stock move returned ~+17% on the call after slippage,
+15% ~+27%, +20% ~+40%. Reading rule unchanged.

**Amendment, same day, after the first grid was read** (owner: "we don't
want to hold for more than 2–18 months"): the hold caps become **2, 6, 12
and 18 months** (42 / 126 / 252 / 378 trading days; the 18-month cap
coincides with the playbook's time stop on a 2-year call), replacing 3 and
6 months — 56 variants. The first grid's reading stands as recorded: hit
rates were high (59–79% on the buy setup, 68–74% on momentum in 2023–25
at a +25% call target) but misses cost more than hits earned, an 8% stock
stop made every variant worse, and 2022 lost a third per trade on every
version — a bull-market plan that needs a regime gate, tested next. This
amendment widens the window; it does not change the reading rule.

**Amendment, same day, after the second grid was read** (owner: "Sure" to
the regime gate): every swing variant also runs **gated** — entries count
only when SPY closed above its 200-day average on the signal day (112
variants). What was read before this change, so it can't be fitted after:
with the owner's 2–18 month window, momentum entries selling the whole
call at +50% / +75% with a 12-month cap and no stop hit 60% / 52% and
averaged +17% / +24% per trade, positive in 2023, 2024, 2025 and 2026 and
−21% to −23% in 2022; the buy setup carried none of this; two-month caps
were ~zero; the pivot target hit 80% for +18%. **Reading the gate:** it is
worth paper trading if it removes most of 2022's trades while keeping
2023–25's average within ~5 points, *and* the gated hit rate and average
hold in the last two years. A gate that merely trims trade count in every
year is noise.
