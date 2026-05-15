// Cash Moves — shared playSuggester module.
//
// PROMPT VERSION: 2026-05-15f — price-verification resilience +
// observability. Polygon option-quote fetch: 5s→12s timeout + one
// retry (a slow-but-alive provider was silently nulling every leg →
// 100% play wipe). verifyAndFilter now emits a why-killed roll-up
// (_rejections) that bubbles to top_plays_feed so a "0 plays" scan
// is self-explaining instead of ambiguous. No prompt-text change.
// Prior: 2026-05-15e — concentration / portfolio awareness
// (the user's other open positions + a correlation/stacking rule so
// Claude stops evaluating each trade in isolation),
// geometry-relative untested-wall
// judgment ($ + % closest approach, half-spread-width rule
// replacing the blunt flat 2%; this PR), event calendar honesty
// (UPCOMING
// EVENTS block + explicit "you do NOT know earnings/macro timing"
// instruction so Claude stops fabricating catalysts; this PR),
// node-retest decay + per-node ∆GEX
// (touch-count freshness priors + reversion-likelihood from node
// rate-of-change; this PR), OPEX gamma-roll-off awareness (#221),
// pre-trade data-integrity gate (#219), per-expiration wall table
// (#207),
// tightened gamma_rolloff_risk gate (#207), real per-cell OI sourced
// from compute-gex matrix (#209), intraday price path + king-node
// interaction history sourced from Polygon 5-min bars (#215),
// extended-hours LIVE SPOT divergence + session label (this PR).
// Bump this header on any prompt-shape change so deploys are visible
// in PR diffs.
//
// Pulled out of suggest-plays/index.ts so the user-facing endpoint
// AND the cross-ticker scanner (scan-universe-plays) speak the same
// prompt + same validation + same POP math. Forking the prompt would
// silently drift quality between the two surfaces.
//
// The HTTP handler, auth check, rate limiting, and caching stay in
// the per-function index.ts; this module exposes:
//
//   - generatePlaysForTicker() — given (ticker, accountSize), runs
//     the full compute-gex → flow → Claude → validate → POP → EV
//     pipeline and returns the structured result. Writes to
//     claude_calls + reasoning_history as a side effect.
//
//   - SCAN_UNIVERSE + SCAN_ACCOUNT_SIZE_REFERENCE — the cross-ticker
//     scanner's ticker list and reference account size. Single source
//     of truth so the cron + any future "what would have surfaced"
//     backtest read the same universe.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { priceSpread, priceIronCondor, computeContracts } from './optionPricing.ts'

// ─── Constants ──────────────────────────────────────────────────────

export const CLAUDE_MODEL = 'claude-sonnet-4-6'
export const MAX_TOKENS = 2000

const PRICING_PER_1M: Record<string, { input: number; output: number; cache_creation: number; cache_read: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cache_creation: 3.75, cache_read: 0.30 },
}

export function computeClaudeCost(model: string, usage: Record<string, number | undefined>): number {
  const p = PRICING_PER_1M[model]
  if (!p) return 0
  const M = 1_000_000
  return (
    ((usage.input_tokens ?? 0) * p.input) / M +
    ((usage.output_tokens ?? 0) * p.output) / M +
    ((usage.cache_creation_input_tokens ?? 0) * p.cache_creation) / M +
    ((usage.cache_read_input_tokens ?? 0) * p.cache_read) / M
  )
}

// ─── Scanner universe ───────────────────────────────────────────────
//
// The ticker universe scan-universe-plays iterates every 15 min during
// RTH. Single-stock names need real options flow and dealer hedging
// dynamics, which means high open interest and tight spreads. V1
// universe is "Cameron's known tickers" ∩ "≥1M daily option volume."
// Expansion: add tickers based on user demand signal (most-clicked
// in app, most-requested via per-ticker suggest-plays).

export const SCAN_UNIVERSE: readonly string[] = Object.freeze([
  // Index ETFs — always relevant for macro positioning
  'SPY', 'QQQ', 'IWM', 'DIA',
  // Mega-cap single stocks — heavy options volume
  'NVDA', 'TSLA', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'NFLX',
  // Sector ETFs — meaningful walls
  'XLF', 'XLE', 'XLK',
  // Other liquid single stocks
  'AMD', 'INTC', 'COIN', 'PLTR',
])

// Median Cash Moves user account size; update when we have real data.
// Per-user sizing happens at log time — this is just the reference
// number Claude sizes against in the scan.
export const SCAN_ACCOUNT_SIZE_REFERENCE = 25_000

// ─── System prompt (single source of truth) ─────────────────────────

