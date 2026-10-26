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

**Amendment 2026-10-05, after the third grid (112 variants) was read on
main** (owner: "Add it"). The random-entry control ran for the default
variant only (pivot target, 6-month cap), where every entry rule sat at or
below the random entries (momentum at the 4th percentile, +3% vs +4%).
The variants that led the grid — momentum entries, sell the whole call at
+50% / +75%, 12- or 18-month cap, no stop: +17% to +26% per trade, 2023–26
positive, 2022 −17% to −23% — had no control, so their average cannot be
split between the entry, the exit and the bull market. The control now
also runs, with 50 replications per ticker and the same random dates per
ticker across variants, for exactly those four ungated variants
(`SWING_CONTROL_KEYS`: `opt50:252:none`, `opt50:378:none`,
`opt75:252:none`, `opt75:378:none`), each against its own exit; gated
variants get none (the gate was neutral for momentum). **Reading, fixed
before the run:** a variant is a candidate for paper trading only if the
rule's average sits at or above the 90th percentile of its random
replications *and* beats the random average by ≥ 8 points per trade; at
the 50th–90th percentile the exit is doing the work and any entry would
do (then the question becomes the exit's own merit against the index
call); below the 50th the entry is selecting worse-than-random dates.
Nothing live changes on this result.

**Result, 2026-10-06 (run 37388507234, 545 tickers, calibrated premium),
read against the rule above.** Rule avg vs random avg per trade, and the
rule's percentile among 50 replications (random entries in the same
months, same exit, same random dates per ticker across variants):

| Entry | +50% · 12 mo | +50% · 18 mo | +75% · 12 mo | +75% · 18 mo |
|---|---|---|---|---|
| Momentum | +17 vs +17 (26th) | +18 vs +19 (16th) | +24 vs +23 (72nd) | +26 vs +26 (58th) |
| Buy setup | +6 vs +6 (86th) | +8 vs +8 (82nd) | +11 vs +9 (100th) | +13 vs +12 (100th) |
| Confluence | +5 vs +8 (0th) | +7 vs +10 (0th) | +9 vs +11 (0th) | +12 vs +14 (0th) |
| Triple | +6 vs +8 (2nd) | +7 vs +10 (0th) | +8 vs +11 (0th) | +10 vs +14 (0th) |

Hit rates match the random entries' within 2 points everywhere. **No
variant meets the candidate bar** (≥ 90th percentile *and* ≥ 8 points
over random). Momentum sits in the 16th–72nd band: the exit is doing the
work, and any entry in the same months would have done about as well.
The buy setup clears the percentile on the +75% targets (100th) but by
1–2 points, not 8 — its random dates' spread is just narrow. Confluence
and Triple pick worse-than-random dates on every option-target exit.
Consequence per the rule: no paper-trading candidate from this grid; the
next question is the exit's own merit against the index call, not the
entry.

## Added 2026-10-06 (owner: "run it"): the magnitude test

**Question.** Does any signal predict that a big move is coming, in either
direction? The swing-grid control showed the entries don't pick better
*directional* days than random. The owner's goal is 15–40% stock swings
on long calls or puts; a signal that can't even say "something big is
coming" is describing the past.

**Measure** (`scripts/magnitude-test.mjs`, `.github/workflows/magnitude-test.yml`):
for every signal day on every universe ticker, the biggest absolute move
of the close within the next 60 trading days (`|move|`), its up and down
halves, the share of signal days with `|move|` ≥ 15% / 25% / 40%, and the
realized vol over the window. Signals: the replay's buy entries (setup,
zone, confluence, triple, bravo, recovery), the sell side (sell score
reaching 2, Bravo bear turning on), cross-sectional momentum month ends,
and a **cheap-vol** entry (20-day historical vol's 252-day rank crossing
below 25) as the first look at the vol-rank idea. Control: random days in
the same months on the same ticker, same count, 50 seeded replications;
plus every day of every ticker as the base rate. Periods P1 / P2 as
before. No option pricing, no exits — the stock's path only.

**Reading, fixed before the run.** A signal "predicts magnitude" when its
mean `|move|` sits at or above the 90th percentile of its random
replications *and* exceeds the random mean by ≥ 3 points (e.g. 18% vs
15%), *and* its ≥ 15% share is also ≥ 90th percentile. Then a
direction-agnostic structure (a straddle / strangle, or a call *and* a put
sized by the signal) is worth a pre-registered test of its own. Below
that, the signals carry no information about size either; the path is the
vol-rank entry (if cheap-vol passes the same bar) or the index, and no
chart signal is presented as predictive. Realized vol after a signal is
reported for context only — vol clustering is expected and is not the
claim being tested. Caveat: a sell-side signal firing after a crash will
show a large past move, not a future one — only the forward window counts
here.

