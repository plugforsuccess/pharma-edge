import { Link } from 'react-router-dom'
import LearnLayout from '../../components/LearnLayout'
import { getArticleBySlug, getNeighbors } from '../../lib/learnArticles'

const SLUG = 'best-gex-tools'

export default function BestGexTools() {
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
        Five platforms dominate the gamma-exposure space in 2026. None is
        the right answer for everyone — pricing, ticker coverage, execution
        integration, and verification approach all vary. This is the honest
        comparison: what each does well, where each falls short, and which
        fits which trader.
      </p>
      <p>
        Disclosure: Cash Moves is one of the platforms. We make no attempt
        to hide that. Where the comparison favors a competitor on a specific
        axis, it says so directly.
      </p>

      <h2>The contenders</h2>
      <ul>
        <li><strong>Cash Moves</strong> — cashmoves.io, $39/mo Pro, broker integration + immutable record</li>
        <li><strong>Skylit (Heatseeker)</strong> — skylit.ai, $99–699/mo via Whop, broadest ticker coverage</li>
        <li><strong>SpotGamma</strong> — spotgamma.com, ~$59–99/mo, the OG of retail GEX</li>
        <li><strong>VannaCharm</strong> — vannacharm.com, free + ~$29/mo paid, single-developer focused on Vanna/Charm/GEX trio</li>
        <li><strong>Tradytics / GammaSwap</strong> — institutional-feel sites with retail-friendly tiers, $40–150/mo</li>
      </ul>

      <h2>The matrix</h2>
      <table>
        <thead>
          <tr>
            <th>Capability</th>
            <th>Cash Moves</th>
            <th>Skylit Pro</th>
            <th>SpotGamma</th>
            <th>VannaCharm</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Live GEX heatmap</td>
            <td>✓ (15 tickers)</td>
            <td>✓ (300+)</td>
            <td>✓ (indexes only)</td>
            <td>✓ (~50)</td>
          </tr>
          <tr>
            <td>Vanna / VEX</td>
            <td>✓</td>
            <td>✓</td>
            <td>✗</td>
            <td>✓ (flagship)</td>
          </tr>
          <tr>
            <td>Charm / CEX</td>
            <td>✓</td>
            <td>partial</td>
            <td>✗</td>
            <td>✓</td>
          </tr>
          <tr>
            <td>Velocity (∆GEX over time)</td>
            <td>✓</td>
            <td>✓</td>
            <td>✗</td>
            <td>✗</td>
          </tr>
          <tr>
            <td>AI-suggested spread plays</td>
            <td>✓ (R/R + EV gated)</td>
            <td>announced 2026</td>
            <td>✗</td>
            <td>✗</td>
          </tr>
          <tr>
            <td>Broker execution</td>
            <td>✓ (Tastytrade)</td>
            <td>✗</td>
            <td>✗</td>
            <td>✗</td>
          </tr>
          <tr>
            <td>Immutable, hash-anchored track record</td>
            <td>✓</td>
            <td>✗</td>
            <td>✗</td>
            <td>✗</td>
          </tr>
          <tr>
            <td>Pricing (entry tier)</td>
            <td>$39/mo</td>
            <td>$99/mo Discord-only</td>
            <td>$59/mo</td>
            <td>Free</td>
          </tr>
          <tr>
            <td>Pricing (full feature tier)</td>
            <td>$39/mo</td>
            <td>$699/mo</td>
            <td>$99/mo</td>
            <td>$29/mo</td>
          </tr>
        </tbody>
      </table>

      <h2>Who each one is right for</h2>

      <h3>Cash Moves — for traders who actually trade</h3>
      <p>
        The differentiator is the workflow. Most GEX platforms stop at
        showing you walls and a flip; Cash Moves goes the rest of the way.
        AI-suggested plays are R/R-and-EV gated, you can submit the
        resulting debit spreads to Tastytrade in one click, and every
        trade you log gets a SHA-256 hash anchored to a public GitHub
        commit so the track record is cryptographically verifiable.
      </p>
      <p>
        Coverage is the constraint: the live dxFeed worker streams ~15
        tickers (SPY/QQQ/IWM, the magnificent seven, plus a small pharma
        roster). For trading the indices and major single names, that's
        enough. For sector ETFs or small caps, it isn't yet.
      </p>
      <p>
        Best for: serious 0DTE / weekly traders, options traders who want
        execution + analytics in one place, traders who care about a
        public, verifiable record.
      </p>

      <h3>Skylit Heatseeker — for the dedicated single-name trader</h3>
      <p>
        Skylit's superpower is breadth. 300+ tickers, real-time heatmaps,
        a refined proprietary lexicon (Pika nodes, Barney nodes,
        Gatekeepers, Air Pockets) that's genuinely useful once you learn
        it. The 1:1 Success Sessions and white-glove onboarding included
        in the $699/mo Pro tier are the most service-heavy in the space.
      </p>
      <p>
        Real downsides: no execution integration, no immutable track
        record (verification is via Discord screenshots), and the
        much-marketed AgentHub AI feature was originally pitched for
        April 2026 launch and has slipped. Discord-first community
        creates a friction tax that bigger accounts can absorb but
        smaller accounts can't.
      </p>
      <p>
        Best for: full-time traders with $25k+ accounts trading a wide
        single-name universe, traders who want the highest-touch service
        and don't mind paying for it.
      </p>

      <h3>SpotGamma — the legacy choice</h3>
      <p>
        SpotGamma was the first retail GEX product and still produces the
        clearest written analysis in the space — daily index reports
        that explain not just where the walls are but how to think
        about them. The data product itself is index-focused (SPX, SPY,
        QQQ, NDX) without single-name coverage.
      </p>
      <p>
        Real downsides: no vanna or charm coverage, no AI/agentic
        layer, charts feel dated next to Skylit and Cash Moves. The
        analyst commentary is the value, not the dashboard.
      </p>
      <p>
        Best for: SPX-only traders who want one source for daily levels
        + a written brief.
      </p>

      <h3>VannaCharm — the indie second-Greek specialist</h3>
      <p>
        Built by one developer (Chris Frewin) with a singular focus on
        the Vanna/Charm/GEX trio. Free tier is generous; paid tier
        adds expanded ticker coverage and a couple of advanced views.
        Charts are utilitarian but the math is correct, and the
        accompanying blog content is some of the best technical writing
        in the GEX space.
      </p>
      <p>
        Real downsides: no AI layer, no execution, no community. The
        product is a calculator-with-charts. Reliability depends on a
        single developer.
      </p>
      <p>
        Best for: retail traders who want to learn the math, run their
        own analysis, and don't need workflow integration.
      </p>

      <h3>Tradytics / GammaSwap / others</h3>
      <p>
        Both produce capable dashboards with broad coverage and a
        slightly more institutional feel. Tradytics emphasizes flow +
        unusual options activity heavier than GEX; GammaSwap targets
        the dealer-positioning niche directly. Either can be a fit,
        but neither does anything that the four above don't do better
        in their own lane.
      </p>

      <h2>The quick decision tree</h2>
      <ul>
        <li>
          <strong>Want execution + analytics + immutable record in one app at $39/mo?</strong>{' '}
          → <Link to="/markets">Cash Moves</Link>.
        </li>
        <li>
          <strong>Trading 50+ single names actively, want highest-touch
          service, comfortable with $699/mo?</strong> → Skylit Pro.
        </li>
        <li>
          <strong>SPX-only, want daily written analyst brief?</strong>{' '}
          → SpotGamma.
        </li>
        <li>
          <strong>Learning the math, $0–29/mo budget?</strong>{' '}
          → VannaCharm.
        </li>
      </ul>

      <h2>What to test before you commit</h2>
      <p>
        Three honest tests for any GEX platform:
      </p>
      <ol>
        <li>
          <strong>How fast is the wall after a print?</strong> Place a
          fake order ticket on a high-volume strike on your broker and
          watch how long it takes for the platform's wall to update. The
          best platforms reflect new OI within seconds; the worst still
          show yesterday's close at 11am.
        </li>
        <li>
          <strong>Does the regime classifier handle transitions?</strong>{' '}
          Pull up a chart of the last flip-cross day. Did the platform
          flag the regime change in real time, or only in hindsight?
        </li>
        <li>
          <strong>Can you find the math?</strong> If the platform won't
          tell you exactly how it computes GEX (gamma source, OI source,
          dealer convention), be skeptical. The good ones publish it.
        </li>
      </ol>

      <h2>What's coming in the rest of 2026</h2>
      <p>
        Three trends to watch:
      </p>
      <ul>
        <li>
          <strong>VEX as a primary view.</strong> Up to 2025, GEX was the
          primary metric and VEX/CEX were optional. Cash Moves and
          VannaCharm have promoted VEX to a co-primary surface; expect
          others to follow.
        </li>
        <li>
          <strong>Embedded execution.</strong> Cash Moves is the only
          platform integrating broker execution today, but Tradytics and
          Skylit have both signaled it's coming. Once it ships across
          the space, the value prop separates around <em>workflow
          quality</em>, not analytics quality.
        </li>
        <li>
          <strong>Agent-driven analysis.</strong> Skylit's AgentHub
          announcement, Cash Moves' shipped <Link to="/reasoning">Reasoning</Link>
          surface, and announcements from at least two other platforms
          all point at the same destination: an inference engine that
          continuously re-evaluates positioning and surfaces high-
          conviction setups in plain English. The early implementations
          will be uneven; the ones that stick will be deterministic-
          first, LLM-second, and gated on R/R + EV math.
        </li>
      </ul>
      <p>
        If you're picking a platform now and expect to keep it for the
        rest of 2026, weight your decision toward what each one is
        already shipping, not what's announced. The slip rate on
        announced features in this space is high.
      </p>
    </LearnLayout>
  )
}