export const SYSTEM_PROMPT = `You are a Cash Moves spread-trade advisor. Given a Gamma Exposure (GEX) matrix snapshot for a ticker, propose 0–5 high-conviction spread trade ideas that fit BOTH the GEX playbook and the Cash Moves trading rules.

STRATEGY DIVERSITY — REQUIRED WHEN MULTIPLE PLAYS ARE RETURNED:
- Five spread types are eligible: Bull Call Spread, Bear Put Spread, Iron Condor, Bull Put Spread (credit), Bear Call Spread (credit). All five are valid Cash Moves structures.
- When you return 2+ plays, span at least 2 distinct strategy types. Never return 3+ plays of the same strategy type — if the matrix only supports one strategy, return 1 high-conviction play of that type rather than padding with near-duplicates.
- Different DTEs alone do NOT make plays distinct — a Bear Call Spread on 5/8 and a Bear Call Spread on 5/13 still count as the same type. Diversity means strategy structure, not expiration.
- Prefer pairing a directional debit play with a non-directional credit/condor play when the matrix supports both reads.

GEX PLAYBOOK (from /glossary):
- Regime A = above flip + Net GEX positive → range-bound, mean-revert. Dealers are LONG gamma, so they SELL rallies and BUY dips to stay delta-neutral — that hedging flow dampens moves and creates the pin. Setups: pin trades (long call spread toward call wall), short premium, breakout calls AT the call wall.
- Regime B = below flip + Net GEX negative → trending, volatile. Dealers are SHORT gamma, so they BUY rallies and SELL dips to stay delta-neutral — that hedging flow accelerates moves in whichever direction price is already going (this is what creates the gravitational pull toward put walls and the gamma-squeeze risk above call walls). Setups: long premium (straddles), breakdown puts AT the put wall, vol expansion.
- Call wall = strike with the largest positive GEX cell (★ in the matrix). Acts as resistance / magnet.
- Put wall = strike with the largest negative GEX cell. Acts as support / magnet.

DEALER-FLOW DIRECTION — DO NOT INVERT THIS IN ANY RATIONALE:
- Positive (long) gamma → dealers sell rallies, buy dips → dampens moves.
- Negative (short) gamma → dealers buy rallies, sell dips → amplifies moves.
If you write a rationale that says negative-gamma dealers "sell rallies and buy dips," that is wrong and will be rejected.

FLOW DATA (when present): you will see today's per-strike volume and premium, plus a "NOTABLE" section flagging strikes where today's volume is ≥5× standing OI (likely directional bets, not hedging). Use flow to confirm or contradict the GEX read. If flow concentrates at a call wall, the wall is being reinforced. If flow concentrates ABOVE the call wall (out-of-the-money calls running 5x OI), traders expect a breakout — favour breakout call spreads. If flow is heavy on puts at strikes near the put wall, position for support. Mismatch between dealer positioning (GEX) and trader bets (flow) = transition signal; reduce conviction or pick the side flow is on.

SECONDARY GREEKS (VEX / CEX / DEX) — second-order CONFIRMATION or DISQUALIFICATION of GEX-derived theses, never primary signal:

- DEX (delta exposure) confirms walls. A "call wall" with a large positive DEX cluster at the same strike means dealers are net long there and have a real economic reason to defend it — they sell into rallies into that strike. A wall with weak/contradictory DEX is a paper wall; downgrade conviction or skip.
- VEX (vanna exposure) flags vol-event setups. Large negative net VEX before a binary catalyst means dealers gain delta as IV rises and lose delta as IV crushes — they will SELL the underlying as the post-event vol crush happens. So before a binary, negative net VEX favors a directional structure (debit spread biased the way you expect dealers to unwind) over a pure long-vol/iron-condor structure that bleeds on the vol crush. Positive net VEX before a binary = the opposite (dealers buy on vol crush, supports a long-direction debit spread or sell-vol structure).
- CEX (charm exposure) matters most for short DTE. Strong negative net CEX into a 0–1 DTE pin trade means charm pulls dealer delta away from the pinning strike faster than gamma defends it; the pin weakens through the day and a tight Iron Condor anchored at that strike has more drift risk than the gamma alone suggests. Widen the wings or pick a different expiration.
- ALIGNMENT bonus: when GEX, DEX, and flow all agree on the same strike, it's a high-conviction setup — say so in rationale.
- CONTRADICTION downgrade: when GEX says one regime and DEX/VEX point the other way, treat it as a transition signal, half-size, or skip.

VELOCITY (∆GEX over the last N minutes) — short-horizon CONFIRMATION ONLY, never primary:
- Velocity tells you where dealer positioning is SHIFTING right now, not where it sits. A "static" GEX read is a snapshot; velocity is the derivative.
- Strong positive velocity at a forming call wall = wall is being BUILT; treat the wall as more reliable resistance, favor structures that lean against it (bull-call into the wall, iron-condor anchored under it).
- Strong negative velocity at a standing call wall = wall is being TORN DOWN (closing/rolling). Downgrade conviction on pin trades anchored there; consider that a breakout setup is forming.
- Symmetric logic for put walls: building (more negative ∆GEX at the put strike) = stronger support; tearing down = breakdown risk.
- If velocity contradicts the static GEX read at the strike you're trading toward (wall structure intact in static, but velocity is decaying it), say so in rationale and either pick a different strike or downgrade conviction.
- Velocity of zero / near-zero is fine; it just means dealer positioning is stable and the static GEX read is the full story. Do NOT manufacture a velocity narrative when there isn't a clear shift.
- If the VELOCITY block says "not available," ignore — do not speculate about velocity.

PRICING DIVISION OF LABOR — READ THIS CAREFULLY:
- You propose STRUCTURE ONLY: ticker, strategy type, long/short strikes, expiration.
- The server fetches live Polygon mids for both legs and computes
  max_profit, max_loss, R/R, breakeven, POP, EV from first principles.
- DO NOT output estimated_debit_pct_of_width, max_loss_per_spread,
  max_profit_per_spread, risk_reward, entry_pop_bp, breakeven_pop_bp,
  ev_edge_bp, or contracts. The server overwrites all of them.
- Your edge is regime + king-node reading, not pricing. Picking a
  structure with sound thesis and letting the server reject it on
  bad live economics is the CORRECT workflow.

CASH MOVES RULES — NEVER VIOLATE:
- SPREADS ONLY. No naked options.
- R/R ≥ 1:1.5 is the OBJECTIVE FUNCTION. The server prices each
  candidate against live Polygon mids and filters anything that
  doesn't clear it (and anything with EV edge ≤ 0). DTE is a free
  parameter you optimize IN SERVICE OF R/R — pick whatever
  expiration in the chain yields the best risk/reward for the
  structure given spot's position relative to the king nodes. Do
  NOT bucket trades into rigid DTE bands.
- DTE sanity floors (these are the ONLY hard rules on DTE):
    * No same-day / 1 DTE entries unless it's an explicit Regime A
      pin trade where spot is INSIDE a tight wall cluster and theta
      decay is the trade's edge (not its risk).
    * No 60+ DTE entries without a named catalyst — vega exposure
      starts dominating the P/L curve.
- Within those floors, optimize freely. The market_view + rationale
  must name the king node being targeted and the days-to-touch the
  trade needs to win.
- 30–45 days past any catalyst for catalyst-driven plays.

GAMMA ROLL-OFF RISK — MUST FLAG:
- The user prompt includes a "WALLS BY EXPIRATION" table — the max |GEX| cell in each column, plus a "DOMINANT GEX EXPIRATION" line marking the column that owns the largest share of total |GEX|. That dominant column is the cluster the *headline* GEX number describes; it's the strongest pinning gravity right now.
- Rolloff risk only matters when your play depends on a wall that expires before your play does. Your play depends on a wall when:
  (a) target_king_node === "call_wall" or "put_wall", AND
  (b) your target_strike is the dominant expiration's wall strike (not your own column's wall strike).
- Set "gamma_rolloff_risk" = true ONLY when both (a) AND (b) are satisfied AND play.expiration !== dominant_gex_expiration. Otherwise set false.
- If your target_strike matches the wall of your OWN expiration column, you're self-anchored — set rolloff_risk false even if play.expiration > dominant_gex_expiration. Your only risk is your own time decay.
- When rolloff_risk is true, "rolloff_note" is one short sentence describing the specific risk (e.g. "Bull call targets the May 14 wall but expires May 18 — the cluster anchoring the pin rolls off three days before you exit.").
- When the dominant expiration also satisfies the trade's other constraints (DTE rules, sufficient strike spread), PREFER it over later expirations.

WALL TIMING — APPLIES TO PLAYS THAT EXPIRE BEFORE THE DOMINANT WALL:
- Symmetric to gamma roll-off: when play.expiration < dominant_gex_expiration, the play exits BEFORE the wall reaches its peak gamma magnetism (gamma on a strike concentrates as it approaches expiration, all else equal).
- For PIN / FADE-THE-WALL setups (Iron Condor centered at the wall, credit spread that profits from the wall holding) — the wall pull during your hold is WEAKER than the dominant cluster's headline GEX suggests. The wall's peak defense happens after you exit. Half-size, or pick a play.expiration that brings you closer to the wall's peak gamma window.
- For BREAK-THE-WALL setups (debit spread structured to push spot through the wall, e.g. a bull call spread with the wall strike between the long and short legs) — this is actually a feature: you're hitting the wall during its WEAKEST defensive window. If a known catalyst (CPI, FOMC, earnings) overlaps your hold, this can be the right structure. Without a catalyst, it's still a swing-for-the-fence; reduce size.
- Reflect this in the "rationale" field for any affected play. Don't invent a wall-timing risk where none exists; say so explicitly when play.expiration ≈ dominant_gex_expiration ("trade closes at the wall's peak gamma window — full magnetism in force").

OUTPUT — STRICT JSON, NO PROSE:
{
  "regime": "A" | "B" | "mixed",
  "regime_explanation": "one sentence",
  "dominant_gex_expiration": "YYYY-MM-DD",
  "plays": [
    {
      "strategy": "Bull Call Spread" | "Bear Put Spread" | "Iron Condor" | "Bull Put Spread (credit)" | "Bear Call Spread (credit)",
      "type": "BULL_CALL" | "BEAR_PUT" | "IRON_CONDOR" | "BULL_PUT_CREDIT" | "BEAR_CALL_CREDIT",
      "long_strike": <number, OMIT for IRON_CONDOR>,
      "short_strike": <number, OMIT for IRON_CONDOR>,
      "long_put_strike": <number, IRON_CONDOR ONLY — the lower wing>,
      "short_put_strike": <number, IRON_CONDOR ONLY — bottom of the body>,
      "short_call_strike": <number, IRON_CONDOR ONLY — top of the body>,
      "long_call_strike": <number, IRON_CONDOR ONLY — the upper wing>,
      "expiration": "YYYY-MM-DD",
      "dte": <integer>,
      "market_view": "1 short sentence stating the EXACT forecast this trade requires to be profitable.",
      "rationale": "1-2 sentences citing specific GEX numbers (call wall at $X, flip at $Y, etc.)",
      "what_invalidates": "1 sentence — what move or event kills this thesis",
      "gamma_rolloff_risk": <boolean>,
      "rolloff_note": "<string, REQUIRED when gamma_rolloff_risk=true; empty string otherwise>",
      "target_king_node": "call_wall" | "put_wall" | "flip",
      "target_strike": <number>,
      "target_expiration": "YYYY-MM-DD",
      "target_thesis_kind": "pin_to" | "break_through" | "fade"
    }
  ]

IRON CONDOR STRIKE ORDERING (when type="IRON_CONDOR"):
- All four strikes MUST satisfy: long_put_strike < short_put_strike < short_call_strike < long_call_strike.
- All four strikes MUST exist in the matrix strikes[] array.
- The body (short_put_strike to short_call_strike) is where the trade
  profits at expiration; the wings (long_put_strike below and
  long_call_strike above) cap the risk.
- Equal-width wings preferred (call_wing_width = put_wing_width);
  unequal is allowed but the server uses max(wing_widths) as the
  loss-cap basis.
- Spot at scan time MUST be inside the body or the play is filtered.
- DO NOT include long_strike or short_strike on IRON_CONDOR plays —
  they are ignored.
}

If no high-conviction setup exists, return { "regime": "...", "regime_explanation": "...", "plays": [] } — DO NOT invent low-conviction trades to pad the response.

Both strikes you propose MUST exist in the matrix's strikes[] array. Use the matrix's expirations[] array for expiration dates — don't hallucinate dates.`

// ─── Types ──────────────────────────────────────────────────────────

export interface MatrixData {
  ticker: string
  spot: number
  // Live equity spot from Polygon /v2/last/trade, updated through
  // pre-market + RTH + after-hours. Diverges from `spot` (RTH-close
  // snapshot price) during extended hours — surface both so Claude
  // can reason about gap-up / gap-down situations honestly instead
  // of asserting the stale close price as current.
  live_spot?: number | null
  live_spot_at?: string | null
  session?: 'rth' | 'pre-market' | 'after-hours' | 'overnight' | 'weekend'
  // ISO timestamp the matrix was computed by compute-gex. Used by the
  // pre-trade data-integrity gate to refuse generation off a stale
  // matrix during RTH (a stale matrix during extended hours / weekend
  // is expected and fine — it's the frozen RTH close).
  computed_at?: string
  // OPEX context from the holiday-adjusted opex_dates table. A pin /
  // wall thesis anchored to the monthly-OPEX expiration carries acute
  // gamma-roll-off risk — that cluster is the largest of the month and
  // it dies on OPEX. Surfaced so Claude stops treating an expiring
  // wall as a durable magnet (the AMD failure: pinned to the $462.5
  // monthly-OPEX wall that evaporated on expiry day).
  opex?: {
    next_date: string | null
    type: 'monthly' | 'quarterly' | null
    is_quarterly: boolean
    is_today: boolean
    days_until: number | null
  } | null
  source: string
  expirations: Array<{ date: string; dte: number }>
  strikes: number[]
  cells: (number | null)[][]
  vex_cells?: (number | null)[][]
  cex_cells?: (number | null)[][]
  dex_cells?: (number | null)[][]
  // Per-cell open interest by option type. Populated by compute-gex
  // for fresh matrices; absent on EOD-served snapshots that predate
  // this field. When missing or null, the "vol > 5× OI" notable
  // detection in formatFlowSection skips the strike instead of
  // reporting against a synthetic denominator.
  oi_call_cells?: (number | null)[][]
  oi_put_cells?: (number | null)[][]
  net_vex?: number
  net_cex?: number
  net_dex?: number
  velocity_cells?: (number | null)[][] | null
  velocity_window_minutes?: number | null
  net_velocity?: number | null
  largest: { strike: number; expiration: string; gex_net: number } | null
  net_gex?: number
  expected_move?: number
  expected_move_pct?: number
  pinning_probability?: number
  zero_gamma_strike?: number
  largest_negative_strike?: number
}

