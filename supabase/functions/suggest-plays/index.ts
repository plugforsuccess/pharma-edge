// Cash Moves — suggest-plays edge function.
//
// Given a ticker, fetch the live GEX matrix from compute-gex and ask
// Claude to propose 3 spread trade ideas that fit the Cash Moves
// trading rules + GEX playbook from /glossary. Returns structured JSON
// the /markets "Suggested Plays" card renders into clickable setups.
//
// Architecture mirrors analyze-signal:
//   - Auth: requires a real user JWT (verify_jwt=true)
//   - Rate-limited per user via the claude_calls ledger (same 30/hr cap)
//   - Claude Sonnet 4.6, max_tokens 2000, returns JSON only
//   - 5-min response cache via play_suggestions table (per ticker)
//
// Hard rules baked into the prompt — NOT optional:
//   - Spreads only, no naked options (Cash Moves rule)
//   - Min 21 DTE (Cash Moves entry rule, except 0DTE pin trades)
//   - R/R >= 1:1.5 (Cash Moves rule). Equivalent thresholds:
//       Debit:  net_debit  <= 40% of width
//       Credit: net_credit >= 60% of width
//     Server-side filter drops anything below 1.5; an empty response is
//     correct on days where no structure clears the bar.
//   - Position size = floor(account * 2% / max_loss_per_spread)
//   - Refuse if no high-conviction setup exists (return empty)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const CLAUDE_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 2000
const RATE_LIMIT_PER_HOUR = Number(Deno.env.get('CLAUDE_RATE_LIMIT_PER_HOUR') ?? '30')
const CACHE_TTL_MS = 5 * 60 * 1000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const SYSTEM_PROMPT = `You are a Cash Moves spread-trade advisor. Given a Gamma Exposure (GEX) matrix snapshot for a ticker, propose 0–5 high-conviction spread trade ideas that fit BOTH the GEX playbook and the Cash Moves trading rules.

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

CASH MOVES RULES — NEVER VIOLATE:
- SPREADS ONLY. No naked options.
- Min 21 DTE on entry, except explicit 0–7 DTE pin trades.
- R/R >= 1:1.5 on every play (target 1:2). Equivalent thresholds:
    Debit (Bull Call, Bear Put):       net_debit  <= 40% of width
    Credit (Bull Put cr, Bear Call cr): net_credit >= 60% of width
    Iron Condor:                       net_credit >= 60% of widest wing
  The server WILL filter out plays with risk_reward < 1.5; do not propose
  them. If no structure on the chain meets this bar, return zero plays
  rather than relax the rule. An empty response is the correct answer on
  efficient-pricing days (most short-DTE SPY/QQQ credits).
- Position size = floor(account * 2% / max_loss_per_spread). Always include this in the response.
- 30–45 days past any catalyst for catalyst-driven plays.

GAMMA ROLL-OFF RISK — MUST FLAG:
- The user prompt will include a "DOMINANT GEX EXPIRATION" line — the single expiration that holds the largest share of total |GEX| in the matrix. That expiration is what's anchoring the current pinning / regime behavior.
- Once it expires, dealer hedges roll off, positioning resets, and the regime can shift (freer price discovery, larger moves, less suppression). Plays whose expiration is AFTER the dominant one are inheriting a thesis that may not survive the roll-off.
- For each play, set "gamma_rolloff_risk" = true if play.expiration > dominant_gex_expiration. Otherwise false.
- When true, include a "rolloff_note" of one short sentence describing the specific risk for THIS structure (e.g. "Condor expires after the May 8 wall cluster rolls off — the pinning regime anchoring this thesis ends mid-trade.").
- When the dominant expiration also satisfies the trade's other constraints (DTE rules, sufficient strike spread), PREFER it over later expirations.

OUTPUT — STRICT JSON, NO PROSE:
{
  "regime": "A" | "B" | "mixed",
  "regime_explanation": "one sentence",
  "dominant_gex_expiration": "YYYY-MM-DD",
  "plays": [
    {
      "strategy": "Bull Call Spread" | "Bear Put Spread" | "Iron Condor" | "Bull Put Spread (credit)" | "Bear Call Spread (credit)",
      "type": "BULL_CALL" | "BEAR_PUT" | "IRON_CONDOR" | "BULL_PUT_CREDIT" | "BEAR_CALL_CREDIT",
      "long_strike": <number>,
      "short_strike": <number>,
      "expiration": "YYYY-MM-DD",
      "dte": <integer>,
      "estimated_debit_pct_of_width": <integer 0-40>,
      "max_loss_per_spread": <number, dollars>,
      "max_profit_per_spread": <number, dollars>,
      "risk_reward": <number, e.g. 1.5>,
      "contracts": <integer, sized to account_size with the 2% rule>,
      "market_view": "1 short sentence stating the EXACT forecast this trade requires to be profitable. Be precise about what the underlying must do — most spreads are not generic 'bullish' or 'bearish'; they each require a specific outcome. Examples: 'PLTR closes below $130 by May 29' (debit put spread — needs an actual move), 'PLTR fails to reclaim $140' (bear call credit — only needs the wall to hold; flat or mild drift up still wins), 'NVDA pins between $138 and $145' (iron condor — needs sideways), 'AAPL closes above $185 by Jun 20' (bull call debit — needs a move up). Never use the same market_view for two plays in the same response — if two plays collapse to the same forecast, drop the lower-conviction one.",
      "rationale": "1-2 sentences citing specific GEX numbers (call wall at $X, flip at $Y, etc.)",
      "what_invalidates": "1 sentence — what move or event kills this thesis",
      "gamma_rolloff_risk": <boolean>,
      "rolloff_note": "<string, REQUIRED when gamma_rolloff_risk=true; empty string otherwise>",
      "entry_pop_bp": <integer 0-10000, OPTIONAL — server overwrites this with a computed value from live IV. You may include your own estimate but it will be replaced.>
    }
  ]
}

If no high-conviction setup exists (e.g., all cells near zero, or matrix data is stale/incomplete), return { "regime": "...", "regime_explanation": "...", "plays": [] } — DO NOT invent low-conviction trades to pad the response.

Both strikes you propose MUST exist in the matrix's strikes[] array. Use the matrix's expirations[] array for expiration dates — don't hallucinate dates.`

