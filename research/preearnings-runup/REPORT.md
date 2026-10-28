# Pre-earnings premium run-up: report

**Verdict: inconclusive. The graded test has not run, because the data it
needs does not exist in anything Cash Moves owns.** The test needs
historical option quotes (bid, ask, implied vol, delta, open interest)
for weekly expiries at fixed times of day. We have none before
2026-10-27. Nothing has been bought. Per the guardrails, buying data
waits for the owner.

Nothing ships as a signal or a trade. One trade (NOW, +45% in four
hours) cannot separate edge from luck, and no result here says otherwise.

## What ran

1. **Pre-registration first.** `PREREG.md` was committed (70e4827) before
   any code touched data. Addendum 1 (e31c11e) was added after the
   timing source turned out to be empty and before any diagnostic result.
2. **The engine and its checks.** `lib.mjs` handles fills, fees,
   sizing, delta selection, expiry choice, controls, clustered bootstrap,
   Holm correction and the pass rule. `check.mjs` has 48 checks.
   `e2e.mjs` runs the whole backtest on synthetic chains: a planted IV
   run-up grades "edge," no planted edge grades "no edge," and an
   in-sample run never reads a held-out event. All pass.
3. **Earnings events.** `events.mjs` read 1,255 SEC 8-K Item 2.02
   filings for the 30 stage-1 names since 2016. The acceptance clock is
   UTC; converted to Eastern, 1,249 land before 9:30 or at or after
   16:00, which is clean.
4. **A free diagnostic.** `drift.mjs` measured pre-event stock drift on
   in-sample events, PREREG §9, single-source timing per addendum 1.
   Not graded. Not the answer.
5. **The option backtest.** `backtest.mjs` is built and tested. It
   stops with "no option chain data" until chains exist.

## The diagnostic: does the stock drift into earnings?

In-sample only (report day before 2025-05-01), 415 events, October 2021
to April 2025. Bars only reach back 5 years because the runners were
refused by Yahoo and fell back to the app's 5-year edge function.
Controls are 3 random non-earnings windows per event, same ticker,
same weekday.

| Window | Events | Average move | Median | Up | Average size of move | Control average | Control size | Event − control, 95% CI | Size ratio |
|---|---|---|---|---|---|---|---|---|---|
| 5 sessions before → last session | 414 | +0.52% | +0.20% | 52% | 4.02% | −0.20% | 3.67% | −0.05% to +1.49% | 1.09 |
| 3 sessions before → last | 415 | +0.46% | +0.41% | 55% | 3.10% | −0.07% | 2.84% | +0.02% to +1.05% | 1.09 |
| 2 sessions before → last | 415 | +0.37% | +0.30% | 55% | 2.52% | −0.01% | 2.40% | +0.01% to +0.76% | 1.05 |
| 1 session before → last | 415 | +0.26% | +0.13% | 52% | 1.91% | −0.02% | 1.72% | +0.01% to +0.55% | 1.11 |
| Report-day open → close (after-close reports) | 310 | +0.08% | +0.11% | 52% | 1.69% | +0.02% | 1.51% | −0.24% to +0.35% | 1.12 |

By year, 2 sessions before → last session: 2022 0.0%, 2023 +0.9%,
2024 +0.3%, 2025 (to April) +0.9%. Same-day: 2022 +0.2%, 2023 +0.3%,
2024 −0.3%, 2025 +0.5%.

**Reading.**
- **The stock drifts up a little before earnings.** About +0.3% to
  +0.5%, barely clear of zero. It is a well-known pattern, and in
  option terms it is tiny: a fraction of the cost of crossing a
  weekly's spread.
- **Pre-event moves are only 5–12% larger than normal days.** The stock
  isn't much more active before the report. So driver (b), stock drift,
  can't pay for a short-dated option by itself.
- **The drift points the wrong way for your trade.** A put needs the
  stock to fall. On the report day itself, the average move is flat.
- **What this leaves.** Driver (a), implied vol rising into the event,
  is the only route to an edge. It can only be measured with option
  quotes. Your NOW put gained while the stock barely needed to move,
  which fits an IV run-up, but one trade can't say how often.

