# Pre-earnings premium run-up: pre-registration

Written 2026-10-28, before any backtest has run and before any option
data for this test has been loaded. Owner's request: "Investigate and
backtest a pre-earnings premium run-up options strategy… pre-register the
test, and if it fails, nothing ships as a signal or trade."

The motivating trade, recorded as an anecdote and not as evidence: NOW
weekly 140 put, about 0.22 delta, 2 days to expiry, bought the morning of
an after-close report at 2.67 and sold before the release at 3.88
(+45% in about four hours). One trade cannot separate edge from luck.

Nothing below may change after results exist. A change is a new dated
addendum at the bottom, and every number reported says which version of
the rules produced it.

## 1. Hypothesis

**H1.** Buying a short-dated option 1–5 trading days before a scheduled
earnings report and selling it before the report is released has positive
expectancy after realistic costs. Candidate drivers: (a) implied
volatility rising into the event, (b) the stock drifting before it.

**H0.** Expectancy is ≤ 0 after costs, or no better than the same trade
in random windows with no earnings report.

## 2. Events

- **Earnings dates with timing, confirmed by two sources.** Source 1:
  SEC EDGAR 8-K filings with Item 2.02 (Results of Operations), using
  the filing's acceptance timestamp. Accepted before 09:30 ET = before
  the open (BMO). Accepted at or after 16:00 ET = after the close (AMC).
  Accepted 09:30–16:00 = during market, excluded. Source 2: the data
  vendor's or Finnhub's historical earnings calendar with its time field.
  An event is used only when both sources give the same date and the
  same BMO/AMC timing. Disagreements and one-source events are counted
  and reported, never used.
- **Last pre-release session (L).** AMC: the report day. BMO: the
  session before the report day.
- **Release.** AMC: after L's close. BMO: before the next open.

## 3. Universe and period

- **Stage 1, large caps, fixed list now:** NOW, NVDA, AMZN, GOOGL, META,
  MSFT, CRM, ADBE, AAPL, NFLX, AMD, AVGO, ORCL, TSLA, INTC, QCOM, MU,
  UBER, SHOP, PANW, SNOW, INTU, COST, JPM, GS, WMT, HD, DIS, BA, PYPL.
  Every name on it is a large cap that trades today, so stage 1 is a
  survivor list by construction. That is stated, not corrected.
- **Stage 2, mid caps, graded separately and run only after stage 1.**
  Rule, not a list: market cap $2B–$20B at the event date, from the
  vendor's point-in-time universe including delisted and acquired names,
  passing the same liquidity filter.
- **Liquidity filter at entry (proposed, fixed now).** Underlying 20-day
  average option volume ≥ 20,000 contracts a day. The chosen contract
  has open interest ≥ 500 and traded ≥ 100 contracts the session before
  entry. Bid-ask ≤ 10% of mid. Mid ≥ $0.20. A trade failing any of these
  is skipped and counted. A straddle needs both legs to pass.
- **Period.** As far back as the data goes, up to 2026-10-27.
  **Out-of-sample (held out): events with L on or after 2025-05-01.**
  In-sample: everything before. The out-of-sample set is not computed,
  printed or looked at until this file's rules are committed and the
  in-sample run is recorded. The script refuses to report it unless it
  is started with `--oos`, and the first `--oos` run is the graded one.

## 4. Trades

- **Expiry.** The first listed expiry on or after the first session
  after the release, so the option expires after the report.
- **Strike by delta.** The contract whose absolute delta at entry is
  nearest the target (0.20, 0.30 or 0.50). Delta is the vendor's. If the
  vendor has none, it is Black-Scholes delta from that contract's mid
  implied vol, rate 4%. Ties go to the strike nearer the money.
- **Directions.** Put. Call. Straddle: the 0.50-delta call plus the
  0.50-delta put, same expiry. Trend: a call if the stock's close at
  entry is above its close 5 sessions earlier, else a put.
- **Entry.** At the session L − k for k = 5, 3, 2 or 1, quote taken at
  15:45 ET. Plus **same-day morning**, AMC reports only: L at 10:00 ET.
- **Exit, primary (pre-release).** L at 15:55 ET. The position is never
  held into the release.
- **Exit, comparison (held through).** The first session after the
  release at 10:00 ET.
- **End-of-day fallback.** If the data has end-of-day quotes only, k-day
  entries use the closing quote of L − k, the pre-release exit uses the
  closing quote of L, and same-day morning entries are not run. Every
  result says which quote times it used.

**Grid.** Put, call and trend at 3 deltas, plus straddle at 0.50, is 10
contracts. Times 5 entries is 50 cells, minus the 10 same-day cells that
apply to AMC only (they run on AMC events). Times 2 exits. Every cell is
reported, none dropped.

**Primary variant, declared now:** the owner's trade. Put, 0.20 delta,
same-day morning entry, AMC reports, pre-release exit, realistic costs.

## 5. Costs

- **Realistic:** buy at ask − 25% of the spread, sell at bid + 25% of the
  spread.
