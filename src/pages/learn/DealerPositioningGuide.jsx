import { Link } from 'react-router-dom'
import LearnLayout from '../../components/LearnLayout'
import { getArticleBySlug, getNeighbors } from '../../lib/learnArticles'

const SLUG = 'dealer-positioning-guide'

export default function DealerPositioningGuide() {
  const meta = getArticleBySlug(SLUG)
  const { prev, next } = getNeighbors(SLUG)
  return (
    <LearnLayout
      title={meta.title}
      description={meta.description}
      slug={SLUG}
      publishedAt="May 8, 2026"
      updatedAt="May 8, 2026"
      prevArticle={prev}
      nextArticle={next}
    >
      <p>
        Most retail traders look at an option chain and see strikes, premiums, and
        Greeks. Professional traders look at the same chain and see something else
        entirely: the inventory of every dealer in the market, and what those
        dealers are about to do to keep that inventory neutral. That second view
        is the one that drives short-term price action — and once you can see it,
        the tape stops looking random.
      </p>

      <h2>Who actually trades against you</h2>
      <p>
        When you buy an option, you are almost never buying it from another
        retail trader. You're buying it from a market maker — typically Citadel
        Securities, Susquehanna, Jane Street, or Optiver. These dealers are
        agnostic to direction. Their business is selling you the option at the
        ask, simultaneously hedging in the underlying, and capturing the
        bid-ask spread plus a small edge on the volatility surface.
      </p>
      <p>
        That hedging is the key. A dealer who sells you 100 calls is now <strong>short
        gamma</strong> — meaning their delta exposure changes as the underlying
        moves. To stay neutral, they must continuously buy or sell the
        underlying as it moves. The mechanical flow that hedge generates is the
        single largest force in short-dated options markets, and it has nothing
        to do with anyone's view of the stock.
      </p>

      <h2>Long gamma vs. short gamma — the regime distinction</h2>
      <p>
        The collective dealer position across all strikes and expirations sums
        to a single number: <strong>net gamma exposure</strong>, or <strong>GEX</strong>.
        When dealers are net long gamma, they sell rallies and buy dips to stay
        neutral. That hedging flow <em>dampens</em> price moves and produces the
        classic pinning behavior you see around big monthly expirations. When
        dealers are net short gamma, they buy rallies and sell dips. That flow
        <em>amplifies</em> moves — and is what creates gamma squeezes, breakaway
        rallies, and accelerating selloffs.
      </p>
      <p>
        The line between these two regimes is the <Link to="/learn/gamma-flip-trading">zero-gamma
        level (the flip)</Link>. Above it, dealers are usually long gamma and the
        market behaves like a coiled spring. Below it, they're usually short
        gamma and small moves snowball into big ones. This is not a metaphor —
        it's a deterministic consequence of how the dealer book is built.
      </p>

      <h2>Why this matters more in 2026 than it did five years ago</h2>
      <p>
        Two structural shifts have made dealer positioning more important than
        ever for short-term traders:
      </p>
      <ol>
        <li>
          <strong>0DTE options now dominate volume.</strong> SPX 0DTE is roughly
          half of all SPX options volume in 2026. These contracts have the
          highest gamma per dollar of premium of any option you can trade,
          which means dealer hedging flow per dollar of premium is the
          highest. The pinning regime around 0DTE strikes is much sharper
          than it was when monthlies dominated.
        </li>
        <li>
          <strong>Single-name retail flow is concentrated.</strong> Mass-market
          retail platforms have funneled tens of billions of dollars into a
          small set of names (NVDA, TSLA, the magnificent-seven roster). The
          gamma profile in those names is now dominated by dealer-vs-retail
          positioning, not institutional hedging. That makes the dealer book a
          much cleaner signal for short-term direction.
        </li>
      </ol>

      <h2>How to read positioning data</h2>
      <p>
        Three things to look for, in order of importance:
      </p>
      <h3>1. Net GEX sign and magnitude</h3>
      <p>
        Positive net GEX = dealers long gamma = vol-suppressed regime. Look
        for pin trades, short-premium structures, and breakouts <em>at</em> the
        call wall (not through it). Negative net GEX = dealers short gamma =
        trending regime. Long premium and breakdown trades win here.
      </p>

      <h3>2. The walls</h3>
      <p>
        The single largest positive-GEX strike is the <strong>call wall</strong> —
        a magnet on rallies. The largest negative-GEX strike is the <strong>put
        wall</strong> — support on declines. Both function as pin levels in
        positive-gamma regimes and as breakout/breakdown triggers in
        negative-gamma regimes.
      </p>

      <h3>3. The flip</h3>
      <p>
        The zero-gamma level. Where dealers transition from net long to net
        short gamma. Spot crossing the flip is rarely a clean break — it's a
        regime change, and it deserves more respect than any chart-pattern
        signal.
      </p>

      <h2>Where the data comes from</h2>
      <p>
        Open interest comes from the OCC end-of-day file. Greeks come from the
        live options chain via dxFeed (Tastytrade), Polygon, or CBOE direct.
        The math is straightforward: GEX per strike = open interest × gamma ×
        spot squared, with calls positive and puts negative. Aggregate across
        all strikes for net GEX, find the largest cell for the wall, walk the
        cumulative until it crosses zero for the flip.
      </p>
      <p>
        Most retail traders never see this data because their broker doesn't
        surface it. Specialist platforms — see our <Link to="/learn/best-gex-tools">comparison
        of the best GEX tools in 2026</Link> — were the only way until recently.
        Cash Moves' <Link to="/markets">HeatPulse</Link> view computes it live for
        the major indices and the most active single names, and our <Link to="/reasoning">Reasoning
        engine</Link> classifies the regime in real time.
      </p>

      <h2>What to do with this knowledge</h2>
      <p>
        Three things, none of which require new indicators or chart patterns:
      </p>
      <ul>
        <li>
          Before any trade, identify the regime. Long gamma or short? It
          changes the structure you should trade and the timeframe that's
          working today.
        </li>
        <li>
          Anchor strikes to the walls. Trade <em>to</em> the call wall in long
          gamma; trade <em>away from</em> the put wall in short gamma. Don't
          pick strikes off support/resistance lines on a chart when you can
          pick them off the dealer book.
        </li>
        <li>
          Watch for flip crosses. They're the cleanest single signal you'll
          get all day. They show up before the chart does, because price has
          to lead the flip cross to make it happen.
        </li>
      </ul>
      <p>
        Dealer positioning isn't predictive of weekly direction. It's
        descriptive of <em>now</em>, and it tells you which forces are about to
        move price in the next minutes-to-hours. That's the timeframe most
        retail options trades live and die in. Trading without it is leaving
        the largest source of short-term edge unread.
      </p>
    </LearnLayout>
  )
}