## Data: what we have and what's missing

| Need | Have | Status |
|---|---|---|
| Earnings dates with timing | SEC 8-K Item 2.02 acceptance minute, 2016 →, all 30 names | **Have** (source 1) |
| A second timing source | Nasdaq calendar: answers, but every past row says "time-not-supplied" | **Missing** |
| Historical option chains, bid / ask / IV / delta / OI, weeklies, intraday | `dxlink_quotes`: live only, overwritten in place, rows since 2026-10-27. `leaps_quotes`: empty. `gex_history`: from 2026-10-21, GEX payloads, not quotes | **Missing** |
| Underlying daily bars | Yahoo or the app's edge function, 5 years on the runners | **Have** |
| Delisted and acquired names for stage 2 | Nothing | **Missing** |

**Options to close the gap.** No prices here. Pricing changes and I
haven't checked current plans, so each needs a quote before anything is
bought.

1. **Massive (Polygon): not an option.** The plan is inactive (owner, 2026-10-28: about $200 a month to restart). The daily IV rows still labelled "polygon" are empty: none since 2026-10-20 has an IV value.
2. **ThetaData.** Historical option quotes at intraday times for US
   names, which fits the 10:00 / 15:45 / 15:55 snapshots exactly.
3. **Cboe DataShop, Option EOD Summary.** Carries a 15:45 ET quote with
   IV and greeks. That covers every k-day entry. It can't run the
   same-day 10:00 entry, which is the primary variant.
4. **ORATS.** Historical data with earnings dates and BMO / AMC timing.
   It could be the missing second timing source on its own.
5. **Free, slow, cleanest: a forward record.** The DXLink worker
   already streams Tastytrade option quotes for some of these names. A
   small addition could save 10:00 / 15:45 / 15:55 snapshots of the
   first weekly after each report for the 30 names. It is truly out of
   sample. About 120 reports a year gives roughly 100 usable trades in
   10–12 months. It changes a production worker, so it waits for your
   go.

Any of 1–4 needs the second timing source too. ORATS, Wall Street
Horizon or the vendor's own calendar can be that.

## What would change this

- **With chains,** `backtest.mjs` runs as is, in-sample first, then the
  one graded `--oos` run. The verdict is then edge or no edge under the
  rules committed before any data was seen.
- If chains show IV rising enough to beat the spread on the primary
  (0.20-delta put, same-day morning, after-close reports), it passes.
  That still means a paper record for a quarter before anything else.
- **If it fails,** the opposite side is worth its own pre-registered
  test: defined-risk premium selling, a credit spread or iron condor
  sold before the release and held through it. The edge there would be
  IV collapsing after the report, and the risk is the gap. The
  diagnostic doesn't speak to it. The run-up test should be read first.

## Reproduce

```
node research/preearnings-runup/check.mjs
node research/preearnings-runup/e2e.mjs
# on a GitHub runner (SEC / Nasdaq / Yahoo are blocked in the dev sandbox):
#   workflow "Pre-earnings run-up" runs events.mjs → drift.mjs → backtest.mjs
node research/preearnings-runup/backtest.mjs --events events.json --bars bars.json --chains data/chains          # in-sample
node research/preearnings-runup/backtest.mjs --events events.json --bars bars.json --chains data/chains --oos    # the graded run, once
```

Chain files go in `data/chains/<TICKER>/<YYYY-MM-DD>.json`; the layout is
at the top of `backtest.mjs`. Runs: events 40754954799 and diagnostic
40755721771. Artifacts hold `events.json`, `drift.json` and the 2-day
histogram SVG, kept 30 days.

## Caveats

- Stage 1 is today's large caps, a survivor list.
- The diagnostic uses EDGAR timing alone (addendum 1). The graded test
  won't.
- Five years of bars, not ten. 2021 holds only 17 events.
- Fixed-time quotes are not fills. The 25%-of-spread rule is an
  assumption, so worst-case fills are reported beside it.
