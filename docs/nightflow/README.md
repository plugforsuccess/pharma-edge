# NIGHTFLOW — Order Flow Intelligence Engine

Buy/sell-pressure monitoring for low-float equities: CVD, sell-side
absorption, distribution risk, liquidity withdrawal and price impact.
**Monitoring, alerts and simulation only.** Nothing places orders, reads
brokerage credentials or trades automatically. The engine describes
prints and quotes. It cannot identify hidden institutions or individual
traders, and it cannot know future orders.

Route: `/orderflow` (Pulse header icon, desktop rail "NIGHTFLOW").

## Architecture

| Piece | Where | What |
|---|---|---|
| Engine (pure JS) | `src/utils/orderflow/` | classification, CVD, divergence, detectors, liquidity, score, alerts, sessions, synthetic data, backtest |
| Live engine | `dxlink-worker/src/orderflow.ts` + `dxlink-worker/src/orderflow/` (generated copy) | dxFeed TimeAndSale + Quote + Summary for the watchlist; snapshots every 5 s |
| Dilution / float | `supabase/functions/orderflow-dilution` (+ `_shared/orderflowDilution.js`, generated) | SEC EDGAR filings → 0–1 factor; Yahoo float; 12 h cache |
| Tables | `supabase/migrations/20261008010000_nightflow_orderflow.sql` | `orderflow_watchlist` (owner-managed), `orderflow_prints`, `orderflow_quotes` (30-day retention), `orderflow_state` (realtime), `orderflow_alerts` (realtime), `orderflow_dilution` |
| Page | `src/pages/OrderFlow.jsx`, `components/OrderFlowChart.jsx`, `hooks/useOrderFlowPlayback.js` | Live · Replay · Synthetic |

Real-time updates reach the browser over the Supabase Realtime WebSocket
(`postgres_changes` on `orderflow_state` / `orderflow_alerts`). After you
edit `src/utils/orderflow/`, run `npm run orderflow:sync`.
`npm run orderflow:check` fails when a copy is stale.

## Data feed: coverage, latency, licensing

**Live source: dxFeed through Tastytrade DXLink** (the worker's existing
connection).

- **Events:** `TimeAndSale` (every print). Each print carries its time,
  sequence/index, exchange code, price, size, the bid/ask at execution,
  sale conditions, `extendedTradingHours`, `validTick`, and a type of
  NEW / CORRECTION / CANCEL. `Quote` gives the NBBO with sizes and times.
  `Summary` gives the prior close.
- **Venues covered:** the consolidated tape (CTA/UTP SIPs): every
  exchange, plus FINRA TRF prints (off-exchange, ATS and dark volume
  reported to the tape).
- **Not covered:**
  - **Level 2 / depth of book.** Tastytrade's retail feed has none, so
    liquidity is the NBBO only and depth beyond it is modelled.
  - **Order IDs**, so icebergs are inferred and never identified.
  - **Overnight ATS sessions (20:00–04:00 ET)** such as Blue Ocean,
    24X overnight and Robinhood 24 Hour Market. These aren't on the
    consolidated tape in real time, so the engine **disables** analytics
    in that session (`SOURCES.dxfeed_tastytrade.sessions.overnight =
    false`).
- **Latency:**
  - TimeAndSale is a stream event: every print is delivered.
  - Quotes are conflated by the 1-second aggregation the worker requests
    (`acceptAggregationPeriod: 1`). Classification uses the NBBO stamped
    on each print, so it isn't affected; the replenishment detector sees
    at most one quote per second.
  - Snapshots are flushed every 5 s (`ORDERFLOW_FLUSH_MS`).
- **Licensing:** a retail data licence covers display on the subscriber's
  own screen. Redistributing broker or exchange data to other users needs
  vendor and exchange agreements. That is an open question for counsel;
  until it's settled, keep this an owner-only tool.
- **Share sizes:** dxFeed reports equity sizes in shares.
- **Production base URL:** the worker must run on the production base
  URL. Sandbox DXLink delivers mock data.

## Trade classification (`classify.js`)