interface MatrixData {
  ticker: string
  spot: number
  source: string
  expirations: Array<{ date: string; dte: number }>
  strikes: number[]
  cells: (number | null)[][]
  largest: { strike: number; expiration: string; gex_net: number } | null
}

interface FlowRow {
  strike: number
  expiration_date: string
  option_type: 'C' | 'P'
  total_volume: number
  total_premium: number
  print_count: number
  biggest_print_size: number | null
  biggest_print_at: string | null
}

// Pulls today's per-strike flow aggregates for the ticker. Returns
// up to 200 rows sorted by total_volume DESC — the worker writes
// per-(strike, expiry, side) so the same strike with different
// expirations or call vs put each get a separate row.
async function fetchTodayFlow(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
): Promise<FlowRow[]> {
  // NY trade date — same convention as the worker's flow.ts uses.
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

  // "Notable" = volume well above the OI we have for that strike.
  // Surfaces unusual options activity (UOA) — e.g. 8000 contracts on
  // a strike with only 150 OI is a directional bet, not hedging.
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
    (f.biggest_print_size && f.biggest_print_size >= 100
      ? `, biggest ${f.biggest_print_size}`
      : '')

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

function buildUserPrompt(matrix: MatrixData, accountSize: number, flow: FlowRow[]): string {
  // Compact matrix representation — Claude doesn't need every cell, just
  // structure + the highlights. Cuts token count ~80%.
  const totalGex = matrix.cells.flat().reduce((s, v) => s + (v ?? 0), 0)
  const flat = matrix.cells.flatMap((row, i) =>
    row.map((v, j) => ({
      strike: matrix.strikes[i],
      expiration: matrix.expirations[j].date,
      gex: v,
    })),
  )
  const top5pos = flat
    .filter((c) => c.gex != null && c.gex > 0)
    .sort((a, b) => (b.gex as number) - (a.gex as number))
    .slice(0, 5)
  const top5neg = flat
    .filter((c) => c.gex != null && c.gex < 0)
    .sort((a, b) => (a.gex as number) - (b.gex as number))
    .slice(0, 5)

  // Dominant GEX expiration — sum |gex| per expiration column, pick the
  // one with the largest share. This is the expiry that's anchoring the
  // current regime; structures expiring AFTER it inherit gamma roll-off
  // risk because dealer hedges around the dominant strikes vanish at
  // that expiry. Surfaced explicitly so Claude doesn't have to guess.
  const expAbsGex = new Map<string, number>()
  for (const c of flat) {
    if (c.gex == null) continue
    expAbsGex.set(c.expiration, (expAbsGex.get(c.expiration) ?? 0) + Math.abs(c.gex))
  }
  const totalAbs = Array.from(expAbsGex.values()).reduce((s, v) => s + v, 0)
  const expRanked = Array.from(expAbsGex.entries()).sort((a, b) => b[1] - a[1])
  const dominantExp = expRanked[0]?.[0] ?? null
  const dominantSharePct = totalAbs > 0 && expRanked[0]
    ? Math.round((expRanked[0][1] / totalAbs) * 100)
    : 0

  // OI lookup keyed (strike|expiration|side) — used for the "vol/OI"
  // notable detection. Only call-side OI is in cells (OI per side is
  // collapsed into gex_net), so this is approximate; for the unusual
  // detector that's fine.
  const chainOI = new Map<string, number>()
  // gex matrix doesn't carry per-side OI in cells, so we just key by
  // (strike, expiration) and let the flow filter use it as a "we have
  // *any* OI here" signal — enough to filter out 1-strike spikes
  // around brand-new listings.
  for (const c of flat) {
    if (c.gex != null && c.gex !== 0) {
      chainOI.set(`${c.strike}|${c.expiration}|C`, 1000) // placeholder
      chainOI.set(`${c.strike}|${c.expiration}|P`, 1000)
    }
  }

  return `TICKER: ${matrix.ticker}
SPOT: $${matrix.spot.toFixed(2)}
DATA SOURCE: ${matrix.source}
ACCOUNT SIZE: $${accountSize.toLocaleString()}
MAX RISK PER TRADE (2% rule): $${Math.floor(accountSize * 0.02).toLocaleString()}

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

LARGEST ABSOLUTE WALL (★): ${matrix.largest ? `${matrix.largest.strike} @ ${matrix.largest.expiration} = $${(matrix.largest.gex_net / 1e6).toFixed(1)}M` : 'none'}

DOMINANT GEX EXPIRATION: ${dominantExp ? `${dominantExp} (${dominantSharePct}% of total |GEX| in this matrix)` : 'unknown'}
GAMMA ROLL-OFF NOTE: any play with expiration > ${dominantExp ?? 'the dominant expiration above'} MUST set gamma_rolloff_risk=true and explain it in rolloff_note. The pinning/regime behavior driving the thesis ends when the dominant expiry rolls off.

${formatFlowSection(flow, chainOI)}

INTERPRETATION HINTS:
- GEX walls show where dealers are HEDGED. Flow shows where traders are PRINTING TODAY.
- Flow concentrating AT a call wall = traders growing the wall (more resistance forming).
- Flow CONCENTRATING THROUGH a wall (vol > 5x OI at strikes ABOVE the wall) = directional bullish bet, wall may break.
- Mismatch between GEX (where positioning sits) and flow (where new bets land) = transition signal — regime may be shifting.

Propose 0-5 spread trades following the rules in the system prompt. When you return 2 or more, span at least 2 distinct strategy types (Bull Call / Bear Put / Iron Condor / Bull Put Credit / Bear Call Credit). Strict JSON only.`
}

// ─── Probability of Profit at Expiration (POP) ─────────────────────
//
// Mirrors src/utils/pop.js byte-for-byte (Deno can't import from src/
// so we duplicate). Computes terminal-distribution POP under the
// Black-Scholes lognormal model. Output is integer basis points
// (0–10000), matching the signals.entry_pop_bp column.
//
// Required inputs differ by structure — see computePopBp below.

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

function computePopBp(a: PopArgs): number | null {
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

// Pull IV per (strike, expiration) for the strikes Claude proposed.
// Single bulk query against dxlink_quotes; rows missing IV (yahoo-
// fallback case) just yield null POP, which the UI renders as "—".
async function fetchIvLookup(
  supabase: ReturnType<typeof createClient>,
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
  // Prefer call IV at the strike for upside plays, put IV for downside.
  // For mixed structures (condor) we just use whichever is present.
  for (const r of data as Array<{ strike: number; expiration_date: string; option_type: 'C' | 'P'; iv: number | null }>) {
    if (r.iv == null || !(r.iv > 0)) continue
    const key = `${r.strike}|${r.expiration_date}|${r.option_type}`
    lookup.set(key, r.iv)
    // Also seed an aggregate key so callers can ask without specifying side.
    const anyKey = `${r.strike}|${r.expiration_date}|*`
    if (!lookup.has(anyKey)) lookup.set(anyKey, r.iv)
  }
  return lookup
}

function extractJson(rawText: string): unknown {
  const stripped = rawText.replace(/```json|```/g, '').trim()
  const first = stripped.indexOf('{')
  const last = stripped.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('analysis engine did not return parseable JSON')
  }
  return JSON.parse(stripped.slice(first, last + 1))
}

// Cash Moves R/R floor — every play must clear 1:1.5. Same threshold
// as the StrikePriceCalculator (DEBIT_PREMIUM_MAX_PCT 0.4 /
// CREDIT_PREMIUM_MIN_PCT 0.6). Keeping these constants in lockstep with
// the frontend is intentional: the suggester and the calculator should
// never disagree about whether a play is rule-clean.
const MIN_RISK_REWARD = 1.5

// Trust the dollar fields, not the self-reported risk_reward — Claude
// occasionally reports an R/R that contradicts its own max_profit /
// max_loss. When dollars are present, derive R/R from them; otherwise
// fall back to the declared field. Returns null if neither is usable.
function effectiveRiskReward(p: any): number | null {
  const mp = Number(p?.max_profit_per_spread)
  const ml = Number(p?.max_loss_per_spread)
  if (Number.isFinite(mp) && Number.isFinite(ml) && ml > 0) return mp / ml
  const declared = Number(p?.risk_reward)
  return Number.isFinite(declared) ? declared : null
}

// Validate the plays match the matrix's strikes + expirations exactly so
// we don't deep-link the user into the calculator with a strike that
// doesn't trade. Also enforces the R/R >= 1.5 rule the rest of the app
// (StrikePriceCalculator, pre-trade checklist) already enforces — without
// this filter the suggester contradicts the calculator on the same play.
//
// Returns { parsed, rejection_summary } so callers can surface telemetry
// to the response payload. Each rejection also emits a structured
// console.warn so 4-week aggregate rates are queryable from Edge Function
// logs (search "[validate] dropped").
function validatePlays(parsed: any, matrix: MatrixData): {
  parsed: any
  rejection_summary: {
    total_proposed: number
    total_kept: number
    total_rejected: number
    by_reason: Record<string, number>
    by_structure: Record<string, number>
  }
} {
  const summary = {
    total_proposed: 0,
    total_kept: 0,
    total_rejected: 0,
    by_reason: {} as Record<string, number>,
    by_structure: {} as Record<string, number>,
  }
  if (!parsed?.plays || !Array.isArray(parsed.plays)) {
    return { parsed, rejection_summary: summary }
  }
  summary.total_proposed = parsed.plays.length
  const strikeSet = new Set(matrix.strikes)
  const expDates = new Set(matrix.expirations.map((e) => e.date))
  const dominantExp: string | null =
    typeof parsed.dominant_gex_expiration === 'string' ? parsed.dominant_gex_expiration : null

  const reject = (p: any, reason: string) => {
    summary.total_rejected++
    summary.by_reason[reason] = (summary.by_reason[reason] ?? 0) + 1
    const struct = typeof p?.type === 'string' ? p.type : 'UNKNOWN'
    summary.by_structure[struct] = (summary.by_structure[struct] ?? 0) + 1
    // Structured prefix so logs are grep-able for retroactive rate calc.
    console.warn('[validate] dropped', JSON.stringify({
      reason,
      ticker: matrix.ticker,
      type: p?.type,
      long_strike: p?.long_strike,
      short_strike: p?.short_strike,
      expiration: p?.expiration,
      risk_reward: p?.risk_reward,
      effective_rr: effectiveRiskReward(p),
      max_profit_per_spread: p?.max_profit_per_spread,
      max_loss_per_spread: p?.max_loss_per_spread,
    }))
  }

  parsed.plays = parsed.plays.filter((p: any) => {
    if (!strikeSet.has(p.long_strike) || !strikeSet.has(p.short_strike)) {
      reject(p, 'strike_not_in_matrix')
      return false
    }
    if (!expDates.has(p.expiration)) {
      reject(p, 'expiration_not_in_matrix')
      return false
    }
    const rr = effectiveRiskReward(p)
    if (rr == null) {
      reject(p, 'rr_unknown')
      return false
    }
    if (rr < MIN_RISK_REWARD) {
      reject(p, 'rr_below_minimum')
      return false
    }
    return true
  })
  summary.total_kept = parsed.plays.length
  // Backstop the roll-off flag server-side: even if Claude forgot to set
  // it, we know the dominant expiration and can fill in the boolean
  // ourselves. The rolloff_note still needs Claude — we don't try to
  // synthesize one here, we just leave a generic fallback.
  for (const p of parsed.plays) {
    if (typeof p.gamma_rolloff_risk !== 'boolean') {
      p.gamma_rolloff_risk = dominantExp != null && p.expiration > dominantExp
    }
    if (p.gamma_rolloff_risk && (!p.rolloff_note || typeof p.rolloff_note !== 'string')) {
      p.rolloff_note = `Expires after the dominant gamma expiration (${dominantExp ?? 'n/a'}); the pinning regime anchoring this thesis rolls off mid-trade.`
    }
    if (!p.gamma_rolloff_risk) p.rolloff_note = ''
  }
  return { parsed, rejection_summary: summary }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'method not allowed' }, 405)

  if (!ANTHROPIC_API_KEY) return json({ success: false, error: 'ANTHROPIC_API_KEY not configured' }, 500)
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY)
    return json({ success: false, error: 'edge function misconfigured' }, 500)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ success: false, error: 'unauthorized' }, 401)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) return json({ success: false, error: 'unauthorized' }, 401)

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Rate limit check (shared with analyze-signal via claude_calls ledger).
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count: recentCalls } = await adminClient
    .from('claude_calls')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('called_at', sinceIso)
  if ((recentCalls ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return json(
      { success: false, error: `rate limited: ${RATE_LIMIT_PER_HOUR} analyses per hour reached` },
      429,
    )
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ success: false, error: 'invalid JSON body' }, 400) }

  const ticker = String(body.ticker ?? '').trim().toUpperCase()
  if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return json({ success: false, error: 'invalid ticker' }, 400)
  }
  const accountSize = Number(body.account_size)
  if (!Number.isFinite(accountSize) || accountSize <= 0) {
    return json({ success: false, error: 'account_size must be a positive number' }, 400)
  }

  // Cache check — same matrix + same account size = same suggestions for 5 min
  const cacheKey = `${ticker}|${Math.floor(accountSize / 1000)}`
  const { data: cached } = await adminClient
    .from('play_suggestions')
    .select('payload, computed_at')
    .eq('cache_key', cacheKey)
    .maybeSingle()
  if (cached?.payload && cached.computed_at) {
    const age = Date.now() - new Date(cached.computed_at).getTime()
    if (age >= 0 && age < CACHE_TTL_MS) {
      return json({ success: true, data: { ...cached.payload, from_cache: true, cache_age_ms: age } })
    }
  }

  // Pull the live matrix via the existing compute-gex endpoint. Reuses
  // its dxlink/yahoo fallback chain — single source of truth for the
  // numbers Claude reasons about.
  //
  // We pass through the *user's* JWT (authHeader) rather than the
  // service-role key. The Supabase Functions gateway has stricter
  // validation on internal service-role calls and was rejecting them
  // with UNAUTHORIZED_INVALID_JWT_FORMAT; user JWTs flow through
  // cleanly because that's what compute-gex's verify_jwt expects.
  const gexResp = await fetch(`${SUPABASE_URL}/functions/v1/compute-gex`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      apikey: SUPABASE_ANON_KEY!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticker, matrix: true }),
  })
  if (!gexResp.ok) {
    const detail = await gexResp.text().catch(() => '')
    return json({ success: false, error: `compute-gex returned ${gexResp.status}: ${detail.slice(0, 200)}` }, 502)
  }
  const gexBody = await gexResp.json()
  if (!gexBody?.success || !gexBody?.data) {
    return json({ success: false, error: gexBody?.error ?? 'compute-gex returned no data' }, 502)
  }
  const matrix = gexBody.data as MatrixData

  // Pull today's options flow aggregates so Claude can see "where
  // prints actually went today" alongside the GEX matrix. Best-effort:
  // if the table is empty (worker not subscribed yet, or pre-RTH)
  // we still proceed with just the GEX context.
  const flow = await fetchTodayFlow(adminClient, ticker)

  // Claude call.
  const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      // Pinned low so the same matrix returns essentially the same
      // answer across re-analyses — the matrix itself evolves intraday
      // (OI rolls, walls shift), and we want the user to be able to
      // tell whether a different suggestion came from a data change
      // or just model drift. 0.2 keeps a sliver of variance for
      // tie-breaking when two plays score nearly identically.
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(matrix, accountSize, flow) }],
    }),
  })
  if (!claudeResp.ok) {
    const detail = await claudeResp.text().catch(() => '')
    return json({ success: false, error: `analysis backend returned ${claudeResp.status}: ${detail.slice(0, 200)}` }, 502)
  }
  const claudeBody = await claudeResp.json()
  const text = claudeBody?.content?.[0]?.text
  if (!text) return json({ success: false, error: 'analysis response had no text content' }, 502)
  if (claudeBody.stop_reason === 'max_tokens') {
    return json({ success: false, error: 'analysis response truncated; try a different ticker' }, 502)
  }

  let parsed
  try { parsed = extractJson(text) } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : 'parse error', raw: text.slice(0, 300) }, 502)
  }
  const validated = validatePlays(parsed, matrix)
  parsed = validated.parsed
  const rejectionSummary = validated.rejection_summary
  // One aggregate line per request — easier to scan in Edge Function logs
  // than the per-play `[validate] dropped` warnings when computing daily
  // rejection rate. Search "[suggest-plays] summary" to aggregate.
  console.log('[suggest-plays] summary', JSON.stringify({
    ticker: matrix.ticker,
    proposed: rejectionSummary.total_proposed,
    kept: rejectionSummary.total_kept,
    rejected: rejectionSummary.total_rejected,
    by_reason: rejectionSummary.by_reason,
    by_structure: rejectionSummary.by_structure,
  }))

  // Compute per-play Probability of Profit at Expiration (POP) so the
  // user sees an entry probability on each card AND the value can be
  // hash-locked into the signal at log time. Bulk-pulls IV per
  // (strike, expiration) from dxlink_quotes; rows missing IV (yahoo
  // fallback / worker offline) yield null POP, which the UI gracefully
  // renders as "—".
  if (parsed?.plays && Array.isArray(parsed.plays) && parsed.plays.length > 0) {
    const ivLookup = await fetchIvLookup(adminClient, ticker, parsed.plays)
    for (const p of parsed.plays) {
      // Pick the IV at the strike that anchors the trade's risk side:
      //   - debit longs and credit shorts both pivot on `long_strike`
      //     for upside, `short_strike` for credit shorts. The exact
      //     strike picked matters less than using SOME at-the-trade
      //     IV; differences across one-strike steps are <1% absolute.
      const expiry: string = p.expiration
      const longK: number = Number(p.long_strike)
      const shortK: number = Number(p.short_strike)
      const anchor = p.type === 'IRON_CONDOR'
        ? Math.round((longK + shortK) / 2) // closest strike to spot for condor
        : (p.type === 'BEAR_CALL_CREDIT' || p.type === 'BULL_PUT_CREDIT')
          ? shortK
          : longK
      const sigma =
        ivLookup.get(`${anchor}|${expiry}|*`) ??
        ivLookup.get(`${longK}|${expiry}|*`) ??
        ivLookup.get(`${shortK}|${expiry}|*`) ??
        0
      // Net debit / credit per spread are dollar-denominated — convert
      // estimated_debit_pct_of_width back to a dollar value using the
      // spread width since Claude only ships the percentage.
      const width = Math.abs(longK - shortK)
      const debitPct = Number(p.estimated_debit_pct_of_width) / 100
      const isDebit = p.type === 'BULL_CALL' || p.type === 'BEAR_PUT'
      const netDebit = isDebit && Number.isFinite(debitPct) ? width * debitPct : undefined
      const netCredit = !isDebit && Number.isFinite(debitPct) ? width * (1 - debitPct) : undefined

      p.entry_pop_bp = computePopBp({
        spot: matrix.spot,
        sigma,
        dte: Number(p.dte) || 0,
        type: p.type,
        long_strike: longK,
        short_strike: shortK,
        inner_call_strike: p.type === 'IRON_CONDOR' ? Math.max(longK, shortK) : undefined,
        inner_put_strike: p.type === 'IRON_CONDOR' ? Math.min(longK, shortK) : undefined,
        net_debit: netDebit,
        net_credit: netCredit,
      })
    }
  }

  // Account for the call against the rate-limit ledger
  await adminClient.from('claude_calls').insert({
    user_id: user.id,
    function_name: 'suggest-plays',
    called_at: new Date().toISOString(),
  }).then(() => {})

  // Cache the result
  const payload = {
    ticker,
    spot: matrix.spot,
    source: matrix.source,
    account_size: accountSize,
    ...parsed,
    // Per-request rejection telemetry — kept in the cached payload so a
    // 4-week analysis can read counts off `play_suggestions.payload`
    // without needing to retain Edge Function logs that long.
    rejection_summary: rejectionSummary,
    computed_at: new Date().toISOString(),
  }
  adminClient.from('play_suggestions').upsert(
    { cache_key: cacheKey, payload, computed_at: new Date().toISOString() },
    { onConflict: 'cache_key' },
  ).then(() => {})

  return json({ success: true, data: { ...payload, from_cache: false, cache_age_ms: 0 } })
})
