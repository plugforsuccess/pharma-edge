// Manifest of every published /learn/* article. Powers the index
// page (/learn) and the prev/next nav inside each article.
//
// Order is the recommended reading sequence — foundational concepts
// first (what dealer positioning is, why it matters), then the
// flagship metrics (gamma flip, pinning), then the cross-cutting
// comparison piece. This is also the order Google sees when it
// crawls the index page, so internal-link weight flows toward the
// foundational articles.

export const LEARN_ARTICLES = [
  {
    slug: 'dealer-positioning-guide',
    title: 'Dealer Positioning Guide: Why Market Makers Hedge and What That Means for Price',
    description: 'How options market makers manage risk, why their hedging flow drives short-term price action, and how to read positioning data without a Bloomberg terminal.',
    summary: 'The mechanics of dealer hedging — the single biggest invisible force in short-dated options markets. If you trade 0DTE or weekly options without understanding this, you are trading blind.',
    headTerms: ['dealer positioning', 'market maker hedging', 'options dealer flow'],
    minutes: 8,
  },
  {
    slug: 'gamma-flip-trading',
    title: 'The Gamma Flip: Trading the Zero-Gamma Level',
    description: 'The single most important level in GEX-based trading. What it is, why it acts as a regime change, and how to size and structure trades on either side.',
    summary: 'The zero-gamma level (the flip) is the line between vol-suppressed and vol-amplified regimes. Crossing it is rarely random — and rarely without follow-through.',
    headTerms: ['gamma flip', 'zero gamma level', 'gamma flip trading'],
    minutes: 7,
  },
  {
    slug: '0dte-pinning-strategy',
    title: '0DTE Pinning Strategy: How Dealer Hedging Causes Price to Settle',
    description: 'Why same-day options expirations gravitate toward high-OI strikes, how to identify high-probability pin setups, and the spread structures that monetize them.',
    summary: 'Pinning is not magic. It is a mechanical consequence of dealer hedging combined with charm decay. Once you can identify the conditions, the trade structures itself.',
    headTerms: ['0dte pinning', '0dte strategy', 'options pinning'],
    minutes: 9,
  },
  {
    slug: 'vanna-exposure-explained',
    title: 'Vanna Exposure (VEX) Explained: How Volatility Drift Drives Multi-Day Moves',
    description: 'The hidden second-order Greek. Why dealers buy stocks when IV falls and sell when IV rises, and how vanna exposure (VEX) shows you the multi-day directional bias before it shows up in price.',
    summary: 'Most retail traders track gamma. The institutional edge has shifted to vanna. Here is what VEX is, why it matters more on multi-day timeframes than GEX, and how to read a VEX heatmap.',
    headTerms: ['vanna exposure', 'vex options', 'vanna trading'],
    minutes: 8,
  },
  {
    slug: 'best-gex-tools',
    title: 'Best GEX Tools for Options Traders in 2026',
    description: 'Honest comparison of gamma-exposure platforms — Cash Moves, Skylit, SpotGamma, VannaCharm — across price, ticker coverage, execution integration, and track record verification.',
    summary: 'Five tools dominate the GEX space in 2026. Each is right for a different trader. Here is the honest matrix — what each does well, where it falls short, and which one fits your setup.',
    headTerms: ['best gex tools', 'gamma exposure tools', 'gex platform comparison'],
    minutes: 10,
  },
]

export function getArticleBySlug(slug) {
  return LEARN_ARTICLES.find((a) => a.slug === slug) || null
}

export function getNeighbors(slug) {
  const idx = LEARN_ARTICLES.findIndex((a) => a.slug === slug)
  if (idx < 0) return { prev: null, next: null }
  return {
    prev: idx > 0 ? LEARN_ARTICLES[idx - 1] : null,
    next: idx < LEARN_ARTICLES.length - 1 ? LEARN_ARTICLES[idx + 1] : null,
  }
}
