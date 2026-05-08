import { Link } from 'react-router-dom'
import LearnLayout from '../../components/LearnLayout'
import { getArticleBySlug, getNeighbors } from '../../lib/learnArticles'

const SLUG = 'vanna-exposure-explained'

export default function VannaExposureExplained() {
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
        Most retail traders who follow institutional flow track gamma
        exposure (GEX) — the sensitivity of dealer delta to spot moves. The
        institutional desks figured out a long time ago that GEX explains
        intraday pinning well but multi-day directional drift poorly. The
        metric that explains the multi-day drift is <strong>vanna exposure
        (VEX)</strong>, and it's been a closely-held edge until tooling caught
        up in 2025–26.
      </p>

      <h2>What vanna actually measures</h2>
      <p>
        Vanna is a second-order Greek: <code>∂delta/∂σ</code> — the rate at
        which an option's delta changes as implied volatility changes.
        Equivalently: <code>∂vega/∂spot</code>. Both interpretations point at
        the same hedging requirement: when IV moves, dealers' delta hedge
        requirements move along with it, even if the underlying hasn't moved
        a tick.
      </p>
      <p>
        For OTM calls, vanna is positive. As IV rises, the call's delta rises
        — the option becomes more directional, and a dealer who sold it now
        has more short-delta exposure to cover. They buy underlying stock to
        re-hedge. Conversely, when IV falls, the call's delta falls and the
        dealer sells stock to flatten.
      </p>

      <h2>Why this drives multi-day drift</h2>
      <p>
        Implied volatility doesn't oscillate randomly. It mean-reverts on
        well-defined timescales — fast (intraday around news), medium (day-
        over-day post-event), and slow (weekly into expiration). Each of
        these vol moves generates a vanna-driven hedging flow.
      </p>
      <p>
        The most reliable example: VIX falls into a benign macro window
        (no Fed, no CPI, earnings already digested). Dealer-net-positive
        vanna positions (they're typically long vega from selling calls and
        puts) means falling IV reduces dealer delta exposure. To stay
        neutral, dealers <em>buy stock</em>. Multiplied across the entire
        S&P 500 option complex, this is hundreds of millions of dollars of
        marginal stock buying spread across days.
      </p>
      <p>
        That's the vanna rally. It's the reason markets drift higher in
        post-event vol-compression environments even when there's no
        positive news. The flow is mechanical, deterministic, and
        institutional traders model it down to the basis point.
      </p>

      <h2>VEX vs. GEX — when they say different things</h2>
      <p>
        <strong>GEX</strong>: spot-driven hedging. Net positive GEX = vol-
        suppressed regime. Drives intraday pinning. Best on 1-3 day
        horizons.
      </p>
      <p>
        <strong>VEX</strong>: vol-driven hedging. Net positive VEX (calls
        dominate) = falling IV produces dealer buying. Drives multi-day
        directional drift. Best on 3-10 day horizons.
      </p>
      <p>
        These two often agree — pinning regimes typically have positive VEX
        too, because dealers are long calls in aggregate. But they
        disagree at specific moments, and the disagreement is the signal:
      </p>
      <ul>
        <li>
          <strong>Positive GEX, negative VEX.</strong> Dealers are long
          gamma but short vega — typically because puts dominate the
          chain. Pinning pulls spot sideways while a vol expansion would
          force dealers to sell stock. Translation: pinned, but a single
          IV pop punches through. Lean toward long-premium structures
          targeting that pop.
        </li>
        <li>
          <strong>Negative GEX, positive VEX.</strong> Trending regime, but
          dealer book is long calls. A vol pop here triggers dealer buying
          (vanna effect) <em>against</em> the gamma-driven trend. Translation:
          counter-trend pop coming. Reduce trend-following exposure or fade
          the next IV spike.
        </li>
      </ul>

      <h2>Reading a VEX heatmap</h2>
      <p>
        VEX visualizes the same way GEX does — strikes on the y-axis,
        expirations on the x-axis, signed magnitude as the cell color.
        The interpretation differs:
      </p>
      <ul>
        <li>
          <strong>Strikes with high positive VEX</strong> are where dealer
          hedging will <em>buy</em> the underlying when IV falls. Treat
          these as latent support during vol-compression environments.
        </li>
        <li>
          <strong>Strikes with high negative VEX</strong> are where dealer
          hedging will <em>sell</em> when IV falls. Latent resistance in
          the same environments.
        </li>
        <li>
          The <strong>VEX flip</strong> (analog to the gamma flip) is the
          strike where cumulative VEX crosses zero. Spot above this strike
          biases vanna flow positive; below, negative.
        </li>
      </ul>
      <p>
        On Cash Moves, switch the <Link to="/markets">HeatPulse</Link> view
        to VEX and overlay it against the GEX view — disagreements between
        them are the highest-information moments in the chain.
      </p>

      <h2>The vanna-charm interaction</h2>
      <p>
        Charm (delta-vs-time decay) and vanna (delta-vs-vol decay) often
        compound into the same direction. A common setup: the day after a
        large macro event (FOMC, CPI). IV crushes (vanna effect produces
        dealer buying), and time decay accelerates on the OTM puts that
        funds bought as protection (charm effect bleeds delta toward zero,
        meaning dealers reduce short-stock hedges). Both flows point
        upward. This is the morning-after rally pattern that's been
        quantitatively documented for two decades.
      </p>
      <p>
        See <Link to="/learn/0dte-pinning-strategy">0DTE pinning strategy</Link>
        for a related discussion of charm decay's role in intraday
        positioning.
      </p>

      <h2>Where the math comes from</h2>
      <p>
        Vanna in Black-Scholes form:{' '}
        <code>vanna = -e^(-q·t) · φ(d1) · d2 / σ</code>, where φ is the
        standard normal PDF, d1 and d2 are the standard BS terms, σ is
        implied volatility, t is time to expiration, q is dividend yield
        (we use 0 for index options at sub-30 DTE — the small drift
        doesn't materially change the dealer hedge math).
      </p>
      <p>
        For per-strike vanna exposure, multiply by open interest and spot²:{' '}
        <code>VEX_strike = OI × vanna × spot²</code>, calls positive, puts
        negative. Aggregate to the chain level for net VEX.
      </p>
      <p>
        Cash Moves computes this in-edge from the live dxFeed greeks feed
        (which delivers IV but not vanna directly). The math is on the
        backend; the matrix renders the same way as GEX.
      </p>

      <h2>Why retail tooling is just catching up</h2>
      <p>
        Three reasons VEX has been institutional-only until recently:
      </p>
      <ol>
        <li>
          <strong>Data cost.</strong> Per-strike IV requires a real options
          chain feed. dxFeed, OPRA direct, and CBOE C2 are the only sources
          that deliver greek-quality data continuously. Retail platforms
          mostly used delayed delta feeds and didn't bother with vanna.
        </li>
        <li>
          <strong>Compute cost.</strong> Black-Scholes second-order Greeks
          across a 500-strike chain at 1-second cadence is non-trivial.
          Cloud-edge runtimes (Supabase, Cloudflare Workers) made it cheap
          enough for small platforms in 2024–25.
        </li>
        <li>
          <strong>UX cost.</strong> Most retail traders don't intuitively
          understand vanna without a primer. The marginal-cost-per-user of
          building the heatmap was low; the marginal-cost-per-user of
          teaching what it means was high.
        </li>
      </ol>

      <h2>Practical takeaways</h2>
      <ul>
        <li>
          Use <strong>GEX</strong> for intraday and pin trades.
        </li>
        <li>
          Use <strong>VEX</strong> for swing trades and overnight holds —
          anything 3+ days out.
        </li>
        <li>
          When GEX and VEX disagree, the disagreement is the signal. Lean
          into it.
        </li>
        <li>
          Watch VEX into vol-compression windows (post-FOMC, post-CPI, post-
          earnings season). Positive VEX = dealer buying as IV crushes.
        </li>
      </ul>
    </LearnLayout>
  )
}