**Result, 2026-10-06 (run 37394575424, 545 tickers, 642,842 ticker-days).**
Mean biggest |move| within 60 trading days, signal vs random days in the
same months on the same ticker (50 replications), and the signal's
percentile on |move| / ≥ 15% share:

| Signal | n | \|move\| | random | ≥15% | random | pctl |
|---|---|---|---|---|---|---|
| Any day | 642,842 | 19.5% | — | 50.5% | — | — |
| Buy setup | 2,527 | 18.0% | 17.5% | 44.8% | 42.9% | 100th / 100th |
| Buy zone | 5,524 | 17.6% | 17.1% | 44.4% | 42.1% | 100th / 100th |
| Confluence | 12,978 | 18.7% | 18.9% | 45.7% | 45.8% | 0th / 38th |
| Triple | 328 | 18.4% | 18.5% | 48.2% | 47.0% | 26th / 78th |
| Bravo ◆ | 45,456 | 18.1% | 18.5% | 43.0% | 43.7% | 0th / 0th |
| Recovery | 1,598 | 17.5% | 18.1% | 43.7% | 45.3% | 0th / 2nd |
| Sell score 2+ | 20,141 | 19.6% | 19.4% | 49.8% | 49.0% | 100th / 100th |
| Bravo bear | 35,513 | 21.7% | 20.9% | 57.5% | 55.9% | 100th / 100th |
| Cheap vol | 14,272 | 19.4% | 19.2% | 49.1% | 48.3% | 100th / 100th |
| Momentum | 1,452 | 34.4% | 34.6% | 76.4% | 73.9% | 20th / 100th |

**No signal meets the bar.** The largest gap over random is Bravo bear at
+0.8 points; the rule asked for ≥ 3. Several signals sit at the 100th
percentile only because the random spread is narrow at these counts —
the gaps are 0.2–0.8 points, i.e. nothing. The buy-side entries sit
*below* the any-day base rate (18% vs 19.5%): dip-buying conditions
select calmer stretches. Cheap vol does not precede bigger moves (19.4%
vs 19.2%): a low-vol regime persists, so the vol-rank idea cannot rest
on "more movement is coming" — only on the premium being cheap. Momentum
days see 34% moves and 76% of them clear 15% within 60 days, twice the
universe — but random days on the same names in the same months see the
same, so that is **which stocks** momentum selects (high-vol names in
uptrends), not **when**. Consequence per the rule: no chart signal is
presented as predictive of size or direction; no direction-agnostic
trade is built on them. What the data does support is stock selection
by momentum (the names that move) with the exit doing the work, and the
index call.

## Added 2026-10-20 — the weakness test (owner: "find stocks that also indicate weakness and thus likely will go down … Go, run the weakness test")

Fixed before the code runs. A screen for strength (Leaders) is not an
indicator; this tests whether a small set of facts flags stocks **before**
a large fall. Nothing here changes a live rule; a result that clears the
mark earns a warning label on the stock, never a trade.

**Signals** (facts at a month's first close; SEC data as filed by that day):
price — close below the 200-day; the 200-day down ≥ 1.4% over 20 days; close
within 5% of its 52-week low; close ≥ 20% under its 20-day high; close ≥ 35%
above the 200-day (stretched). Business — free cash flow negative; free cash
flow down two years running; diluted shares up > 10% in a year; net debt up
while free cash flow fell. Funds skip the business signals. Score = number
of signals lit (0–9), with price (0–5) and business (0–4) sub-scores.

**Outcome:** a fall of ≥ 30% from that close to the lowest low within the
next 126 trading days ("drop"); also the 6-month return.

**Reading rule:** train = month starts before 2024-01-01, test = 2024 →.
The threshold (score ≥ k, k = 1…5) is chosen on train by the highest
lift × recall; it is then reported on test. Per signal alone too.
**Pass** on test, all three: flagged stock-months have ≥ 2× the base rate
of drops (precision ≥ 2 × base); they catch ≥ 30% of all drops (recall);
their median 6-month return sits ≥ 5 points under the universe median.
**No edge:** any of the three fails. A leaders-only cut (business
sub-score ≥ 1 among leader months vs 0) is reported for context.

**Caveats, stated now:** today's ticker list omits delisted names, which
*hides failures* and biases the test against finding them; ~4.5 years, one
bull market; no options, insider or short-interest data (no history for
them); monthly sampling. The consequences: pass → a "Weak" / "At risk"
label with its tested record, shown as facts; fail → research only.

## Added 2026-10-20 — the insider / short-interest test (owner: "Run it")

After the weakness test failed (price and annual-report facts flag
volatility, not direction), this tests the two sources the published
research finds something in, both free with real history: **SEC Form 4**
(insider trades, the DERA quarterly bulk files) and **FINRA consolidated
short interest** (twice-monthly). Options skew has no history available and
is not tested. Fixed before the code runs.

**Signals** at each month's first close, using only filings made by that
day: I1 **sell cluster** — ≥ 3 distinct insiders with open-market sales
(code S) in the prior 90 days and no open-market buy (code P); I2 **net
selling** — $ sold ≥ 10× $ bought over the prior 180 days and ≥ $1M sold;
I3 **buy cluster** — ≥ 2 distinct insiders with open-market buys in the
prior 90 days (the mirror, and a check that the data works at all: insider
*buying* is the better-documented effect); S1 **short interest rising** —
shares short up ≥ 50% vs 3 months earlier; S2 **heavily shorted** — shares
short ≥ 10% of shares outstanding (SEC dei cover-page count, latest filed).
Combined with the weakness score (score ≥ 3) as a further cut.

**Outcome:** as the weakness test — a ≥ 30% fall from the close to a later
low within 126 trading days; the 6-month return.

**Reading rule:** train < 2024, test 2024 →, each flag reported alone and
in combination. These flags are rare, so recall is **reported, not
required** (a rare warning that is right is still a fact worth showing).
**Pass** on test, all three: lift ≥ 2× the base rate of drops; 6-month
median ≥ 5 points under the universe median; ≥ 200 flagged stock-months
(enough to mean something). For I3 the mirror reading: 6-month median ≥ 5
points *over* the universe. **No edge:** any fails.

**Caveats:** survivorship (delisted names missing — hides failures); ~4.5
years; Form 4 symbols as filed (a few issuers file without one); FINRA
history depth as served by its API (skipped, and said, if it refuses the
runner). Consequence: pass → an "Insiders selling" / "Heavily shorted" fact
on the row with its record, never a trade; fail → research only.

## Added 2026-10-26 — the Fade Screen test (owner spec, 2026-10-26: "Go")

The owner's Fade Screen spec (pre-revenue small caps whose story holds on
paper while fundamentals and insider behaviour deteriorate; the AIRJ case)
scored six factors to 100 by judgment. This test asks whether that score,
computed mechanically and point in time, separates the names that went on
to fall from the names that went on to double. Fixed before the code runs.

