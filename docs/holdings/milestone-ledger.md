# Milestone Ledger & Risk Facts — Cash Moves Module Spec

As of 2026-10-26 · Cameron Wiley · v2 (post-test). The owner's spec, kept
verbatim as the build contract; implementation notes at the end.

## Purpose

The module shows a holder of a pre-revenue small cap two things the price does not: the dated promises management has made and whether each one is on time, and a short list of plain risk facts drawn from short-interest and price behavior. It issues no score, tier, or verdict. The pre-registered Fade Screen test (October 2026, below) found that the scored version identifies violent stocks, not falling ones, so the put trade and the verdict wording were dropped; the ledger and the two facts that carried the test remain.

GEX cannot do this job on names under ~$1B. Dealer gamma only means something when options volume is deep enough that hedging flow moves the stock; on a $287M company with thin chains the numbers are noise. This module uses a different feed and runs beside the GEX engine, not inside it, on tickers the GEX engine would reject for liquidity.

**It is one card per ticker.** The milestone ledger on top, the risk facts beneath it, both refreshed daily. Nothing tells the holder to buy or sell; it tells them what has been promised, what has happened, and what the tape is doing against the story. The trading rules the holder already uses (tranche exits on basis, kill on a slip) sit outside this module.

## Inputs

| Input | What it carries | Source | Refresh |
| --- | --- | --- | --- |
| Short interest | Shares short, % float, days to cover | FINRA bi-monthly (free); Ortex or S3 for daily | Daily or 2x/month |
| Cash and burn | Cash + equivalents, quarterly operating cash flow | 10-Q/10-K via EDGAR XBRL (free) | Quarterly |
| Price and volume | Daily OHLCV, 20/50/200-day MA, 52-week high | Any market data API you already use | Daily |
| Catalyst calendar | Management-stated milestone dates, earnings date | Manual entry from calls and press releases | Per event |
| Positions | Lots: ticker, shares, cost, date | Manual / CSV / SnapTrade (read-only) or Schwab Trader API | Daily |

Universe: market cap $100M–$2B, trailing-twelve-month revenue under $25M, listed on NASDAQ or NYSE, average daily dollar volume over $1M.

## Risk facts shown on a holding

Two facts, each shown as a sentence with its numbers, no color coding, no score. These are the two inputs that did the work in the Fade test; the rest were noise and are not shown.

| Fact | When it shows | Wording on the card |
| --- | --- | --- |
| Failed catalyst | The stock closes below the close of its last hype event (product reveal, major partnership, analyst initiation) and stays there 20 trading days | "Has not held its Jul 2 close ($5.90) for 20+ sessions; now $3.05" |
| Shorts pressing | Short interest up 15%+ over 30 days while price is down 10%+ over the same window | "Short interest +25% in 60 days to 17.4% of float; price −48% over the same window" |

What is deliberately not shown: insider selling (added nothing in the test, −0.6% median), shelf filings (on 64% of fallers but nearly half the universe), and a runway countdown (lit 440 days before the median raise; it describes a cash burner, which is already public). Cash and burn still appear as plain numbers in the ledger header because a holder should know them, but they are not framed as a signal.

The two facts together describe a stock the market has stopped believing. The test says that stock is 22% lower six months later at the median and doubles one time in three. Both halves of that sentence are shown to the holder when both facts are lit, in exactly those words.

## Milestone ledger (holder view)

Every pre-revenue name on the watch list gets a milestone ledger: each dated promise management has made, where it stands, and how many times the date has moved. This is the top of the card and the part that does not depend on any score. It survived the Fade test unchanged because it was never a prediction; it is a record.

The ledger is built from earnings calls, press releases and 10-Q outlook sections, one row per promise. A promise is logged the first time management puts a date on it; every later restatement updates the row and bumps the slip count.

| Milestone | First promised | Current date | Slips | Status | Evidence needed |
| --- | --- | --- | --- | --- | --- |
| UL electrical certification (Core) | Q4 2025 call: "late 2026" | Late Q4 2026 | 0 | In progress | 8-K or PR naming the cert |
| NSF / FDA water-quality compliance | Q1 2026 call | Case by case | 0 | In progress | Customer-specific; no single event |
| Core AWG commercial launch | Q4 2025 call | Q4 2026 | 0 | Pending cert | First purchase order or shipment PR |
| Kubota: first two Core units delivered | Q2 2026 call | Q3 2026 | 0 | Due; unconfirmed | Q3 call confirmation on ~Nov 11 |
| Prime pilot at Net Zero Innovation Hub (EU) | Q1 2026 call | "Later in 2026" | 0 | In progress | Deployment PR |
| Middle East deployments via TenX | Q4 2025 call | "Late 2026, subject to regional conditions" | 0 | Soft | Any named site |
| Core DH launch | Q1 2026 call | 2027 | 0 | Not started | — |
| Scaled commercial activity | Q4 2025 call | 2027 | 0 | Not started | Revenue guidance |