- **Worst case, also reported:** buy at the ask, sell at the bid.
- **Fees:** $0.65 per contract per side commission, plus $0.05 per
  contract per side for regulatory and clearing fees.
- **Size:** $1,000 risked per trade. Contracts = floor($1,000 ÷ cost per
  contract), at least 1. A trade where one contract costs more than
  $1,000 is skipped and counted. A straddle is sized on both legs.
- Return per trade = net proceeds ÷ (premium + fees) − 1.

## 6. Control

The same rules on **random non-earnings windows** for the same tickers.
For each real event, 3 pseudo-events drawn with a fixed seed: a pseudo
L at least 15 sessions from any real report of that ticker, same
weekday as the real L, same entry offsets, same expiry rule (first
expiry after the pseudo release), same delta targets, same costs and
same liquidity filter.

## 7. Metrics, per variant

Trades and skips, win rate, average win, average loss, expectancy per
trade (% of premium, and $ per $1,000 risked), median, max drawdown of
the $1,000-per-trade equity curve in date order, the worst 5 trades, and
a Sharpe-like ratio (mean ÷ standard deviation × √ trades per year).
Split by IV rank at entry (terciles), sector, VIX bucket (< 15, 15–20,
20–30, ≥ 30), year, and BMO vs AMC. A return histogram and an equity
curve for the primary and for the best variant. Diagnostic for each
trade: implied vol at entry vs exit, and the stock's move entry to exit,
so a pass can be traced to (a), (b) or both.

## 8. Pass / fail, out-of-sample only, realistic costs

A variant **passes** only if all of these hold:

1. Expectancy > 0, with the bootstrap 95% confidence interval's lower
   bound > 0. Bootstrap: 10,000 resamples, clustered by the calendar
   week of L, because reports in the same week share the market.
2. ≥ 100 trades.
3. It beats its control: (event − control) expectancy has a bootstrap
   95% lower bound > 0, with the same clustering.
4. Not driven by outliers: with its 5 best trades removed, expectancy
   is still > 0.

**Multiple testing.** The primary is graded on its own. Any other
variant must also survive a Holm–Bonferroni correction at 5% across
every pre-release variant tested, on the one-sided bootstrap p-value of
criterion 1.

**Verdict.** **Edge:** the primary passes, or any variant passes after
Holm. **No edge:** every variant with ≥ 100 trades fails. **Inconclusive:**
the primary and every Holm survivor have < 100 trades, or the data needed
for the test does not exist. In-sample results are never presented as
the answer. No rule is re-tuned on the out-of-sample period.

## 9. Diagnostic that may run before option data exists

Not graded and never the answer. Pre-event **stock drift**: the
underlying's return from L − k to L for k = 5, 3, 2, 1, and its absolute
size, on the confirmed events, against the same windows on the control
pseudo-events. **In-sample events only**, so the out-of-sample set stays
sealed for the graded run. It speaks only to driver (b).

## 10. Consequences

- **Edge:** a design proposal, not built, for a Cash Moves "Earnings
  Run-up" module: paper trading and logging only first, sizing ≤ $1,000
  per trade, a mandatory exit before the report, no auto-execution. A
  forward paper record of at least a quarter before anything else. The
  no-investment-adviser rule still applies: if it ever reaches
  subscribers, it is facts, not trade calls, and counsel first.
- **No edge:** said plainly, nothing ships as a signal or a trade, and
  the report says whether defined-risk premium selling around earnings
  is worth its own pre-registered test.
- **Inconclusive:** the report lists exactly which data would settle it,
  and no money is spent on data without the owner's say-so.

## 11. Known weaknesses, stated now

- Stage 1 is a survivor list of today's large caps.
- Quote snapshots at fixed times are not fills. The 25%-of-spread rule
  is an assumption, which is why the worst case is also reported.
- The 8-K acceptance time is the filing time, not always the release
  time. The two-source rule exists for that.
- Earnings-week option spreads widen. The liquidity filter is checked
  at entry only. A position can be harder to exit than to enter, which
  the fixed-time exit quote does not capture.
- With about 30 names and 4 reports a year, 18 months out of sample
  holds roughly 180 events before filters, close to the 100-trade floor.

## Addendum 1, 2026-10-28 (before any diagnostic result existed)

The first events run found that Nasdaq's historical calendar answers every
past date but carries no time for past reports ("time-not-supplied" on
every row sampled from 2016 on). So no past event has a second timing
source, and §2's rule confirms none. **The graded option test keeps §2
unchanged:** it waits for a vendor calendar with historical BMO / AMC
timing to act as the second source (ORATS, Wall Street Horizon or the
option vendor's own calendar).

**The §9 diagnostic only** may use events with EDGAR timing alone, labelled
"single-source" in every output. EDGAR gives the 8-K's acceptance minute
(converted from UTC to Eastern; 1,249 of 1,255 Item 2.02 filings fall
before 9:30 or at or after 16:00 ET). Everything else in §9 is unchanged:
in-sample events only, the same windows, the same controls. The diagnostic
is still never graded and never the answer.
