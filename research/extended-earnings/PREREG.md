# Extended into earnings — pre-registration

Written 2026-10-28, before any code or data. Owner: "$NOW tanked after
earnings all the way to the MA … $NOW was extended and the reports brought
it back to the average — can that be tested" → "see how extended it was to
compare and run it".

**Question.** When a stock goes into its earnings report extended, does the
report pull it back toward its average more often and further than reports
on the same stocks when they weren't extended? Stock prices only. Whether
puts pay is a separate question this test cannot answer (no historical
option prices — see the pre-earnings run-up REPORT).

## Data
- Universe: `CHART_TICKERS` (the app's chart list, ~560 names, survivors).
- Daily bars back to 2015 (`dailyBars`, range 10y); SPY for the market.
- Earnings events: SEC EDGAR 8-K Item 2.02 `acceptanceDateTime`, converted
  UTC → Eastern (`edgarTiming`, run-up `lib.mjs`). Before 9:30 = before the
  open (L = previous session), at or after 16:00 = after the close (L = that
  session); filings during market hours are dropped (the release time is
  unknown). One event per 20 days per ticker. Single source, labelled so.
- Events from 2016-01-01 with ≥ 252 prior bars; the last event needs 5
  sessions after it.

## Measured at L (the last close before the report)
RSI 14 · % above the 20-, 50- and 200-day averages · the app's **Extended**
flag (`extendedFlags`: RSI ≥ 70, or % above the 200-day in the top 10% of
its trailing year).

## Outcomes (A = first session after the report)
- Next-day move = A close / L close − 1, and the same minus SPY's.
- 5-session move (close of A+4), SPY-adjusted too.
- Down next day (yes / no).
- **Reached the average**: a low at or under the 50-day (and, reported, the
  20-day) average on any of A … A+4.
- Move vs its own normal: |next-day move| ÷ the median |next-day move| of
  the stock's previous 8 reports (≥ 4 needed).

## Groups
1. **Extended** (graded) vs **Not extended**, same tickers.
2. **As extended as NOW** (descriptive, chosen after seeing NOW, not graded):
   the job prints NOW's values at its latest report on or before the run
   date — % above the 50-day and the 200-day, RSI — and reports every event
   with % above the 50-day **and** % above the 200-day at least NOW's.
3. NOW's own history: every NOW report, its values at L and its outcome.

## Pass (Extended vs Not extended, all of)
- ≥ 300 Extended events.
- SPY-adjusted next-day median at least 1.5 points lower.
- Share down next day at least 8 points higher.
- Reached the 50-day within 5 sessions at least 1.5× as often.
- The difference in mean SPY-adjusted next-day move: 95% interval from a
  bootstrap clustered by report week (10,000 reps) entirely below 0.
- Median SPY-adjusted next-day move lower than Not extended in at least 7
  of the 10 years 2016–2025.

**Fail:** any one misses. **Inconclusive:** < 300 Extended events.

## Consequences
- Pass: the fact can be shown as information ("extended going into the
  report") — wording to counsel; whether a put pays waits on option prices
  (the forward pre-earnings straddle record, or a data purchase the owner
  approves).
- Fail: recorded; NOW's drop stays one case.
- Either way nothing trades, nothing changes a live rule.

## Known weaknesses
Survivors only. EDGAR timing alone (no second source). An 8-K filed later
than the release can put an event on the wrong side of a session; dropping
during-market filings removes the worst of it. Daily bars only — "reached
the average" uses the session low.
