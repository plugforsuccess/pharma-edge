import { ArrowLeft, Target } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

// Plain-language definitions for the GEX vocabulary used on /markets.
// Cameron's day-1 reference — the goal is "I see Net GEX +$5M and a
// flip strike of 510 — what does that mean for tomorrow's tape?"
//
// Wording is intentionally non-academic: this is for traders sizing
// positions, not for textbook fidelity. Footnotes link to deeper
// references where appropriate.

export default function Glossary() {
  const navigate = useNavigate()
  return (
    <div className="px-4 lg:px-6 py-5 space-y-5 max-w-md lg:max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 text-subtle hover:text-fg"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-lg font-semibold leading-tight">GEX Glossary</h1>
          <p className="text-xs text-subtle">
            What the heatmap is telling you, in trader language.
          </p>
        </div>
      </div>

      {/* ── How to Trade GEX (top-of-page playbook) ──
          The actionable section. Lives above the term definitions
          because Cameron wanted "what do I DO with this" front and
          centre on day 1. */}
      <section className="bg-card border border-amber-400/30 rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Target size={14} className="text-amber-400" />
          <h2 className="text-sm font-semibold text-fg">
            How to Trade GEX
          </h2>
        </div>

        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
            The 5-second read
          </h3>
          <p className="text-xs text-subtle leading-relaxed">
            Before you do anything on /markets, note three numbers:
          </p>
          <ol className="list-decimal pl-5 text-xs text-subtle space-y-1.5 leading-relaxed">
            <li>
              <strong className="text-fg">Net GEX sign</strong> — positive
              or negative? <span className="text-muted">Regime indicator.</span>
            </li>
            <li>
              <strong className="text-fg">Flip strike vs spot</strong> —
              are we above or below?{' '}
              <span className="text-muted">Volatility regime confirmation.</span>
            </li>
            <li>
              <strong className="text-fg">Call Wall</strong> (★ on biggest
              yellow cell) and{' '}
              <strong className="text-fg">Put Wall</strong> (biggest
              magenta) — <span className="text-muted">upper / lower magnets.</span>
            </li>
          </ol>
        </div>

        <div className="space-y-2 pt-1 border-t border-border">
          <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
            Two regimes, two playbooks
          </h3>
          <div className="bg-bg-elev border border-border rounded-lg p-3 space-y-2">
            <p className="text-xs leading-relaxed">
              <strong className="text-green-400">Regime A:</strong>{' '}
              <span className="text-subtle">Above flip + Net GEX positive.</span>
            </p>
            <p className="text-[11px] text-muted leading-relaxed">
              Dealers are long gamma → they sell rallies, buy dips →
              <strong className="text-fg"> range-bound, mean-reverting tape.</strong>
            </p>
          </div>
          <div className="bg-bg-elev border border-border rounded-lg p-3 space-y-2">
            <p className="text-xs leading-relaxed">
              <strong className="text-crimson">Regime B:</strong>{' '}
              <span className="text-subtle">Below flip + Net GEX negative.</span>
            </p>
            <p className="text-[11px] text-muted leading-relaxed">
              Dealers are short gamma → they buy rallies, sell dips →
              <strong className="text-fg"> trending, volatile tape.</strong>
            </p>
          </div>
        </div>

        <div className="space-y-2 pt-1 border-t border-border">
          <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
            Picking a long-options trade
          </h3>
          <div className="space-y-2">
            <PlaybookRow
              setup="Pin trade (mean-revert)"
              regime="A"
              strike="At/just-OTM toward call wall"
              dte="0–7 DTE"
              why="High gamma; market magnetizes; theta works for you"
            />
            <PlaybookRow
              setup="Breakout call"
              regime="A or B"
              strike="At the call wall"
              dte="7–21 DTE"
              why="If wall breaks, dealers chase. Buy AT the wall, not above"
            />
            <PlaybookRow
              setup="Breakdown put"
              regime="B"
              strike="At the put wall"
              dte="7–21 DTE"
              why="If wall breaks, dealers sell into it → acceleration"
            />
            <PlaybookRow
              setup="Vol expansion (long premium)"
              regime="B"
              strike="ATM straddle (both sides)"
              dte="14–30 DTE"
              why="Negative GEX = vol expansion in your favor"
            />
            <PlaybookRow
              setup="Biotech catalyst spread"
              regime="either"
              strike="Use Strike Calculator; GEX confirms direction"
              dte="30–45d past catalyst"
              why="GEX shows where dealers will pin price into the event"
            />
          </div>
        </div>

        <div className="space-y-2 pt-1 border-t border-border">
          <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
            Spot holds
          </h3>
          <p className="text-xs text-subtle leading-relaxed">
            <strong className="text-green-400">Long the underlying:</strong>
          </p>
          <ul className="list-disc pl-5 text-[11px] text-subtle space-y-1 leading-relaxed">
            <li>
              <em className="text-fg not-italic">Above flip + positive GEX:</em>{' '}
              low realized vol, tight stops safe (dealers buy dips). Good
              hold environment.
            </li>
            <li>
              <em className="text-fg not-italic">Below flip + negative GEX:</em>{' '}
              wide stops, half size. Dealer flow can run against you.
            </li>
          </ul>
          <p className="text-xs text-subtle leading-relaxed pt-1">
            <strong className="text-crimson">Short the underlying:</strong>
          </p>
          <ul className="list-disc pl-5 text-[11px] text-subtle space-y-1 leading-relaxed">
            <li>
              <em className="text-fg not-italic">Above flip:</em> don't.
              Dealer buy-dip flow cushions every selloff. Bad R/R.
            </li>
            <li>
              <em className="text-fg not-italic">Below flip:</em> shorts work.
              Stop just above the put wall (the support about to break).
            </li>
          </ul>
        </div>

        <div className="space-y-2 pt-1 border-t border-border">
          <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider">
            Workflow on /markets
          </h3>
          <ol className="list-decimal pl-5 text-[11px] text-subtle space-y-1 leading-relaxed">
            <li>Tap ticker → check spot vs flip → note Net GEX sign</li>
            <li>Find the largest call wall (★) and largest magenta cell</li>
            <li>
              Ask: where would a sensible trader's stop &amp; target be?
              Walls = both
            </li>
            <li>Identify regime A (mean-revert) vs B (trend)</li>
            <li>
              Pick instrument: spreads in A (capped vol), straddles/long
              premium in B
            </li>
            <li>
              Pick expiration: 0–7 DTE pin/scalp, 7–21 swing through
              walls, 30+ for thesis trades
            </li>
            <li>
              End of day: hit replay (clock icon) → did the wall hold?
              Did the flip move? That's tomorrow's setup.
            </li>
          </ol>
        </div>

        <p className="text-[10px] text-muted leading-relaxed pt-2 border-t border-border">
          None of this is investment advice. GEX informs probability, not
          certainty — walls fail, flips move, regimes change intraday.
          Always size positions per Cash Moves rules (max 2% per options
          trade, max 20% sector exposure).
        </p>
      </section>

      {/* ── Reading the heatmap colors ──
          Renders the actual viridis + magenta gradients so users can map
          a cell they see in /markets straight back to a magnitude class.
          Color stops mirror GexMatrix.jsx exactly. */}
      <section className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">
            Reading the heatmap colors
          </h2>
          <p className="text-xs text-amber-400 mt-0.5">
            What each cell color means + how to spot the structural markers.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-green-400">
            Positive GEX (call-side concentration)
          </h3>
          <div className="flex items-center gap-2 text-[10px] text-subtle">
            <span className="shrink-0">Near zero</span>
            <div
              className="flex-1 h-5 rounded"
              style={{
                background:
                  'linear-gradient(90deg, rgb(21,41,94) 0%, rgb(58,93,160) 20%, rgb(45,173,187) 40%, rgb(61,168,86) 60%, rgb(163,230,53) 80%, rgb(250,204,21) 100%)',
              }}
              aria-hidden
            />
            <span className="shrink-0">Largest call wall</span>
          </div>
          <ul className="text-[11px] text-subtle space-y-1 leading-relaxed pl-3">
            <li>
              <span className="inline-block w-3 h-3 align-middle mr-1.5 rounded-sm" style={{ background: 'rgb(21,41,94)' }} />
              <strong className="text-fg">Dark navy</strong> — minimal
              dealer hedging at this strike, ignore
            </li>
            <li>
              <span className="inline-block w-3 h-3 align-middle mr-1.5 rounded-sm" style={{ background: 'rgb(58,93,160)' }} />
              <span className="inline-block w-3 h-3 align-middle mr-1.5 rounded-sm" style={{ background: 'rgb(45,173,187)' }} />
              <strong className="text-fg">Blue / teal</strong> — moderate
              positive GEX; supports / resists mildly
            </li>
            <li>
              <span className="inline-block w-3 h-3 align-middle mr-1.5 rounded-sm" style={{ background: 'rgb(61,168,86)' }} />
              <span className="inline-block w-3 h-3 align-middle mr-1.5 rounded-sm" style={{ background: 'rgb(163,230,53)' }} />
              <strong className="text-fg">Green / lime</strong> — strong
              call wall, real magnet
            </li>
            <li>
              <span className="inline-block w-3 h-3 align-middle mr-1.5 rounded-sm" style={{ background: 'rgb(250,204,21)' }} />
              <strong className="text-fg">Yellow</strong> — the largest
              positive GEX in the matrix; this is your primary call wall
              (gets the ★)
            </li>
          </ul>
        </div>

        <div className="space-y-2 pt-1 border-t border-border">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-crimson">
            Negative GEX (put-side concentration)
          </h3>
          <div className="flex items-center gap-2 text-[10px] text-subtle">
            <span className="shrink-0">Near zero</span>
            <div
              className="flex-1 h-5 rounded"
              style={{
                background:
                  'linear-gradient(90deg, rgb(21,41,94) 0%, rgb(76,29,149) 40%, rgb(134,25,143) 70%, rgb(217,46,155) 100%)',
              }}
              aria-hidden
            />
            <span className="shrink-0">Largest put wall</span>
          </div>
          <ul className="text-[11px] text-subtle space-y-1 leading-relaxed pl-3">
            <li>
              <span className="inline-block w-3 h-3 align-middle mr-1.5 rounded-sm" style={{ background: 'rgb(76,29,149)' }} />
              <strong className="text-fg">Indigo</strong> — moderate put
              concentration; downside support at this level
            </li>
            <li>
              <span className="inline-block w-3 h-3 align-middle mr-1.5 rounded-sm" style={{ background: 'rgb(134,25,143)' }} />
              <strong className="text-fg">Purple</strong> — strong put
              wall, dealer flow defends here
            </li>
            <li>
              <span className="inline-block w-3 h-3 align-middle mr-1.5 rounded-sm" style={{ background: 'rgb(217,46,155)' }} />
              <strong className="text-fg">Magenta</strong> — the largest
              negative GEX; primary put wall, key support level
            </li>
          </ul>
        </div>

        <div className="space-y-2 pt-1 border-t border-border">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">
            Special markers
          </h3>
          <ul className="text-[11px] text-subtle space-y-1.5 leading-relaxed">
            <li className="flex items-start gap-2">
              <span className="text-amber-400 shrink-0 w-4 text-center">★</span>
              <span>
                <strong className="text-fg">Star</strong> on the cell with
                the largest absolute GEX in the entire matrix — your most
                "magnetic" strike (could be call or put wall)
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-amber-400 shrink-0 w-4 text-center">▶</span>
              <span>
                <strong className="text-fg">Triangle</strong> on the spot
                row, with an amber horizontal divider — current price
                location in the strike ladder
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-cyan-400 shrink-0 w-4 text-center">●</span>
              <span>
                <strong className="text-fg">Cyan border</strong> (when
                visible) marks the flip strike — where cumulative GEX
                crosses zero
              </span>
            </li>
          </ul>
        </div>

        <div className="space-y-2 pt-1 border-t border-border">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">
            Practical reading
          </h3>
          <p className="text-[11px] text-subtle leading-relaxed">
            Color intensity scales relative to the <strong className="text-fg">
            largest absolute GEX in the visible window</strong>, not to a
            fixed dollar amount. A yellow cell on a low-volume biotech
            might be $5M; on SPY it's $300M+. Always read the dollar value,
            not just the color.
          </p>
          <p className="text-[11px] text-subtle leading-relaxed">
            Walls of <strong className="text-fg">opposite color stacked
            close to spot</strong> = a tight battle zone. Expect
            volatility compression until one breaks. Walls{' '}
            <strong className="text-fg">far apart from spot</strong> =
            wide pin range; price drifts inside the corridor.
          </p>
        </div>
      </section>

      <Term
        title="Gamma Exposure (GEX)"
        short="$ that dealers must trade per 1% spot move."
      >
        <p>
          Each strike has open interest in calls and puts. Dealers are
          generally on the other side: short calls / long puts to
          retail. Their delta hedge moves as spot moves — and how fast
          it moves is gamma. <strong>GEX = OI × gamma × $-per-1%-move</strong>,
          summed over the chain.
        </p>
        <p>
          Big positive GEX at a strike = dealers must sell into rallies
          and buy into dips around that strike (dampens vol, "magnet").
          Big negative GEX = dealers chase the move (amplifies vol,
          "accelerator").
        </p>
      </Term>

      <Term
        title="Net GEX"
        short="Total dealer gamma across all strikes."
      >
        <p>
          Sum of GEX across every strike in the chain. The aggregate
          tells you the regime:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong className="text-green-400">Net GEX positive</strong> —
            dealers are long gamma. They sell rallies, buy dips. Range-bound,
            mean-reverting tape.
          </li>
          <li>
            <strong className="text-crimson">Net GEX negative</strong> —
            dealers are short gamma. They buy rallies, sell dips. Trending,
            volatile tape.
          </li>
        </ul>
      </Term>

      <Term
        title="Flip Strike (Zero-Gamma)"
        short="The price level that flips dealers from positive to negative gamma."
      >
        <p>
          Walking up the chain from low strike, cumulative GEX flips
          sign at this strike. <strong>Above the flip = stable
          regime</strong> (dealers dampening). <strong>Below the flip
          = unstable regime</strong> (dealers amplifying).
        </p>
        <p className="text-subtle">
          Practical use: if SPY is $510 and the flip is $505, a break
          below $505 typically accelerates because dealers stop being
          a buyer and start being a seller.
        </p>
      </Term>

      <Term
        title="Call Wall"
        short="The strike with the largest positive GEX."
      >
        <p>
          The biggest concentration of dealer call gamma. Acts as an
          upside magnet → resistance on the way up. Spot tends to
          gravitate toward it on the day, then bounce off it as
          dealers sell into the rally.
        </p>
        <p className="text-subtle">
          On the heatmap: the strike with the brightest yellow cell
          and the ★ marker.
        </p>
      </Term>

      <Term
        title="Put Wall"
        short="The strike with the largest negative GEX."
      >
        <p>
          The biggest concentration of dealer put gamma. Acts as a
          downside magnet → support on the way down. Below it, dealer
          short-gamma dynamics tend to take over and accelerate.
        </p>
      </Term>

      <Term
        title="0DTE / 1DTE / 2DTE"
        short="Days to expiration — short-dated options dominate intraday GEX."
      >
        <p>
          Options expiring today (0DTE) carry massive gamma per dollar
          of premium because their value collapses to zero at the
          close. Most intraday GEX flow on SPY/QQQ/SPX comes from
          these. In the matrix, the leftmost column is usually the
          most relevant for "what happens this afternoon."
        </p>
      </Term>

      <Term
        title="NetVEX (Net Vega Exposure)"
        short="Same idea as GEX but for vega — sensitivity to IV moves."
      >
        <p>
          Vega is how much an option's price moves per 1% change in
          implied volatility. NetVEX aggregates dealer vega across the
          chain. Positive NetVEX = dealers benefit from IV up-moves
          (will sell IV into spikes). Negative NetVEX = dealers benefit
          from IV down-moves (vol-supportive).
        </p>
        <p className="text-subtle">
          Useful around earnings + Fed days when IV regime matters as
          much as direction.
        </p>
      </Term>

      <Term
        title="OPRA / DXLink / OPRA Level 1"
        short="The data feeds powering the live heatmap."
      >
        <p>
          OPRA is the official US options data feed run by the
          exchanges. Tastytrade resells it through DXLink (a WebSocket
          protocol) — that's what the worker connects to so the
          markets page can show real-time gamma + OI per strike.
          Tickers we don't stream fall back to Yahoo's free 15-minute
          delayed data.
        </p>
      </Term>

      <Term
        title="Replay"
        short="Scrub through today's GEX snapshots to see how positioning evolved."
      >
        <p>
          Snapshots are taken every 5 min during US market hours.
          Tap the clock icon on the heatmap header to open the slider;
          drag to any time, or hit play to auto-advance. Good for
          end-of-day post-mortems: where did the call wall first form?
          When did the flip strike move?
        </p>
      </Term>

      <div className="pt-4 border-t border-border space-y-2">
        <p className="text-[11px] text-subtle leading-relaxed">
          <strong className="text-fg">Quick read of the heatmap:</strong>{' '}
          rows are strikes (high to low), columns are expirations (near
          to far). Bright yellow cell with ★ = call wall. Bright
          magenta = put wall. Cyan-bordered row = current spot.
        </p>
        <p className="text-[10px] text-muted leading-relaxed">
          GEX vocabulary follows the SpotGamma / Tier1 Alpha conventions
          most retail vol traders are used to. None of this is investment
          advice.
        </p>
      </div>
    </div>
  )
}

function Term({ title, short, children }) {
  return (
    <section className="bg-card border border-border rounded-xl p-4 space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <p className="text-xs text-amber-400 mt-0.5">{short}</p>
      </div>
      <div className="text-xs text-subtle leading-relaxed space-y-2">
        {children}
      </div>
    </section>
  )
}

function PlaybookRow({ setup, regime, strike, dte, why }) {
  return (
    <div className="bg-bg-elev border border-border rounded-lg p-2.5 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-fg leading-tight">
          {setup}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-amber-400 font-semibold shrink-0">
          {regime}
        </span>
      </div>
      <div className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 text-[11px] leading-snug">
        <span className="text-muted uppercase tracking-wider text-[9px] pt-0.5">
          Strike
        </span>
        <span className="text-subtle">{strike}</span>
        <span className="text-muted uppercase tracking-wider text-[9px] pt-0.5">
          DTE
        </span>
        <span className="text-subtle">{dte}</span>
      </div>
      <p className="text-[10px] text-muted leading-relaxed pt-0.5 border-t border-border">
        {why}
      </p>
    </div>
  )
}