**Universe (built from SEC data, never hand-picked):** every filer whose
public float (dei:EntityPublicFloat, the mid-year frame for 2022–2025) sat
in $100M–$2B in any of those years, mapped to a listed ticker, whose latest
annual revenue known by the day is under $25M (or no revenue tag at all),
with 20-day average dollar volume over $1M that day. Survivorship: only
tickers listed today have price history — the names that fell to delisting
are missing, which hides exactly the outcome being tested. A pass on
survivors is provisional until delisted-inclusive prices are bought.

**Factors at each month's first close (spec weights, unchanged):**
1. **Shorts pressing (25):** FINRA short interest up ≥ 15% vs the settlement
   ~30 days earlier → 10; and the close down ≥ 10% over the same span → 25.
2. **Failed catalyst (25):** mechanical event day = a close up ≥ 10% on volume
   ≥ 3× its prior 20-day average, within the last 60 sessions; fires when a
   later close within 20 sessions of the event sits below the event close.
   (The milestone ledger's slip points need hand-entered promises and would
   carry hindsight; not in the test.)
3. **Runway (15):** cash and equivalents ÷ the latest quarter's operating
   cash burn (10-Q / 10-K XBRL, YTD rows differenced); under 3 quarters → 15,
   under 5 → 8; positive cash flow → 0.
4. **Insider selling (15):** an open-market sale (Form 4 code S) filed in the
   prior 60 days with no open-market buy in that window; CEO or CFO → 15,
   another officer → 8; directors and 10% holders → 0 (the spec says officer).
5. **Capital redirect (10):** not built in this run (8-K / S-3 feed) → 0.
   The reachable maximum is therefore 90.
6. **Trend break (10):** the close below the 50-day for 10+ sessions and the
   50-day below the 200-day.
Tiers as the spec: 50 watch, 70 actionable. The catalyst blackout needs the
ledger (not modelled); the squeeze guard's borrow rate isn't available —
short interest ÷ shares outstanding is reported instead.

**Outcomes within 126 trading days:** fell ≥ 40% from the close to a later
low ("faller"); rose ≥ 100% to a later high ("doubler"); the 6-month return.

**Reading rule:** train < 2024, test 2024 →, the spec's weights, no refit
in this run. **Pass** on test, all four, for score ≥ 70: fallers at ≥ 2× the
universe base rate; doublers at or below the base rate; 6-month median ≥ 10
points under the universe median; ≥ 100 actionable stock-months. The spec's
own framing — of the stocks that fell 40%+, how many had scored 70+ before,
and of the doublers how many — is reported as recall beside it. Each factor
alone and score ≥ 50 are reported too. **No edge:** any of the four fails.
Consequence: pass → the score and its factors shown as facts to subscribers
(no trade structure; puts stay owner-only like the spread bot) and the
8-K feed + ledger built next; fail → the weights are refit on train only and
re-read on test once, then research only.
