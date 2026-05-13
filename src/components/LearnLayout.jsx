import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight } from 'lucide-react'

// Shared layout for /learn/* SEO articles.
//
// Sets document.title + meta description on mount so Googlebot sees
// the right tags when it executes JS. The crawler also indexes the
// rendered text in <main>, which is plain semantic HTML — h1/h2/p/ul.
// We're not chasing AMP or full SSR here; the goal is to rank on
// long-tail head-terms ("best gex tools 2026", "vanna exposure
// explained") which competitive analysis shows are reachable with
// well-structured client-rendered content.
//
// Each article passes title, description, slug. Layout adds the
// breadcrumb, prose styling, and the "Try it on Cash Moves" CTA
// that converts educational traffic into product sign-ups.

export default function LearnLayout({
  title,
  description,
  slug,
  publishedAt,
  updatedAt,
  children,
  prevArticle,
  nextArticle,
}) {
  useEffect(() => {
    const prevTitle = document.title
    document.title = `${title} | Cash Moves`
    const meta = document.querySelector('meta[name="description"]') || (() => {
      const m = document.createElement('meta')
      m.setAttribute('name', 'description')
      document.head.appendChild(m)
      return m
    })()
    const prevDesc = meta.getAttribute('content')
    meta.setAttribute('content', description)

    // Canonical link — important for SEO since the SPA can be
    // reached from multiple paths (e.g. with trailing slash, with
    // ?utm params). Set it to the canonical /learn/<slug> form.
    let link = document.querySelector('link[rel="canonical"]')
    const prevHref = link?.getAttribute('href') || null
    if (!link) {
      link = document.createElement('link')
      link.setAttribute('rel', 'canonical')
      document.head.appendChild(link)
    }
    link.setAttribute('href', `https://pharma-edge.vercel.app/learn/${slug}`)

    return () => {
      document.title = prevTitle
      if (prevDesc) meta.setAttribute('content', prevDesc)
      if (prevHref) link.setAttribute('href', prevHref)
    }
  }, [title, description, slug])

  return (
    <article className="px-4 py-6 lg:px-8 lg:py-10 max-w-3xl lg:mx-auto">
      <nav className="text-xs text-muted mb-6">
        <Link to="/learn" className="hover:text-fg inline-flex items-center gap-1">
          <ArrowLeft size={12} /> Learn
        </Link>
      </nav>

      <header className="mb-8 space-y-3">
        <h1 className="text-2xl lg:text-4xl font-semibold leading-tight tracking-tight">{title}</h1>
        <p className="text-sm lg:text-base text-subtle leading-relaxed">{description}</p>
        {(publishedAt || updatedAt) && (
          <p className="text-[10px] uppercase tracking-wider text-muted">
            {publishedAt && <span>Published {publishedAt}</span>}
            {publishedAt && updatedAt && updatedAt !== publishedAt && ' · '}
            {updatedAt && updatedAt !== publishedAt && <span>Updated {updatedAt}</span>}
          </p>
        )}
      </header>

      <div className="prose-cm">
        {children}
      </div>

      {/* Conversion CTA. Every article ends here. */}
      <aside className="mt-12 bg-card border border-border rounded-xl p-5 lg:p-6 space-y-3">
        <h2 className="text-base lg:text-lg font-semibold">Try it on Cash Moves</h2>
        <p className="text-sm text-subtle leading-relaxed">
          See dealer positioning, options flow, and AI-suggested spread
          plays in one terminal — with a hash-anchored, immutable track
          record for every signal you log. Free to start.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/markets"
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-amber-400 text-bg text-sm font-semibold hover:bg-amber-300"
          >
            Open HeatPulse <ArrowRight size={14} />
          </Link>
          <Link
            to="/reasoning"
            className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-border text-fg text-sm font-semibold hover:border-amber-400/40"
          >
            Live reasoning <ArrowRight size={14} />
          </Link>
        </div>
      </aside>

      {/* Prev/next navigation between articles. */}
      {(prevArticle || nextArticle) && (
        <nav className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
          {prevArticle ? (
            <Link
              to={`/learn/${prevArticle.slug}`}
              className="block bg-card border border-border rounded-lg p-3 hover:border-amber-400/40"
            >
              <div className="text-muted uppercase tracking-wider mb-1">← Previous</div>
              <div className="text-fg font-semibold">{prevArticle.title}</div>
            </Link>
          ) : <div />}
          {nextArticle ? (
            <Link
              to={`/learn/${nextArticle.slug}`}
              className="block bg-card border border-border rounded-lg p-3 hover:border-amber-400/40 lg:text-right"
            >
              <div className="text-muted uppercase tracking-wider mb-1">Next →</div>
              <div className="text-fg font-semibold">{nextArticle.title}</div>
            </Link>
          ) : <div />}
        </nav>
      )}
    </article>
  )
}
