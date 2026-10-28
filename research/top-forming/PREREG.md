# Top Forming, job 1: do stage-based exits protect gains? Pre-registration

Written 2026-10-28, before any signal code or data run. Owner's decisions
of the same day: facts and stages for everyone, actions owner-only; the
bear side is dropped; build and test job 1 only, on prices. Nothing below
may change after results exist. A change is a new dated addendum at the
bottom.

## 1. Question

On a stock a holder already owns and is up 50% or more on, do exits that
tighten as the Top Forming stage rises capture more of the peak gain than
a plain 25% trailing stop, without exiting stocks that go on to double
materially more often?

## 2. Signals (prices only: A, B and E)

Day t uses data through the close of day t. SMA = simple moving average
of closes; ATR = 14-day average true range; RSI = 14-day Wilder RSI;
OBV = on-balance volume. Each signal has a strength from 0 to 1.

**A. Extension**
- **A1 Extension.** ext = close ÷ SMA(250) − 1. Strength rises linearly
  from 0 at +25% to 1 at +100%. Its percentile against the stock's own
  last 756 sessions is reported, not scored.
- **A2 Parabolic.** Fit log(close) = a + b·x + c·x² on the last 30
  sessions. Strength 1 when c > 0, R² > 0.85 and the 10-session log slope
  is more than 2× the 60-session log slope, else 0.
- **A3 Volatility expansion.** ATR ÷ close, as a percentile rank against
  its last 252 values. Strength = that rank.

**B. Exhaustion**
- **B1 Climax volume.** Volume > 3× its prior 50-day average, and the
  upper wick ≥ 50% of the day's range or the close in the bottom third of
  the range. Strength 1 if it fired in the last 10 sessions.
- **B2 Distribution days.** In the last 25 sessions, days with a lower
  close than the day before on higher volume than the day before.
  Strength 0 at 3 days, rising to 1 at 6 or more.
- **B3 Divergence.** Swing highs by a 5-bar fractal (the highest high of
  5 bars either side), confirmed 5 sessions later. Of the last two
  confirmed swing highs within 60 sessions: a higher price high with a
  lower RSI = RSI divergence; the same test on OBV. Strength = the share
  of the two that hold.
- **B4 Exhaustion gap.** An open more than 5% above the prior close,
  when A1's ext was over 50% the day before, filled (a low at or under
  that prior close) within 3 sessions. Strength 1 if a fill happened in
  the last 10 sessions.
- **B5 Lower highs.** After the 252-session high, the last two confirmed
  swing highs are each lower than the one before. Strength 1 or 0.

**E. Confirmation**
- **E1 Trend break.** Close below SMA(50), with ext above 30% on some
  day of the last 40 sessions.
- **E2 Weekly breakdown.** The last completed week closed below its
  10-week SMA. Only weeks that ended before the current week count.
- **E3 Failed retest.** Within the last 40 sessions the close broke
  below SMA(50). After that break, a high reached SMA(50), no close
  above SMA(50) came in that day or the next 4, and today's close is
  below every close since the break.

Each E strength is 1 or 0.

## 3. Score and stages

Group strength = the mean of its signals' strengths. TopScore = 100 ×
Σ w·s ÷ Σ w over the groups computed, with prior weights A 0.20, B 0.30,
E 0.10. That is 0.60 in all now; C (0.30) joins only if job 1 passes,
and D stays at 0 until it is validated forward. No weights are fitted in
this round: the test is about exits, and fitting adds tuning.

The stages, with descriptive names, apply in this order:

| Stage | Rule |
|---|---|
| **Trend broken** | Any E signal at 1, and the stage was Distribution or Trend broken on one of the previous 20 sessions |
| **Distribution** | TopScore ≥ 60 and 2+ B signals at strength ≥ 0.5 |
| **Extended** | TopScore ≥ 35 and group A strength ≥ 0.5 |
| **Clear** | Anything else |

## 4. Job 1 test

