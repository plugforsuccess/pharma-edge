import { ArrowLeft } from 'lucide-react'
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
    <div className="px-4 py-5 space-y-5 max-w-md mx-auto">
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