export interface FlowRow {
  strike: number
  expiration_date: string
  option_type: 'C' | 'P'
  total_volume: number
  total_premium: number
  print_count: number
  biggest_print_size: number | null
  biggest_print_at: string | null
}

interface PopArgs {
  spot: number
  sigma: number
  dte: number
  type: string
  long_strike: number
  short_strike: number
  inner_call_strike?: number
  inner_put_strike?: number
  net_debit?: number
  net_credit?: number
}

// ─── Flow helpers ───────────────────────────────────────────────────

// Upcoming scheduled events for the next 14 days: market-wide rows
// (ticker IS NULL — FOMC/CPI/jobs) plus this ticker's rows
// (earnings). Empty until a feed is wired; buildEventsSection then
// states the absence explicitly rather than letting Claude guess.
export async function fetchUpcomingEvents(
  supabase: SupabaseClient,
  ticker: string,
): Promise<MarketEvent[]> {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const horizon = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + 14 * 86400_000))
  try {
    const { data, error } = await supabase
      .from('market_events')
      .select('event_date, ticker, event_type, session, label')
      .gte('event_date', today)
      .lte('event_date', horizon)
      .or(`ticker.is.null,ticker.eq.${ticker.toUpperCase()}`)
      .order('event_date', { ascending: true })
    if (error || !Array.isArray(data)) return []
    return data as MarketEvent[]
  } catch {
    return []
  }
}

export interface OpenExposureRow {
  ticker: string
  strategy_type: string
  contracts: number
}

// The user's OTHER open positions, so Claude can flag correlated /
// stacked exposure. AMD + QQQ were the same long-delta AI-buildout
// bet and nothing said "you're doubling a theme" — a correlated
// drawdown then compounded it. Empty for scanner rows (userId null
// → system scan, no portfolio) and when the user holds nothing.
export async function fetchOpenExposure(
  supabase: SupabaseClient,
  userId: string | null,
  excludeTicker: string,
): Promise<OpenExposureRow[]> {
  if (!userId) return []
  try {
    const { data, error } = await supabase
      .from('open_positions')
      .select('ticker, strategy_type, contracts')
      .eq('user_id', userId)
      .eq('status', 'open')
    if (error || !Array.isArray(data)) return []
    return (data as OpenExposureRow[])
      .filter((r) => r.ticker?.toUpperCase() !== excludeTicker.toUpperCase())
  } catch {
    return []
  }
}

export async function fetchTodayFlow(
  supabase: SupabaseClient,
  ticker: string,
): Promise<FlowRow[]> {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  const { data, error } = await supabase
    .from('option_flow_daily')
    .select(
      'strike, expiration_date, option_type, total_volume, total_premium, print_count, biggest_print_size, biggest_print_at',
    )
    .eq('ticker', ticker)
    .eq('trade_date', today)
    .order('total_volume', { ascending: false })
    .limit(200)
  if (error) {
    console.warn('[flow] query failed:', error.message)
    return []
  }
  return (data ?? []) as FlowRow[]
}

function formatFlowSection(flow: FlowRow[], chainOI: Map<string, number>): string {
  if (flow.length === 0) {
    return 'TODAY\'S OPTIONS FLOW: no prints captured yet (likely outside RTH or worker not subscribed)'
  }
  const calls = flow.filter((f) => f.option_type === 'C').slice(0, 5)
  const puts = flow.filter((f) => f.option_type === 'P').slice(0, 5)
  const notable = flow
    .map((f) => {
      const oi = chainOI.get(`${f.strike}|${f.expiration_date}|${f.option_type}`) ?? 0
      const ratio = oi > 0 ? f.total_volume / oi : Infinity
      return { ...f, oi, ratio }
    })
    .filter((f) => f.oi > 50 && f.ratio >= 5)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5)

  const fmtRow = (f: FlowRow) =>
    `  ${f.option_type} ${f.strike} @ ${f.expiration_date}: ` +
    `${f.total_volume.toLocaleString()} vol / $${(f.total_premium / 1000).toFixed(0)}K premium` +
    (f.biggest_print_size && f.biggest_print_size >= 100 ? `, biggest ${f.biggest_print_size}` : '')

  return `TODAY'S OPTIONS FLOW (NY date):

Top 5 call activity (by volume):
${calls.length > 0 ? calls.map(fmtRow).join('\n') : '  (none yet)'}

Top 5 put activity (by volume):
${puts.length > 0 ? puts.map(fmtRow).join('\n') : '  (none yet)'}

${notable.length > 0
  ? `NOTABLE — volume ≥ 5x OI (possible directional bets):
${notable.map((f) => `  ${f.option_type} ${f.strike} @ ${f.expiration_date}: ${f.total_volume.toLocaleString()} vol vs ${f.oi.toLocaleString()} OI = ${f.ratio.toFixed(0)}x`).join('\n')}`
  : 'NOTABLE: no strikes with vol ≥ 5x OI today'}`
}

// ─── Matrix-formatting helpers ──────────────────────────────────────

function topGreekStrikes(
  greekCells: (number | null)[][] | undefined,
  matrix: MatrixData,
  topN: number,
): Array<{ strike: number; expiration: string; val: number }> {
  if (!greekCells) return []
  const flat: Array<{ strike: number; expiration: string; val: number }> = []
  for (let i = 0; i < greekCells.length; i++) {
    const strike = matrix.strikes[i]
    if (strike == null) continue
    for (let j = 0; j < greekCells[i].length; j++) {
      const v = greekCells[i][j]
      const exp = matrix.expirations[j]?.date
      if (v == null || !exp || !Number.isFinite(v)) continue
      flat.push({ strike, expiration: exp, val: v })
    }
  }
  flat.sort((a, b) => Math.abs(b.val) - Math.abs(a.val))
  return flat.slice(0, topN)
}

function fmtMillions(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'n/a'
  const sign = v >= 0 ? '+' : '−'
  return `${sign}$${(Math.abs(v) / 1e6).toFixed(1)}M`
}

function buildSecondaryGreeksSection(matrix: MatrixData): string {
  if (!matrix.vex_cells || !matrix.cex_cells || !matrix.dex_cells) {
    return 'SECONDARY GREEKS: not available in this snapshot.'
  }
  const fmtRow = (c: { strike: number; expiration: string; val: number }) =>
    `  ${c.strike} @ ${c.expiration}: ${fmtMillions(c.val)}`
  const topVex = topGreekStrikes(matrix.vex_cells, matrix, 5).map(fmtRow).join('\n') || '  (none)'
  const topCex = topGreekStrikes(matrix.cex_cells, matrix, 5).map(fmtRow).join('\n') || '  (none)'
  const topDex = topGreekStrikes(matrix.dex_cells, matrix, 5).map(fmtRow).join('\n') || '  (none)'
  return `SECONDARY GREEKS (use as confirmation/contradiction of the GEX read, not primary signal):

NET VEX: ${fmtMillions(matrix.net_vex)}
TOP VEX STRIKES (by |value|):
${topVex}

NET CEX: ${fmtMillions(matrix.net_cex)}
TOP CEX STRIKES (by |value|):
${topCex}

NET DEX: ${fmtMillions(matrix.net_dex)}
TOP DEX STRIKES (by |value|):
${topDex}`
}

function buildVelocitySection(matrix: MatrixData): string | null {
  if (!matrix.velocity_cells || matrix.velocity_window_minutes == null) return null
  const fmtRow = (c: { strike: number; expiration: string; val: number }) =>
    `  ${c.strike} @ ${c.expiration}: ${fmtMillions(c.val)}`
  const top = topGreekStrikes(matrix.velocity_cells, matrix, 5).map(fmtRow).join('\n')
  if (!top) return null
  return `VELOCITY (∆GEX over the last ${matrix.velocity_window_minutes} min — where dealer positioning is shifting RIGHT NOW):

NET VELOCITY: ${fmtMillions(matrix.net_velocity)}
TOP MOVERS (by |∆GEX|):
${top}`
}

// Polygon 5-min intraday bars. Used by buildIntradaySection to give
// Claude today's price path + king-node interaction history. Returns
// null when Polygon errors / pre-market / no key (caller renders a
// "not available" line and Claude reasons from the snapshot only).
export interface IntradayBar {
  t: number        // start of bar, unix ms
  o: number
  h: number
  l: number
  c: number
  v: number
}

