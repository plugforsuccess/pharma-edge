import { Link } from 'react-router-dom'
import LearnLayout from '../../components/LearnLayout'
import { getArticleBySlug, getNeighbors } from '../../lib/learnArticles'

const SLUG = 'gamma-flip-trading'

export default function GammaFlipTrading() {
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
        If you're going to internalize one concept from gamma-exposure-based
        trading, make it this one: the zero-gamma level (the flip) is the line
        between two structurally different markets. Above it and below it are
        not the same market with the same rules. Treating them as if they are
        is the single most expensive mistake retail traders make in
        short-dated options.
      </p>

      <h2>What the flip actually is</h2>
      <p>
        The flip is the strike at which cumulative dealer gamma exposure
        crosses from net positive to net negative (scanning from the lowest
        strike upward). Mechanically: at this price level, the collective
        dealer book is <em>gamma-neutral</em>. They're neither long nor short
        gamma in aggregate. Above it, they're long gamma. Below it, they're
        short gamma.
      </p>
      <p>
        This is not a chart-pattern level. It's not a Fibonacci retracement.
        It's a deterministic consequence of where retail and institutional
        positioning sits in the option chain. Compute it from open interest
        and gamma; you don't draw it.
      </p>

      <h2>Above the flip — vol-suppressed regime</h2>
      <p>
        When spot is above the flip, dealers are long gamma. To stay neutral,
        they sell into rallies and buy into dips. This is the same hedging
        loop that produces classic pinning behavior — it dampens both up- and
        downside moves, compresses realized volatility, and creates the
        coiled-spring feel of slow grinding markets.
      </p>
      <p>
        The trade structures that win here are <strong>short premium</strong>:
        iron condors anchored to the walls, credit spreads, calendars. Pin
        trades targeting the call wall as a magnet also work — but you're
        accepting that the wall <em>holds</em>, which is the same trade as
        being short volatility.
      </p>
      <p>
        What does <em>not</em> work above the flip: aggressive long premium
        plays expecting big breakouts. The hedging flow is fighting you. You
        can be directionally right and still lose because the IV crush plus
        theta decay outpaces the move.
      </p>

      <h2>Below the flip — vol-amplified regime</h2>
      <p>
        When spot is below the flip, dealers are short gamma. To stay neutral,
        they buy into rallies and sell into dips. This is the procyclical
        hedging that amplifies moves in either direction — it's what creates
        breakaway rallies, gamma squeezes, and the cascading selloffs you see
        on 4% red days.
      </p>
      <p>
        Trade structures that win here are <strong>long premium</strong>:
        debit spreads, straddles into expected expansion, breakdown puts at the
        put wall. Charm decay also works in your favor when the move is
        trending in your direction (delta accelerates as time passes when an
        option is in the money).
      </p>
      <p>
        What does <em>not</em> work below the flip: short-premium structures.
        IV is expanding, the underlying is moving more than the option chain
        was pricing in, and your max-loss strikes get tested faster than your
        time-decay can mature.
      </p>

      <h2>Trading the cross</h2>
      <p>
        The crossing event itself is the highest-information moment in a
        trading day. Spot moving from above to below the flip is a regime
        change — not a level break in a chart pattern, but a fundamental
        shift in what kind of market you're trading. The same is true of
        crossing back above.
      </p>
      <p>
        Three rules for trading flip crosses:
      </p>
      <ol>
        <li>
          <strong>Don't fade the cross.</strong> If spot is breaking through
          the flip on rising volume and IV, the new regime is taking over.
          Counter-trend trades against a regime change have the worst
          asymmetric risk in this game. Wait for the new regime to settle
          (typically 30–60 minutes post-cross) before structuring counter-
          regime trades.
        </li>
        <li>
          <strong>Resize on the cross.</strong> Long-premium positions
          opened above the flip should be re-evaluated when the cross
          happens. The thesis didn't change; the regime did. Often this
          means closing the position and re-entering in a structure that
          fits the new regime.
        </li>
        <li>
          <strong>Watch for re-cross.</strong> Failed crosses (breaking
          through, then snapping back within minutes) are some of the
          highest-conviction reversal signals in the book. They tell you
          dealers couldn't or wouldn't reposition fast enough — and the
          dominant flow is mean-reverting back to the old regime.
        </li>
      </ol>

      <h2>The flip as a pin target</h2>
      <p>
        On expiration days, the flip itself often acts as a magnet. Why: as
        OI rolls off and the gamma profile thins, the flip migrates toward
        the strike with the largest residual gamma — usually a high-volume
        ATM strike. Spot tends to gravitate there into close because that's
        where dealers' hedging flow is strongest as charm bleeds in.
      </p>
      <p>
        For a deeper dive on this dynamic, see <Link to="/learn/0dte-pinning-strategy">0DTE
        pinning strategy</Link>.
      </p>

      <h2>How to know where the flip is</h2>
      <p>
        Cash Moves' <Link to="/markets">HeatPulse</Link> view marks the flip
        directly on the heatmap. The <Link to="/reasoning">Reasoning</Link>
        page shows it as part of the regime banner — A (above + positive GEX)
        vs. B (below + negative GEX) vs. mixed. SpotGamma and Skylit also
        publish flip levels for the major indices, though usually with a
        15-minute delay outside their highest-tier subscriptions.
      </p>
      <p>
        The math is simple enough to compute manually if you have an OI feed:
        sum gamma × OI × spot² across all strikes, scan from low to high,
        find the strike where the running sum crosses zero. That's the flip.
      </p>

      <h2>What to do tomorrow</h2>
      <p>
        Open the chart of whatever you trade most often. Find the flip on
        HeatPulse. Note where spot is relative to the flip right now. Now
        review your last 10 trades — were they regime-aligned? If your win
        rate clusters on regime-aligned trades and your losses cluster on
        regime-fighting trades, you've found the cheapest edge available in
        retail options. Use it.
      </p>
    </LearnLayout>
  )
}