**Universe.** SEC public-float filers between $50M and $10B in any year
2016–2025 that list a ticker today, plus the app's chart universe. On an
entry day: close $0.50–$50 and 20-day average dollar volume over $1M.
Survivors only. The number of float-range filers with no ticker today is
reported as the size of the gap. Missing names that went to zero flatter
buy-and-hold, so any edge the exit policies show is conservative.

**Daily bars** run from 2015 or the stock's first trade, through
price-history's daily interval. Signals are valid from session 252 on;
A1's percentile needs 756.

**Entries.** Day t where close ≥ 1.5 × the lowest low of sessions
t−59…t. At most one entry per stock per 60 sessions. The position is
held from the close of t.

**Control.** For each stock, the same number of entries on random days
(seeded) that meet the price and liquidity filter, same spacing rule.

**Execution.** Every rule is checked at a close. Its sale fills at the
next session's open, with 0.1% slippage. Whatever is left is sold at
the close of session t+120. Peak = the highest close since entry,
counting the entry close.

**Policies, 120 sessions each:**
1. **Buy-and-hold.**
2. **25% trail.** Sell all when a close is 25% or more below the peak.
3. **⅓ / ⅓ / runner.** Sell ⅓ when a close is ≥ 1.5× entry, another ⅓
   at ≥ 2.0× entry. Everything unsold exits on the 25% trail.
4. **Stage trail.** The trail is 25% under Clear, 20% under Extended,
   15% under Distribution, 10% under Trend broken. It only tightens: it
   follows the highest stage reached since entry.
5. **⅓ / ⅓ / runner with the stage trail.** Policy 3, with policy 4's
   trail in place of the flat 25%.

**Measured per entry.**
- Final return R.
- Peak gain G: the highest close within 120 sessions ÷ entry − 1.
- Captured = R ÷ G, for entries with G ≥ 10%.
- Give-back = G − R.
- Worst trade and the 5th percentile of R.
- **Doublers:** entries whose close reaches ≥ 2× entry within 252
  sessions. Early exit = fully sold before that first 2× close. Reported
  as the share of doublers exited early.

**Folds.** Six-month windows by entry date, from 2018-01-01 to the
latest entry with a full 120 sessions. Nothing is fitted, so every fold
is out of sample. Results are pooled and shown fold by fold.

**Pass.** Policy 4 or policy 5 passes against policy 2 when all three
hold:
1. The paired mean of (captured − policy 2's captured) has a clustered
   bootstrap (by entry month, 10,000 resamples) **97.5%** interval with
   a lower bound above 0. Bonferroni over the two comparisons.
2. That difference is positive in at least 60% of the folds.
3. Its doubler early-exit share is no more than policy 2's plus 5
   percentage points.

**Fail:** neither passes. **Inconclusive:** under 200 entries with
G ≥ 10%. The random-entry control is reported beside it. It is not
graded, but if the stage policies help as much on random days, the
stages aren't what's helping.

**Reported, not graded.**
- Stage validation with the label "top event on day t": the largest
  drawdown from close(t) over the next 60 sessions is ≥ 30%, and no
  close above 1.10 × close(t) comes first.
- Base rate; precision, recall and lift per stage; lift per signal; top
  events by score bucket (calibration).
- Median sessions from a stage's first day to the lowest close of that
  drawdown.
- Case studies: AEVA, AIRJ, RXRX, NAUT, GME, DJT (the DWAC SPAC) and
  MSTR.
- The three strongest false positives: Distribution or worse, then the
  stock doubled.

## 5. Consequences

- **Pass:** C1–C3 are built in and re-tested, then the stage UI and
  owner-only actions follow.
- **Fail:** the stages ship as information only, if their lift holds up,
  and the report says the exits don't beat a 25% trail.
- **Any stage with lift under 1.5×** is reported as dropped or to be
  reworked.
- Subscriber wording goes to counsel before it ships.

## 6. Known weaknesses

- Survivors only.
- Fills at the next open are an assumption, and gaps can be worse.
- No fitted weights.
- Stage thresholds come from the spec, not from data.
- Small caps carry the most of the delisting gap.