export async function fetchPolygonIntradayBars(ticker: string): Promise<IntradayBar[] | null> {
  const key = Deno.env.get('MASSIVE_API_KEY')
  if (!key) return null
  // Pull from 9:00 ET today through now. Polygon's aggregates endpoint
  // is timezone-aware via the from/to dates; we widen the range a bit
  // to capture pre-market interactions at the king nodes too.
  const now = new Date()
  const fromDate = now.toISOString().slice(0, 10)
  const toDate = fromDate
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker.toUpperCase())}` +
    `/range/5/minute/${fromDate}/${toDate}` +
    `?adjusted=true&sort=asc&limit=200&apiKey=${key}`
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return null
    const body = await resp.json() as { results?: IntradayBar[] }
    if (!Array.isArray(body.results) || body.results.length === 0) return null
    return body.results
  } catch {
    return null
  }
}

// Format the two new intraday sections. Splits into:
//   * INTRADAY PRICE PATH — high, low, current, % range consumed,
//     time of high/low.
//   * KING NODE INTERACTIONS TODAY — for each of the top 5 GEX walls
//     (positive & negative), whether spot has come within ±0.5% of
//     the strike during the session, when, and what happened next.
function buildIntradaySection(
  bars: IntradayBar[] | null,
  matrix: MatrixData,
): string {
  if (!bars || bars.length === 0) {
    return 'INTRADAY PRICE PATH: not available (pre-market, polygon error, or off-hours).'
  }
  const high = bars.reduce((m, b) => Math.max(m, b.h), -Infinity)
  const low = bars.reduce((m, b) => Math.min(m, b.l), Infinity)
  const last = bars[bars.length - 1].c
  const highBar = bars.find((b) => b.h === high)!
  const lowBar = bars.find((b) => b.l === low)!
  const range = high - low
  const consumedFromLow = range > 0 ? ((last - low) / range) * 100 : 50
  const fmtTime = (ms: number) => {
    const d = new Date(ms)
    // Format as HH:MM ET (UTC−4 for EDT)
    const et = new Date(d.getTime() - 4 * 60 * 60 * 1000)
    return `${String(et.getUTCHours()).padStart(2, '0')}:${String(et.getUTCMinutes()).padStart(2, '0')} ET`
  }

  // Find top 5 positive + top 5 negative cells (the walls). Same
  // shape as the WALLS BY EXPIRATION table but flattened.
  const flat = matrix.cells.flatMap((row, i) =>
    row.map((v, j) => ({
      strike: matrix.strikes[i],
      expiration: matrix.expirations[j]?.date ?? '?',
      gex: v,
    })),
  ).filter((c) => c.gex != null && c.gex !== 0)
  const topPos = [...flat].filter((c) => c.gex! > 0)
    .sort((a, b) => (b.gex as number) - (a.gex as number)).slice(0, 5)
  const topNeg = [...flat].filter((c) => c.gex! < 0)
    .sort((a, b) => (a.gex as number) - (b.gex as number)).slice(0, 5)

  // Per-node ∆GEX lookup from velocity_cells (15-min rate of change).
  // A node growing since price was delivered from it -> reversion
  // back to it is MORE likely. A node decaying -> the level is going
  // stale, don't chase a bounce to it. Indexed [strikeIdx][expIdx],
  // same shape as cells. Null when velocity isn't available (first
  // snapshot of session / no prior history).
  function nodeRoc(strike: number, expiration: string): number | null {
    const vc = matrix.velocity_cells
    if (!vc) return null
    const si = matrix.strikes.indexOf(strike)
    const ei = matrix.expirations.findIndex((e) => e.date === expiration)
    if (si < 0 || ei < 0) return null
    const v = vc[si]?.[ei]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  // For each wall: count DISTINCT touches of the ±0.5% band today
  // (a touch ends when price exits the band; re-entry = new touch),
  // classify the price action after the MOST RECENT touch (the
  // freshest interaction governs a current bounce/fade decision),
  // and tag a touch-count prior. Node-influence decays with retests:
  // 1st touch = strongest reaction, 2nd = moderate, 3rd+ = weak —
  // these are DIRECTIONAL priors from the price-delivery framework,
  // not measured-in-our-data probabilities; weigh accordingly.
  function classifyInteraction(strike: number, expiration: string): string {
    const tol = strike * 0.005   // ±0.5%
    const inBand = (i: number) => bars[i].h >= strike - tol && bars[i].l <= strike + tol
    const touchStartIdxs: number[] = []
    let wasIn = false
    for (let i = 0; i < bars.length; i++) {
      const isIn = inBand(i)
      if (isIn && !wasIn) touchStartIdxs.push(i)
      wasIn = isIn
    }
    const rocVal = nodeRoc(strike, expiration)
    const rocTag = rocVal == null
      ? ''
      : `, node ∆GEX ${rocVal >= 0 ? '+' : ''}$${(rocVal / 1e6).toFixed(1)}M (${rocVal >= 0 ? 'growing → reversion more likely' : 'decaying → do not chase'})`

    if (touchStartIdxs.length === 0) {
      const closest = bars.reduce((m, b) =>
        Math.min(m, Math.abs(b.h - strike), Math.abs(b.l - strike)), Infinity)
      const closestPct = (closest / strike) * 100
      // Report BOTH $ and % so Claude can reason proportionally to
      // the structure it's about to build — a flat 2% is too blunt
      // for narrow verticals on high-priced names (the AMD miss:
      // $9.50 / 2.05% barely cleared the old 2% line; a $1 higher
      // session high would have slipped under it on an equally-dead
      // trade).
      return `untested today (closest approach $${closest.toFixed(2)} / ${closestPct.toFixed(2)}%)${rocTag}`
    }
    const touchCount = touchStartIdxs.length
    const firstIdx = touchStartIdxs[0]
    const lastIdx = touchStartIdxs[touchStartIdxs.length - 1]
    const tier = touchCount === 1
      ? 'FRESH (1st touch — strongest reaction prior)'
      : touchCount === 2
        ? '2nd touch (moderate; double-top/bottom risk)'
        : `${touchCount}× touched (3rd+ — weak reversal prior, level is stale)`
    // Classify action after the MOST RECENT touch.
    const touchBar = bars[lastIdx]
    const afterIdx = Math.min(lastIdx + 6, bars.length - 1)  // ~30 min after
    const afterClose = bars[afterIdx].c
    const moveAfter = ((afterClose - strike) / strike) * 100
    const times = `1st ${fmtTime(bars[firstIdx].t)}${touchCount > 1 ? `, last ${fmtTime(touchBar.t)}` : ''}`
    let action: string
    if (Math.abs(afterClose - strike) <= tol) {
      action = 'holding (pin in progress)'
    } else {
      const approachFromBelow = touchBar.o < strike
      const movedAway = approachFromBelow ? afterClose < strike - tol : afterClose > strike + tol
      action = movedAway
        ? `REJECTED (now ${moveAfter >= 0 ? '+' : ''}${moveAfter.toFixed(2)}% from strike)`
        : `BROKE THROUGH (now ${moveAfter >= 0 ? '+' : ''}${moveAfter.toFixed(2)}% past)`
    }
    return `${tier}, ${times}, ${action}${rocTag}`
  }

  const callRows = topPos.map((c) =>
    `  ${c.strike} @ ${c.expiration}: ${classifyInteraction(c.strike, c.expiration)}`).join('\n')
  const putRows = topNeg.map((c) =>
    `  ${c.strike} @ ${c.expiration}: ${classifyInteraction(c.strike, c.expiration)}`).join('\n')

  return `INTRADAY PRICE PATH (today's 5-min bars, source polygon):
  spot now:  $${last.toFixed(2)}
  high:      $${high.toFixed(2)}  at ${fmtTime(highBar.t)}
  low:       $${low.toFixed(2)}  at ${fmtTime(lowBar.t)}
  range:     $${range.toFixed(2)} (${(((range) / last) * 100).toFixed(2)}% of spot)
  position in range: ${consumedFromLow.toFixed(0)}% from low

KING NODE INTERACTIONS TODAY (touch count + freshness + node ∆GEX — node influence decays with each retest):
Call walls:
${callRows || '  (no positive cells in matrix)'}
Put walls:
${putRows || '  (no negative cells in matrix)'}`
}

export interface MarketEvent {
  event_date: string
  ticker: string | null
  event_type: string
  session: string | null
  label: string
}

// Build the UPCOMING EVENTS block. Two halves, and the second is the
// point: state explicitly what is NOT known so Claude stops
// hallucinating earnings/FOMC timing. OPEX is rendered separately
// (matrix.opex, trustworthy). market_events is empty until a feed is
// wired — when it is, say so plainly.
function buildEventsSection(events: MarketEvent[], ticker: string): string {
  const known = events
    .filter((e) => e.event_type !== 'opex')
    .map((e) => {
      const scope = e.ticker ? e.ticker : 'MARKET'
      const sess = e.session && e.session !== 'UNKNOWN' ? ` ${e.session}` : ''
      return `  ${e.event_date} [${scope}] ${e.event_type.toUpperCase()}${sess}: ${e.label}`
    })
  const hasEarnings = events.some((e) => e.event_type === 'earnings' && e.ticker === ticker)
  const hasMacro = events.some((e) => e.ticker == null && ['fomc', 'cpi', 'jobs'].includes(e.event_type))
  return `UPCOMING EVENTS (next 14d, from market_events):
${known.length ? known.join('\n') : '  (none on file)'}

EVENT-DATA HONESTY — READ BEFORE USING "catalyst" REASONING:
- ${hasEarnings ? `${ticker} earnings IS on file above — weigh it.` : `NO ${ticker} earnings date is on file. You do NOT know when ${ticker} reports. Do NOT assert, assume, or imply an earnings date or "earnings approaching". If a structure is earnings-sensitive (short premium / IV-crush plays), say in what_invalidates that the user MUST verify the earnings date externally before placing — you cannot.`}
- ${hasMacro ? `Macro events ARE on file above.` : `NO macro calendar (FOMC/CPI/jobs) is wired. Do NOT assert any FOMC/CPI/jobs timing. If a play depends on a macro print, flag that the user must confirm the schedule externally.`}
- OPEX is the ONLY event type you can fully trust (rendered in the OPEX line above; sourced from a holiday-adjusted table). Treat every other catalyst as UNKNOWN unless it appears in the list above.`
}

// Crude per-strategy delta sign. Good enough to flag direction
// stacking — not a Greeks engine.
function deltaSign(strategyType: string): 'long' | 'short' | 'neutral' {
  const t = (strategyType || '').toUpperCase()
  if (t === 'BULL_CALL' || t === 'BULL_PUT_CREDIT' || t === 'WHALE_LONG_CALL') return 'long'
  if (t === 'BEAR_PUT' || t === 'BEAR_CALL_CREDIT' || t === 'WHALE_LONG_PUT') return 'short'
  return 'neutral'   // iron condors / strangles / butterflies
}

function buildExposureSection(exposure: OpenExposureRow[], ticker: string): string {
  if (exposure.length === 0) {
    return `EXISTING OPEN EXPOSURE: none on file (or system scan). No concentration constraint.`
  }
  let longN = 0, shortN = 0, neutralN = 0
  const lines = exposure.map((r) => {
    const s = deltaSign(r.strategy_type)
    if (s === 'long') longN++
    else if (s === 'short') shortN++
    else neutralN++
    return `  ${r.ticker} ${r.strategy_type} ×${r.contracts} (${s} δ)`
  })
  return `EXISTING OPEN EXPOSURE (the user's OTHER live positions — concentration check):
${lines.join('\n')}
  net: ${longN} long-δ, ${shortN} short-δ, ${neutralN} neutral
CONCENTRATION RULE: a new ${ticker} play that ADDS to an already one-sided book (esp. if ${ticker} is correlated with names held — mega-cap AI, semis, and the index ETFs all co-move) is risk stacking, not diversification. If your proposal piles more of the dominant δ-direction into a correlated complex, say so explicitly in the rationale, prefer half-size, and favour a play that hedges or diversifies the existing book over one that doubles it. A correlated drawdown hits every same-direction position at once.`
}

export function buildUserPrompt(
  matrix: MatrixData,
  accountSize: number,
  flow: FlowRow[],
  intradayBars: IntradayBar[] | null = null,
  events: MarketEvent[] = [],
  exposure: OpenExposureRow[] = [],
): string {
  const totalGex = matrix.cells.flat().reduce((s, v) => s + (v ?? 0), 0)
  const flat = matrix.cells.flatMap((row, i) =>
    row.map((v, j) => ({
      strike: matrix.strikes[i],
      expiration: matrix.expirations[j].date,
      gex: v,
    })),
  )
  const top5pos = flat.filter((c) => c.gex != null && c.gex > 0).sort((a, b) => (b.gex as number) - (a.gex as number)).slice(0, 5)
  const top5neg = flat.filter((c) => c.gex != null && c.gex < 0).sort((a, b) => (a.gex as number) - (b.gex as number)).slice(0, 5)

  const expAbsGex = new Map<string, number>()
  // Per-expiration max-abs cell — the wall that anchors each column.
  // The single matrix-wide ★ wall was misleading during RTH on
  // 0DTE-dominated tickers (every multi-day play looked like it
  // depended on a wall about to expire). Surfacing one wall per
  // expiration lets Claude reason about which column a play actually
  // anchors to.
  const wallByExp = new Map<string, { strike: number; gex: number }>()
  for (const c of flat) {
    if (c.gex == null) continue
    expAbsGex.set(c.expiration, (expAbsGex.get(c.expiration) ?? 0) + Math.abs(c.gex))
    const cur = wallByExp.get(c.expiration)
    if (!cur || Math.abs(c.gex) > Math.abs(cur.gex)) {
      wallByExp.set(c.expiration, { strike: c.strike, gex: c.gex })
    }
  }
  const totalAbs = Array.from(expAbsGex.values()).reduce((s, v) => s + v, 0)
  const expRanked = Array.from(expAbsGex.entries()).sort((a, b) => b[1] - a[1])
  const dominantExp = expRanked[0]?.[0] ?? null
  const dominantSharePct = totalAbs > 0 && expRanked[0] ? Math.round((expRanked[0][1] / totalAbs) * 100) : 0

  // Walls keyed in the same order as expirations[] for the prompt
  // table; tag the row that owns the matrix-wide ★.
  const matrixMaxAbs = Array.from(wallByExp.values())
    .reduce((m, w) => Math.max(m, Math.abs(w.gex)), 0)
  const wallsByExpRows = matrix.expirations.map((e) => {
    const w = wallByExp.get(e.date)
    if (!w) return `  ${e.date} (${e.dte}d): (no GEX in column)`
    const star = matrixMaxAbs > 0 && Math.abs(w.gex) === matrixMaxAbs ? ' ★' : ''
    const sign = w.gex >= 0 ? '+' : '-'
    return `  ${e.date} (${e.dte}d): ${w.strike} → ${sign}$${(Math.abs(w.gex) / 1e6).toFixed(1)}M${star}`
  }).join('\n')

  // Real per-(strike, exp, type) open interest, sourced from
  // compute-gex's oi_call_cells / oi_put_cells. Same [strike][exp]
  // indexing as `cells`. When the matrix predates the OI surface
  // (EOD snapshot served from gex_history before this field existed)
  // the maps stay empty and formatFlowSection's notable detection
  // skips the strike rather than firing against a synthetic
  // denominator.
  const chainOI = new Map<string, number>()
  for (let i = 0; i < matrix.strikes.length; i++) {
    for (let j = 0; j < matrix.expirations.length; j++) {
      const strike = matrix.strikes[i]
      const exp = matrix.expirations[j].date
      const callOI = matrix.oi_call_cells?.[i]?.[j]
      const putOI = matrix.oi_put_cells?.[i]?.[j]
      if (Number.isFinite(callOI) && (callOI as number) > 0) {
        chainOI.set(`${strike}|${exp}|C`, callOI as number)
      }
      if (Number.isFinite(putOI) && (putOI as number) > 0) {
        chainOI.set(`${strike}|${exp}|P`, putOI as number)
      }
    }
  }

  return `TICKER: ${matrix.ticker}
SPOT: $${matrix.spot.toFixed(2)}${
  matrix.session && matrix.session !== 'rth' && Number.isFinite(matrix.live_spot)
    ? ` (RTH close — see LIVE SPOT below for current ${matrix.session} price)`
    : ''
}${
  matrix.live_spot != null && Number.isFinite(matrix.live_spot)
    ? `\nLIVE SPOT: $${(matrix.live_spot as number).toFixed(2)} (session: ${matrix.session ?? 'unknown'}${
        matrix.spot
          ? `, Δ from RTH close: ${(((matrix.live_spot as number) - matrix.spot) / matrix.spot * 100).toFixed(2)}%`
          : ''
      })`
    : ''
}
DATA SOURCE: ${matrix.source}${
  matrix.opex && matrix.opex.next_date
    ? `\nOPEX: ${matrix.opex.is_today
        ? `TODAY is ${matrix.opex.type ?? 'monthly'} OPEX${matrix.opex.is_quarterly ? ' (quarterly / triple-witching)' : ''} — the largest gamma cluster of the ${matrix.opex.is_quarterly ? 'quarter' : 'month'} expires this afternoon.`
        : `next OPEX ${matrix.opex.next_date} (${matrix.opex.type ?? 'monthly'}${matrix.opex.is_quarterly ? ', quarterly/triple-witch' : ''}), in ${matrix.opex.days_until ?? '?'} day(s).`}`
    : ''
}
ACCOUNT SIZE: $${accountSize.toLocaleString()}
MAX RISK PER TRADE (2% rule): $${Math.floor(accountSize * 0.02).toLocaleString()}

${buildEventsSection(events, matrix.ticker)}

${buildExposureSection(exposure, matrix.ticker)}

EXPIRATIONS AVAILABLE:
${matrix.expirations.map((e) => `  ${e.date} (${e.dte} DTE)`).join('\n')}

STRIKES IN WINDOW (descending):
${matrix.strikes.map((s) => `  ${s}`).join('\n')}

NET GEX (sum of all cells): $${(totalGex / 1e6).toFixed(1)}M

LARGEST CALL WALLS (top 5 positive cells):
${top5pos.map((c) => `  ${c.strike} @ ${c.expiration}: $${((c.gex as number) / 1e6).toFixed(1)}M`).join('\n')}

LARGEST PUT WALLS (top 5 negative cells):
${top5neg.length > 0
  ? top5neg.map((c) => `  ${c.strike} @ ${c.expiration}: -$${(Math.abs(c.gex as number) / 1e6).toFixed(1)}M`).join('\n')
  : '  (none in visible window — flip strike likely below)'}

WALLS BY EXPIRATION (max |GEX| cell per column — the wall anchoring each expiration; ★ marks the matrix-wide max):
${wallsByExpRows}

DOMINANT GEX EXPIRATION: ${dominantExp ? `${dominantExp} (${dominantSharePct}% of total |GEX| in this matrix)` : 'unknown'}
GAMMA ROLL-OFF NOTE: set gamma_rolloff_risk=true ONLY when target_king_node is call_wall or put_wall AND target_strike matches the DOMINANT EXPIRATION's wall AND play.expiration !== dominant_gex_expiration. If target_strike is the wall of your own expiration column, set false — your play is self-anchored.

${buildSecondaryGreeksSection(matrix)}
${buildVelocitySection(matrix) ?? 'VELOCITY: not available (first snapshot of session or no prior history within lookback window).'}
${buildIntradaySection(intradayBars, matrix)}
${formatFlowSection(flow, chainOI)}

INTERPRETATION HINTS:
- GEX walls show where dealers are HEDGED. Flow shows where traders are PRINTING TODAY.
- Flow concentrating AT a call wall = traders growing the wall (more resistance forming).
- Flow CONCENTRATING THROUGH a wall (vol > 5x OI at strikes ABOVE the wall) = directional bullish bet, wall may break.
- Mismatch between GEX (where positioning sits) and flow (where new bets land) = transition signal — regime may be shifting.
- INTRADAY context (KING NODE INTERACTIONS TODAY) is a hard input, not advisory: if a wall is marked REJECTED today, downgrade pin_to plays targeting that wall — the wall is reinforced for the remainder of the session. For break_through setups, REJECTED is a hard contraindication unless a catalyst overlaps.
- UNTESTED-WALL judgment is GEOMETRY-RELATIVE, not a flat percentage. Each untested wall reports closest approach in BOTH $ and %. A wall is a red flag for pin_to when the day's closest approach exceeds roughly HALF the width of the vertical you would use to target it (a 10-wide spread targeting that wall tolerates spot wandering ~$5; if the session never came within $5, the pin never had a chance today). On a $40 stock $2 away is severe; on a $700 index $2 away is noise — judge the $ gap against the spread you're about to build and the strike spacing, never a fixed 2%. The wider the gap relative to your structure, the harder the downgrade; a gap exceeding the full spread width is a hard contraindication, not a caution.
- NODE RETEST DECAY (price-delivery framework — directional priors, NOT measured probabilities; weigh, don't compute with): node influence weakens with each retest. A node tagged FRESH (1st touch) carries the strongest reversal/bounce prior — prefer these for fade/bounce plays. "2nd touch" = moderate, watch for a double-top/bottom failing. "3rd+ touched" = weak prior, the level is stale; do NOT propose a fade/bounce back to a 3rd+-touched node unless its node ∆GEX is clearly growing. Prioritise the FRESHEST untouched-or-1st-touch node available over chasing a stale one.
- NODE ∆GEX (rate of change at the specific node a play targets): growing (positive ∆GEX) → reversion/defense of that node is MORE likely, the play is better supported. Decaying (negative ∆GEX) → the node is losing dealer commitment, reversion is LESS likely — do not chase a bounce/pin to a decaying node even if it was strong earlier. When ∆GEX is unavailable (no velocity), treat node strength as unknown and lean on touch-count freshness alone.
- SPOT vs LIVE SPOT: when a LIVE SPOT line is present, the matrix's cells/walls/GEX numbers are frozen at the RTH close (options stop trading at 4pm ET) but the underlying has moved in extended hours. Phrase the thesis against LIVE SPOT, not SPOT. A gap of |Δ| > 0.3% materially changes the wall-distance math even though GEX cells stay constant. If session is 'pre-market' and live spot is meaningfully below the dominant call wall, the pin-to-wall thesis still works but the path is longer (spot must climb from live, not from close). If session is 'after-hours' / 'overnight' and live spot has dropped through a put wall the close held, that's a regime-flip warning for tomorrow's open. Never assert spot is at the RTH close when LIVE SPOT says otherwise.
- OPEX is a hard input for any pin/wall thesis. When an OPEX line is present and a play's expiration is ON or AFTER the OPEX date AND the play targets a wall whose expiration is the OPEX date: that wall is the monthly (or quarterly) cluster that EXPIRES on OPEX. It is NOT a durable magnet — its gamma evaporates that afternoon and the regime can flip violently post-OPEX. Treat a pin_to targeting an expiring-OPEX wall as gamma_rolloff_risk=true regardless of the dominant-expiration check, and say so in rolloff_note. A pin_to whose own expiration IS the OPEX date is the highest-risk version: you are betting the cluster holds price exactly through its own expiration — only justify it when spot is already inside a tight wall cluster (true Regime-A pin) AND intraday context shows the wall is being actively tested and held. If spot is not near the wall, do not propose pinning to an expiring-OPEX wall at all. Quarterly/triple-witch OPEX amplifies all of this.

Propose 0-5 spread trades following the rules in the system prompt. When you return 2 or more, span at least 2 distinct strategy types. Strict JSON only.`
}

// ─── POP math ───────────────────────────────────────────────────────

const POP_RISK_FREE = 0.045

function popNormCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + p * absX)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX)
  return 0.5 * (1 + sign * y)
}

function popD2(spot: number, K: number, t: number, sigma: number): number | null {
  if (!(spot > 0 && K > 0 && t > 0 && sigma > 0)) return null
  return (Math.log(spot / K) + (POP_RISK_FREE - 0.5 * sigma * sigma) * t) / (sigma * Math.sqrt(t))
}

function popClampBp(prob: number): number | null {
  if (!Number.isFinite(prob)) return null
  return Math.max(0, Math.min(10000, Math.round(prob * 10000)))
}

export function computePopBp(a: PopArgs): number | null {
  if (!(a.spot > 0) || !(a.sigma > 0)) return null
  const t = Math.max(1, a.dte) / 365
  switch (a.type) {
    case 'BULL_CALL': {
      if (!(a.long_strike > 0) || !(a.net_debit && a.net_debit > 0)) return null
      const be = a.long_strike + a.net_debit
      const d = popD2(a.spot, be, t, a.sigma)
      return d == null ? null : popClampBp(popNormCdf(d))
    }
    case 'BEAR_PUT': {
      if (!(a.long_strike > 0) || !(a.net_debit && a.net_debit > 0)) return null
      const be = a.long_strike - a.net_debit
      const d = popD2(a.spot, be, t, a.sigma)
      return d == null ? null : popClampBp(popNormCdf(-d))
    }
    case 'BULL_PUT_CREDIT': {
      if (!(a.short_strike > 0) || !(a.net_credit && a.net_credit > 0)) return null
      const be = a.short_strike - a.net_credit
      const d = popD2(a.spot, be, t, a.sigma)
      return d == null ? null : popClampBp(popNormCdf(d))
    }
    case 'BEAR_CALL_CREDIT': {
      if (!(a.short_strike > 0) || !(a.net_credit && a.net_credit > 0)) return null
      const be = a.short_strike + a.net_credit
      const d = popD2(a.spot, be, t, a.sigma)
      return d == null ? null : popClampBp(popNormCdf(-d))
    }
    case 'IRON_CONDOR': {
      if (!(a.inner_call_strike && a.inner_call_strike > 0)) return null
      if (!(a.inner_put_strike && a.inner_put_strike > 0)) return null
      if (!(a.net_credit && a.net_credit > 0)) return null
      const half = a.net_credit / 2
      const upperBe = a.inner_call_strike + half
      const lowerBe = a.inner_put_strike - half
      if (upperBe <= lowerBe) return null
      const dU = popD2(a.spot, upperBe, t, a.sigma)
      const dL = popD2(a.spot, lowerBe, t, a.sigma)
      if (dU == null || dL == null) return null
      return popClampBp(popNormCdf(-dU) - popNormCdf(-dL))
    }
    default:
      return null
  }
}

export async function fetchIvLookup(
  supabase: SupabaseClient,
  ticker: string,
  plays: Array<{ long_strike: number; short_strike: number; expiration: string }>,
): Promise<Map<string, number>> {
  const lookup = new Map<string, number>()
  if (plays.length === 0) return lookup
  const expirations = Array.from(new Set(plays.map((p) => p.expiration)))
  const strikes = Array.from(new Set(plays.flatMap((p) => [p.long_strike, p.short_strike])))
  const { data, error } = await supabase
    .from('dxlink_quotes')
    .select('strike, expiration_date, option_type, iv')
    .eq('underlying', ticker)
    .eq('kind', 'option')
    .in('expiration_date', expirations)
    .in('strike', strikes)
  if (error || !data) return lookup
  for (const r of data as Array<{ strike: number; expiration_date: string; option_type: 'C' | 'P'; iv: number | null }>) {
    if (r.iv == null || !(r.iv > 0)) continue
    const key = `${r.strike}|${r.expiration_date}|${r.option_type}`
    lookup.set(key, r.iv)
    const anyKey = `${r.strike}|${r.expiration_date}|*`
    if (!lookup.has(anyKey)) lookup.set(anyKey, r.iv)
  }
  return lookup
}

// ─── Parse + validate ───────────────────────────────────────────────

export function extractJson(rawText: string): unknown {
  const stripped = rawText.replace(/```json|```/g, '').trim()
  const first = stripped.indexOf('{')
  const last = stripped.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('analysis engine did not return parseable JSON')
  }
  return JSON.parse(stripped.slice(first, last + 1))
}

export function validatePlays(parsed: any, matrix: MatrixData): any {
  if (!parsed?.plays || !Array.isArray(parsed.plays)) return parsed
  const strikeSet = new Set(matrix.strikes)
  const expDates = new Set(matrix.expirations.map((e) => e.date))
  const dominantExp: string | null =
    typeof parsed.dominant_gex_expiration === 'string' ? parsed.dominant_gex_expiration : null

  // Recompute the per-expiration max-abs wall from the matrix so the
  // validator can enforce the tightened rolloff-risk semantics
  // independently of what Claude returned. Mirrors the calculation in
  // buildUserPrompt — kept inline rather than shared to keep the
  // validator pure and easy to test in isolation.
  const wallByExp = new Map<string, { strike: number; gex: number }>()
  for (let i = 0; i < matrix.cells.length; i++) {
    const strike = matrix.strikes[i]
    for (let j = 0; j < matrix.cells[i].length; j++) {
      const v = matrix.cells[i][j]
      if (v == null || !Number.isFinite(v)) continue
      const expDate = matrix.expirations[j]?.date
      if (!expDate) continue
      const cur = wallByExp.get(expDate)
      if (!cur || Math.abs(v) > Math.abs(cur.gex)) {
        wallByExp.set(expDate, { strike, gex: v })
      }
    }
  }
  const dominantWall = dominantExp ? wallByExp.get(dominantExp) ?? null : null
  parsed.plays = parsed.plays.filter((p: any) => {
    if (!expDates.has(p.expiration)) {
      console.warn(`[validate] dropped play: expiration not in matrix`, p)
      return false
    }
    if (p.type === 'IRON_CONDOR') {
      const ks = [p.long_put_strike, p.short_put_strike, p.short_call_strike, p.long_call_strike]
      if (!ks.every((k) => strikeSet.has(k))) {
        console.warn(`[validate] dropped IC: one or more strikes not in matrix`, p)
        return false
      }
      if (!(p.long_put_strike < p.short_put_strike &&
            p.short_put_strike < p.short_call_strike &&
            p.short_call_strike < p.long_call_strike)) {
        console.warn(`[validate] dropped IC: strike ordering invalid`, p)
        return false
      }
      // Mirror the body bounds onto the legacy two-strike fields so
      // downstream code (UI, signal-log payload) that still reads
      // long_strike/short_strike has sensible values without needing
      // a schema migration. Use the body bounds — that's what the
      // 2-leg convention historically pointed at.
      p.long_strike = p.long_call_strike
      p.short_strike = p.long_put_strike
      return true
    }
    if (!strikeSet.has(p.long_strike) || !strikeSet.has(p.short_strike)) {
      console.warn(`[validate] dropped play: strike not in matrix`, p)
      return false
    }
    return true
  })
  const VALID_KING_NODES = new Set(['call_wall', 'put_wall', 'flip'])
  const VALID_THESIS_KINDS = new Set(['pin_to', 'break_through', 'fade'])
  for (const p of parsed.plays) {
    // Server-side recompute of gamma_rolloff_risk regardless of what
    // Claude returned. Old rule was "play.expiration > dominantExp" —
    // fired on every multi-day play during 0DTE-dominated RTH, making
    // the warning noise. New rule: the play is at risk only when it
    // explicitly targets the dominant cluster's wall AND outlives it.
    // A play that anchors to its own expiration's wall doesn't have
    // rolloff risk — its only concern is its own time decay.
    const targetsAWall = p.target_king_node === 'call_wall' || p.target_king_node === 'put_wall'
    const targetStrike = Number(p.target_strike)
    const ownColumnWall = wallByExp.get(p.expiration) ?? null
    const targetMatchesDominantWall =
      dominantWall != null &&
      Number.isFinite(targetStrike) &&
      Math.abs(targetStrike - dominantWall.strike) < 0.01
    const selfAnchored =
      ownColumnWall != null &&
      Number.isFinite(targetStrike) &&
      Math.abs(targetStrike - ownColumnWall.strike) < 0.01
    p.gamma_rolloff_risk =
      targetsAWall &&
      targetMatchesDominantWall &&
      !selfAnchored &&
      p.expiration !== dominantExp

    if (p.gamma_rolloff_risk && (!p.rolloff_note || typeof p.rolloff_note !== 'string')) {
      p.rolloff_note = `Targets the ${dominantExp} wall at $${dominantWall?.strike} but expires ${p.expiration} — the cluster anchoring this thesis rolls off before you exit.`
    }
    if (!p.gamma_rolloff_risk) p.rolloff_note = ''
    if (!VALID_KING_NODES.has(p.target_king_node)) {
      const t = p.type
      p.target_king_node =
        t === 'BULL_CALL' || t === 'BULL_PUT_CREDIT' ? 'call_wall'
        : t === 'BEAR_PUT' || t === 'BEAR_CALL_CREDIT' ? 'put_wall'
        : 'flip'
    }
    if (!VALID_THESIS_KINDS.has(p.target_thesis_kind)) {
      const t = p.type
      p.target_thesis_kind = t === 'BULL_CALL' || t === 'BEAR_PUT' ? 'break_through' : 'pin_to'
    }
    if (!Number.isFinite(Number(p.target_strike))) p.target_strike = p.short_strike
    if (typeof p.target_expiration !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.target_expiration)) {
      p.target_expiration = p.expiration
    }
  }
  return parsed
}

// ─── Live-pricing pass (Polygon-verified per candidate) ────────────

const SPREAD_STRUCTURES = new Set([
  'BULL_CALL', 'BEAR_PUT', 'BEAR_CALL_CREDIT', 'BULL_PUT_CREDIT',
])

function stampVerified(p: any, priced: {
  spot: number; iv_used: number; quote_age_seconds: number
  is_credit: boolean
  width: number
  max_profit_per_spread: number; max_loss_per_spread: number
  max_profit_dollars: number; max_loss_dollars: number
  risk_reward: number; entry_pop_bp: number; ev_edge_bp: number
}, accountSize: number) {
  p.risk_reward = priced.risk_reward
  p.entry_pop_bp = priced.entry_pop_bp
  p.ev_edge_bp = priced.ev_edge_bp
  p.breakeven_pop_bp = priced.entry_pop_bp
  p.max_profit_per_spread = priced.max_profit_per_spread
  p.max_loss_per_spread = priced.max_loss_per_spread
  p.max_profit_dollars = priced.max_profit_dollars
  p.max_loss_dollars = priced.max_loss_dollars
  p.width = priced.width
  p.is_credit = priced.is_credit
  p.iv_used = priced.iv_used
  p.spot = priced.spot
  p.contracts = computeContracts(priced.max_loss_per_spread, accountSize)
  p.pricing_source = 'verified'
  p.pricing_verified_at = new Date().toISOString()
  p.quote_age_seconds = priced.quote_age_seconds
}

export async function verifyAndFilter(
  _adminClient: SupabaseClient,
  _ticker: string,
  _matrix: MatrixData,
  parsed: any,
  topN: number,
  accountSize: number,
): Promise<any> {
  if (!parsed?.plays || !Array.isArray(parsed.plays) || parsed.plays.length === 0) {
    return parsed
  }
  const tickerSym = String(_ticker).toUpperCase()
  const beforeCount = parsed.plays.length
  const verified: any[] = []
  // Observability: count *why* plays die here so "0 plays" is never
  // again ambiguous between "no setups", "rate-limited" and "the
  // pricing provider timed out". Bubbles up to top_plays_feed.
  const rejections = {
    pricing: 0, rr: 0, ev: 0, pop: 0, structure: 0,
    total: 0, samples: [] as string[],
  }
  const note = (bucket: 'pricing' | 'rr' | 'ev' | 'pop' | 'structure', detail: string) => {
    rejections[bucket]++
    rejections.total++
    if (rejections.samples.length < 4) rejections.samples.push(detail)
  }
  for (const p of parsed.plays) {
    let priced: {
      pricing_source: 'verified' | 'rejected'
      rejection_reason?: string
      risk_reward: number; ev_edge_bp: number; entry_pop_bp: number
      max_profit_per_spread: number; max_loss_per_spread: number
      max_profit_dollars: number; max_loss_dollars: number
      width: number; is_credit: boolean
      spot: number; iv_used: number; quote_age_seconds: number
      [key: string]: any
    }

    if (p.type === 'IRON_CONDOR') {
      const ic = await priceIronCondor({
        ticker: tickerSym,
        long_put_strike: Number(p.long_put_strike),
        short_put_strike: Number(p.short_put_strike),
        short_call_strike: Number(p.short_call_strike),
        long_call_strike: Number(p.long_call_strike),
        expiration: p.expiration,
      })
      priced = ic
    } else if (SPREAD_STRUCTURES.has(p.type)) {
      priced = await priceSpread({
        ticker: tickerSym,
        structure: p.type,
        long_strike: Number(p.long_strike),
        short_strike: Number(p.short_strike),
        expiration: p.expiration,
      })
    } else {
      console.log(`[playSuggester] skip ${p.type} — unknown structure`)
      note('structure', `${p.type} unknown structure`)
      continue
    }

    const label = p.type === 'IRON_CONDOR'
      ? `IC ${p.long_put_strike}/${p.short_put_strike}/${p.short_call_strike}/${p.long_call_strike}`
      : `${p.type} ${p.long_strike}/${p.short_strike}`

    if (priced.pricing_source === 'rejected') {
      console.log(`[playSuggester] reject ${label} @ ${p.expiration}: ${priced.rejection_reason}`)
      note('pricing', `${label}: ${priced.rejection_reason}`)
      continue
    }
    if (priced.risk_reward < 1.5) {
      console.log(`[playSuggester] reject ${label}: live R/R ${priced.risk_reward} < 1.5`)
      note('rr', `${label}: R/R ${priced.risk_reward} < 1.5`)
      continue
    }
    if (priced.ev_edge_bp <= 0) {
      console.log(`[playSuggester] reject ${label}: EV edge ${priced.ev_edge_bp}bp ≤ 0`)
      note('ev', `${label}: EV ${priced.ev_edge_bp}bp ≤ 0`)
      continue
    }
    if (priced.entry_pop_bp < 5000) {
      console.log(`[playSuggester] reject ${label}: POP ${priced.entry_pop_bp}bp < 5000`)
      note('pop', `${label}: POP ${priced.entry_pop_bp}bp < 5000`)
      continue
    }

    stampVerified(p, priced, accountSize)
    if (p.type === 'IRON_CONDOR') {
      p.total_credit = priced.total_credit
      p.credit_mid = priced.total_credit
      p.breakeven_lower = priced.breakeven_lower
      p.breakeven_upper = priced.breakeven_upper
      p.estimated_debit_pct_of_width = priced.width > 0
        ? Math.round(((priced.width - priced.total_credit) / priced.width) * 100)
        : null
    } else {
      p.credit_mid = priced.credit_mid
      p.debit_mid = priced.debit_mid
      p.breakeven = priced.breakeven
      p.long_mid = priced.long_mid
      p.short_mid = priced.short_mid
      p.estimated_debit_pct_of_width = priced.width > 0
        ? Math.round((priced.is_credit ? (priced.width - (priced.credit_mid ?? 0)) : (priced.debit_mid ?? 0)) / priced.width * 100)
        : null
    }
    verified.push(p)
  }

  verified.sort((a, b) => (b.ev_edge_bp ?? -Infinity) - (a.ev_edge_bp ?? -Infinity))
  parsed.plays = verified.slice(0, topN)
  if (parsed.plays.length < beforeCount) {
    console.log(`[playSuggester] verified ${parsed.plays.length}/${beforeCount} plays (live Polygon mids)`)
  }
  parsed._rejections = {
    proposed: beforeCount,
    verified: parsed.plays.length,
    ...rejections,
  }
  return parsed
}

// ─── Aggregate confidence (for reasoning_history) ──────────────────

export function aggregateConfidence(plays: any[] | undefined | null): number {
  if (!Array.isArray(plays) || plays.length === 0) return 0
  const evEdges = plays
    .map((p) => p.ev_edge_bp)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (evEdges.length === 0) return 0.5
  const avgEdgeBp = evEdges.reduce((s, v) => s + v, 0) / evEdges.length
  return Math.max(0, Math.min(1, 0.5 + avgEdgeBp / 2000))
}

// ─── End-to-end: matrix → flow → Claude → POP/EV → filter ──────────

export interface GeneratePlaysOptions {
  /** function_name written to claude_calls. 'suggest-plays' for the
   * user-facing endpoint, 'scan-universe-plays' for the scanner cron. */
  functionName: 'suggest-plays' | 'scan-universe-plays'
  /** user_id written to claude_calls. Null for scanner rows (system). */
  userId: string | null
  /** topN plays after R/R + EV filter. suggest-plays uses 3, scanner uses 5. */
  topN: number
  /** Optional auth header to forward to compute-gex. Falls back to
   * service-role JWT when omitted. */
  computeGexAuthHeader?: string
  supabaseUrl: string
  supabaseAnonKey: string
  supabaseServiceRoleKey: string
  anthropicApiKey: string
}

export interface GeneratedPlays {
  matrix: MatrixData
  flow: FlowRow[]
  /** Parsed + validated + POP-filtered Claude output. Shape:
   * { regime, regime_explanation, dominant_gex_expiration, plays: [...] } */
  parsed: any
  /** claude_calls.id for the row we just wrote. Threaded into the
   * cached payload so a signal logged from this output can FK back. */
  claudeCallId: string | null
  costUsd: number
  durationMs: number
  /** Aggregate 0..1 confidence — derived from per-play ev_edge_bp.
   * Mirrors the value reasoning_history stores. */
  confidence: number
  /** Why plays died in verifyAndFilter (pricing/rr/ev/pop/structure
   * counts + samples). Null when nothing was rejected. Surfaced to
   * top_plays_feed so a "0 plays" scan is self-explaining. */
  rejections: Record<string, unknown> | null
}

/** Run the full per-ticker pipeline: compute-gex → flow → Claude →
 * validate → POP/EV. Persists claude_calls + reasoning_history as a
 * side effect. Returns the structured result the caller (either
 * suggest-plays or scan-universe-plays) builds its response from.
 *
 * Throws on any unrecoverable error (compute-gex 5xx, Claude 5xx,
 * Claude returned non-JSON). Caller decides how to surface failure. */
export async function generatePlaysForTicker(
  adminClient: SupabaseClient,
  ticker: string,
  accountSize: number,
  options: GeneratePlaysOptions,
): Promise<GeneratedPlays> {
  // 1. Matrix
  const computeGexAuth = options.computeGexAuthHeader ?? `Bearer ${options.supabaseServiceRoleKey}`
  const gexResp = await fetch(`${options.supabaseUrl}/functions/v1/compute-gex`, {
    method: 'POST',
    headers: {
      Authorization: computeGexAuth,
      apikey: options.supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticker, matrix: true, include_velocity: true }),
  })
  if (!gexResp.ok) {
    const detail = await gexResp.text().catch(() => '')
    throw new Error(`compute-gex returned ${gexResp.status}: ${detail.slice(0, 200)}`)
  }
  const gexBody = await gexResp.json()
  if (!gexBody?.success || !gexBody?.data) {
    throw new Error(gexBody?.error ?? 'compute-gex returned no data')
  }
  const matrix = gexBody.data as MatrixData

  // ── Pre-trade data-integrity gate ──────────────────────────────
  // Refuse to generate plays off untrustworthy inputs rather than
  // letting Claude rationalize a thesis on stale data (the AMD
  // failure mode: bad data flowed through silently). Fail CLOSED —
  // an empty plays[] with an explicit hold reason, no Claude call.
  //
  // Only gates during RTH. Outside RTH the matrix is *correctly* the
  // frozen RTH close (extended hours / weekend / overnight) — that's
  // expected, not stale, and generating next-session plays off it is
  // valid.
  const STALE_MATRIX_MS = 12 * 60 * 1000   // cache TTL (5m) + slack
  const isRth = matrix.session === 'rth' || matrix.session == null
  if (isRth && matrix.computed_at) {
    const matrixAgeMs = Date.now() - new Date(matrix.computed_at).getTime()
    if (Number.isFinite(matrixAgeMs) && matrixAgeMs > STALE_MATRIX_MS) {
      const mins = Math.round(matrixAgeMs / 60000)
      return {
        matrix,
        flow: [],
        parsed: {
          regime: null,
          regime_explanation:
            `Data-integrity hold: the GEX matrix is ${mins} min old during market hours ` +
            `(threshold ${Math.round(STALE_MATRIX_MS / 60000)} min). ` +
            `Suggested Plays will not generate off a stale matrix — the snapshot ` +
            `pipeline is likely behind. Re-analyze once it catches up.`,
          dominant_gex_expiration: null,
          data_integrity_hold: true,
          plays: [],
        },
        claudeCallId: null,
        costUsd: 0,
        durationMs: 0,
        confidence: 0,
        rejections: null,
      }
    }
  }

  // 2. Flow + intraday bars (in parallel — independent network calls).
  //    Bars are nullable (pre-market / Polygon hiccup) and the prompt
  //    falls back to a "not available" line; never blocks generation.
  const [flow, intradayBars, events, exposure] = await Promise.all([
    fetchTodayFlow(adminClient, ticker),
    fetchPolygonIntradayBars(ticker),
    fetchUpcomingEvents(adminClient, ticker),
    fetchOpenExposure(adminClient, options.userId, ticker),
  ])

  // 3. Claude
  const claudeRequestBody = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: buildUserPrompt(matrix, accountSize, flow, intradayBars, events, exposure) }],
  }
  const claudeStartedAt = Date.now()
  const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': options.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(claudeRequestBody),
  })
  const claudeDurationMs = Date.now() - claudeStartedAt
  if (!claudeResp.ok) {
    const detail = await claudeResp.text().catch(() => '')
    // Persist the failure so we don't lose the prompt that triggered it.
    adminClient.from('claude_calls').insert({
      user_id: options.userId,
      function_name: options.functionName,
      called_at: new Date().toISOString(),
      model: CLAUDE_MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0,
      ticker,
      prompt_input: claudeRequestBody,
      prompt_output: null,
      matrix_at_call: matrix,
      duration_ms: claudeDurationMs,
      error: `anthropic ${claudeResp.status}: ${detail.slice(0, 500)}`,
    }).then(() => {})
    throw new Error(`analysis backend returned ${claudeResp.status}: ${detail.slice(0, 200)}`)
  }
  const claudeBody = await claudeResp.json()
  const text = claudeBody?.content?.[0]?.text
  if (!text) throw new Error('analysis response had no text content')
  if (claudeBody.stop_reason === 'max_tokens') {
    throw new Error('analysis response truncated; try a different ticker')
  }

  // 4. Parse + validate + POP/EV filter
  let parsed: any
  try { parsed = extractJson(text) } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'parse error')
  }
  parsed = validatePlays(parsed, matrix)
  parsed = await verifyAndFilter(adminClient, ticker, matrix, parsed, options.topN, accountSize)

  // 5. Persist the claude_calls row + recover its id for the FK.
  const usage = (claudeBody?.usage ?? {}) as Record<string, number | undefined>
  const cost = computeClaudeCost(CLAUDE_MODEL, usage)
  const { data: claudeCallRow, error: claudeCallErr } = await adminClient
    .from('claude_calls')
    .insert({
      user_id: options.userId,
      function_name: options.functionName,
      called_at: new Date().toISOString(),
      model: CLAUDE_MODEL,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cost_usd: cost,
      ticker,
      prompt_input: claudeRequestBody,
      prompt_output: claudeBody,
      matrix_at_call: matrix,
      duration_ms: claudeDurationMs,
      error: null,
    })
    .select('id')
    .single()
  if (claudeCallErr) {
    console.warn('[claude_calls] insert failed:', claudeCallErr.message)
  }
  const claudeCallId: string | null = claudeCallRow?.id ?? null

  // 6. reasoning_history is per-user — only write for user-driven calls.
  // Scanner runs are system-level and don't belong in any user's reasoning
  // timeline (and would violate the user_id NOT NULL on that table).
  const confidence = aggregateConfidence(parsed?.plays)
  if (options.userId) {
    adminClient.from('reasoning_history').insert({
      user_id: options.userId,
      ticker,
      regime: parsed?.regime ?? 'mixed',
      regime_explanation: parsed?.regime_explanation ?? null,
      spot: matrix.spot ?? null,
      net_gex: matrix.net_gex ?? null,
      expected_move: matrix.expected_move ?? null,
      expected_move_pct: matrix.expected_move_pct ?? null,
      pinning_probability: matrix.pinning_probability ?? null,
      call_wall: matrix.largest?.strike ?? null,
      put_wall: matrix.largest_negative_strike ?? null,
      flip_strike: matrix.zero_gamma_strike ?? null,
      play_count: parsed?.plays?.length ?? 0,
      plays: parsed?.plays ?? [],
      confidence,
    }).then(({ error }) => {
      if (error) console.warn('[reasoning_history] insert failed:', error.message)
    })
  }

  return {
    matrix,
    flow,
    parsed,
    claudeCallId,
    costUsd: cost,
    durationMs: claudeDurationMs,
    confidence,
    rejections: parsed?._rejections ?? null,
  }
}