**What the card shows the holder:** the next dated milestone and days until it, the count of milestones due in the current quarter, and a flag on any row whose current date has passed with no evidence logged. For AIRJ on October 26 that reads: next milestone UL cert, due by December 31; two items due this quarter (cert, Core launch) plus one past due without confirmation (Kubota units, Q3).

**Slips are facts, not points.** A slip is shown as a count on the row and a flag on the card. Whether a holder sells on a slip is their rule, not the module's; the module only makes sure the slip is visible the day it happens, including the quiet kind where a promise stops being mentioned.

**Push alerts to the holder:** the day before an earnings call, a one-line list of which rows the call must confirm; the day after, which were confirmed, slipped, or went unmentioned. Unmentioned is the one that matters — a promise that quietly disappears from the script is the earliest slip signal there is.

## Test result, October 2026

The scored Fade Screen was tested point-in-time on 12,094 stock-months (8,941 in the 2024+ test period) across 658 pre-revenue filers, with Form 4, FINRA short interest and SEC filings. Pre-registered pass mark: four conditions at score ≥ 70. Three passed; the one that failed is the one the put trade depended on.

| Condition | Required | Found |
| --- | --- | --- |
| Months flagged | ≥ 100 | 246 |
| Fell 40% within 6 months | ≥ 2× base (48.8%) | 57.7% (2.4×) |
| Doubled within 6 months | ≤ base (13.9%) | 32.9% (2.4×) — fail |
| 6-month median vs universe | ≥ 10 pts under | −22.2% vs +0.8% |

What the result means: a 70+ score marks a stock six months from a binary, with fat tails both ways. Shorts pressing and failed catalyst carried the signal; insider selling, shelf filings and runway added nothing or lagged by a year. The spec's AIRJ walkthrough did not reproduce point-in-time (scored 0 while falling 53% in early 2024; its only 70 preceded an 84% rise) and has been removed.

Consequence, as pre-registered: no Fade tier, label or put trade ships. The module ships as the milestone ledger plus the two risk facts above, with no verdict wording.

Follow-up tests worth running on the existing data before the scored version is fully retired:

- [ ] Exclude flagged months with a dated binary (FDA, certification, first delivery) inside the 6-month window. If the doubler rate on the remainder stays above base, the signal is variance, not direction, and the scored version is closed.
- [ ] Re-run on shorts pressing and failed catalyst alone, same conditions. If the doubler rate does not move, the extra factors were never the problem.
- [ ] Separately, pre-register and test the long-side inverse (catalyst held, shorts covering, ledger clean) before any of it is shown to a holder. It was specified but never tested and is not in this version.

## Implementation notes (2026-10-26)

- **Where it lives:** the holding card on Portfolio (`components/MilestoneLedger.jsx`
  on top, the two facts under it, `RiskNotices` in `Leaps.jsx`) and a "Risks to
  watch" card on the entry chart (`components/RiskFacts.jsx`). Data: `ticker_risks`
  (nightly, `scripts/holding-risks.mjs`, `.github/workflows/holding-risks.yml`)
  and `holding_milestones` (own rows). Copy and math: `src/utils/holdingRisks.js`
  and `src/utils/milestones.js` (`npm run holdingrisks:check`, `milestones:check`).
- **Event day** is mechanical (a close up ≥ 10% on ≥ 3× its prior 20-day
  volume within the last 60 sessions) — the test's definition; "hype event"
  by type (reveal, partnership, initiation) needs a hand-entered ledger row.
- **"% of float":** XBRL carries public float in dollars, not shares, so the
  card says "% of shares out" (dei shares outstanding).
- **Both lit:** the line uses the test row for *both facts* ("1 + 2", 305
  months): 18% lower at the median, doubled one time in three — not the
  score ≥ 70 row's 22%, which is a different population. Counsel has not yet
  reviewed showing a backtested figure to subscribers; it is one sentence,
  framed as the test's reading, and can be flagged off.
- **Alerts** are bell rows (`milestone_call_tomorrow` / `milestone_call_check`,
  written by the nightly job from `earnings_calendar`); web push is not wired
  to this job yet. "Unmentioned" is the holder's own mark on a row after the
  call — the day-after alert lists what is still unconfirmed so they can set it.
- **Universe:** the card shows on every share / option holding, not only
  pre-revenue names; the facts simply stay empty on a company with no event,
  no short-interest move and no burn.