Lee–Ready, using the quote **stamped on the print**. When the print has
none, the engine uses the latest quote at or before the trade
(`quoteLagMs` shifts it if a feed's quotes lag).

1. At or above the ask → buyer-initiated. At or below the bid → seller-initiated.
2. Inside the spread: above the midpoint → buy, below → sell.
3. At the midpoint, or with no usable quote (missing, crossed,
   one-sided, or stale beyond 5 s regular / 30 s extended hours) → tick
   rule. On a zero tick the print takes the last non-zero direction.

Some prints are kept as volume but never classified and never move
price:
- invalid ticks (feed flag);
- off-market prints (more than 3 spreads and 2% from the mid);
- sale conditions Z/U (out of sequence), L (late), W/B (average price),
  4 (derivatively priced), P (prior reference), C/N/R (cash, next day,
  seller), V/7 (contingent), G (bunched), H (price variation), and
  auction prints Q/M/O/6/5.

Corrections replace the original print by id; cancels remove it. A late
print is inserted in time order, classified only by the quote rule, and
never touches the tick state.

Candle colour is never used.

## Signals (`engine.js`)

Signals use 10-second buckets. CVD resets at each session (premarket,
regular, after hours, overnight).

- **Data gate.** Every signal requires, in the last 5 min:
  - ≥ 20 trades, ≥ 5,000 shares and ≥ $25k traded;
  - ≤ 40% of volume unclassified;
  - a good or fair quote.

  Otherwise the result is **insufficient data**, with the reasons.
- **Divergence A–E** (5-min window). "Flat" means a move within
  ½σ of the window, and never narrower than ±0.2%:
  - **A:** price up, delta ≥ 10%;
  - **B:** price up, delta ≤ −10%;
  - **C:** price flat, delta ≥ 25%;
  - **D:** price flat, delta ≤ −25%;
  - **E:** price down, delta ≤ −25%.
- **Sell-side absorption** fires only with aggressive buying (≥ 25% net)
  plus at least 2 of 4 independent conditions:
  - price impact under ⅓ of what the 30-minute fit (10-second returns vs
    signed dollar flow) expects;
  - ≥ 30% of buy volume at one level within 0.5% of the high;
  - shares bought at an ask level ≥ 3× the most ever displayed there
    (replenishment);
  - a failed resistance break.

  A positive-CVD stall on its own only raises the C alert.
- **Failed breakout.** The resistance must have been tested at least
  twice, or held for a minute or more. Price must clear it by at least one
  typical spread, and the bid must close back below it by 0.2%, within
  5 minutes and with under half the window above it.
- **Distribution:** nine factors, each 0–1, each shown with its evidence:
  - appreciation vs the prior close;
  - relative volume;
  - CVD deterioration (prior 15 min vs last 15 min);
  - rejections at the session high;
  - breakout efficiency (price gain per $ of net buying);
  - bid-$ reduction;
  - spread widening;
  - momentum;
  - SEC filings.

  Levels: insufficient (fewer than 5 factors available), watch (2 hot),
  possible (3), hazardous (5). "Sustained distribution" needs CVD
  deterioration, thinning bids and ≥ 2 rejections together.
  "Profit-taking" needs stable bids and spreads. Anything else is
  **uncertain**.
- **Liquidity:**
  - quoted spread %, and the 1-minute median vs the 30-minute median;
  - displayed bid/ask $;
  - top-of-book imbalance, or depth within 1% when a book exists;
  - withdrawal: displayed bid $ falls ≥ 50% vs its 5-minute median
    within 30 s, and selling since the bid was last full explains under
    half of the drop;
  - fitted impact in bps per $10k of net flow.
- **Hypothetical fills** for $250 / $500 / $1k / $5k / $10k / $50k /
  $100k, buy and sell, in three separate figures:
  - **Displayed:** walks the book (or the NBBO) as shown.
  - **Executable:** assumes 50% of displayed size beyond the first level
    survives. This is an assumption, not data.
  - **Model:** half-spread + square-root impact (Y = 0.8, σ from
    10-second returns, volume from the session pace).

  Displayed and executable are never conflated.

## Selling Pressure Risk Score

Initial-hypothesis weights:

| Component | Weight |
|---|---|
| CVD deterioration | 25 |
| Absorption | 20 |
| Bid deterioration | 20 |
| Failed breakouts | 15 |
| Spread expansion | 10 |
| Dilution / financing | 10 |

- Each component is 0–1 and carries its reason.
- Unavailable components are left out and the rest re-weighted. At least
  70% of the weight must be computable, and the data gate must be open,
  or the status is **insufficient**.
- Bands: 0–24 limited · 25–49 elevated caution · 50–74 potential
  distribution · 75–100 severe.
- Weights are configurable (`DEFAULT_CONFIG.weights`). **Not validated.**

## Alerts

Alert types:
- selling acceleration;
- positive CVD with a stalled price;
- **POTENTIAL SELL-SIDE ABSORPTION**;
- bid liquidity disappeared;
- failed breakout on ≥ 2× volume;
- spread widened (≥ 2× and ≥ 0.3%);
- sell-side replenishment;
- momentum exhaustion;
- possible bullish accumulation (suppressed while a seller is detected);
- distribution.

Every alert carries:
- timestamp and symbol;
- severity (1–3);
- evidence lines;
- quote quality;
- session;
- source label;
- limitations.

The same condition re-alerts only when its severity rises, or after it
has cleared and a 10-minute cooldown has passed.

## Modes and labelling

- **Live.** `orderflow_state` over realtime. With no update for 30 s the
  page says **offline** and shows nothing estimated in its place.
- **Replay.** Recorded prints and quotes for a symbol, day and session,
  run in the browser on a clock (seeking rebuilds from the start, so
  nothing after the clock is ever fed in). Each recorded alert has
  "Replay this moment".
- **Synthetic.** Five seeded scripted scenarios: accumulation, sell-side
  absorption, distribution, liquidity withdrawal, thin tape. Banner:
  *SYNTHETIC DEMO — generated data, not market data*; symbol "DEMO".

The "What's running on what" card shows which functions run on live,
replay, synthetic or model data, and which are unavailable.

## Validation (`backtest.js`, `npm run orderflow:backtest`)

**Status: not validated on real data.** The worker has to record
low-float days first: winners **and** failed breakouts.

Sources:
- `--db --symbols … --from … --to …` — recorded data (needs
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`);
- `--file days.jsonl`;
- `--synthetic` — a pipeline check only.

How it grades:
- **Labels:** selloff = a peak followed by a fall ≥ `--drop` (15%)
  within `--horizon` (60 min). Hindsight is used for labelling only.
- **Signals:** taken from causal snapshots only. The check suite asserts
  that a snapshot equals a run that never saw later events.
- **Metrics:**
  - share of selloffs with a signal from 30 min before the peak to the
    first ⅓ of the fall;
  - false-positive rate (no −5% within the horizon);
  - median time to reversal;
  - MAE (median and 90th percentile);
  - mean and median return after 5 / 15 / 60 min;
  - precision by session;
  - median cost (half-spread + modelled $10k impact).
- **Walk-forward:** the score threshold is fitted on the earliest 70% of
  dates (F1 of coverage and precision) and reported on the rest. The
  alert rule (severity ≥ 2) is reported on the test dates too.

Recalibrate weights and thresholds only on training dates, append each
attempt to a notes file, and claim nothing predictive until held-out
results support it.

## Operations

- **Watchlist:** add symbols in Live mode (owner only; RLS on
  `profiles.is_admin`). The worker picks them up within 5 minutes, up to
  `ORDERFLOW_MAX_SYMBOLS` (25).
- **Worker env:** `ORDERFLOW_FLUSH_MS` (5000), `ORDERFLOW_RETAIN_DAYS`
  (30), `ORDERFLOW_MAX_SYMBOLS` (25). Deploy the worker as usual (see
  `dxlink-worker/README.md`). Nothing runs live until it's deployed.
- **Dilution function env:** optional `SEC_USER_AGENT` (EDGAR asks
  automated clients to identify themselves).
- **Tests:** `npm run orderflow:check` covers classification, sessions,
  cancels/corrections/late prints, CVD resets, coverage gating, the A–E
  divergences, the impact walk, dilution, all synthetic scenarios, alert
  fields and dedupe, score coverage, no look-ahead, and the backtest.
