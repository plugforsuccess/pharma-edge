import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, BookOpen, Clock } from 'lucide-react'
import { LEARN_ARTICLES } from '../lib/learnArticles'

// /learn — index page listing every published article.
//
// Lives under the same protected layout as the rest of the app — we
// could expose it unauthenticated to maximize SEO crawl reach, but
// for now it sits inside ProtectedRoute. If organic traffic warrants,
// move /learn outside the auth gate (App.jsx) so Googlebot doesn't
// have to render the login redirect.

export default function LearnIndex() {
  useEffect(() => {
    const prev = document.title
    document.title = 'Learn options dealer positioning & GEX | Cash Moves'
    return () => { document.title = prev }
  }, [])

  return (
    <div className="px-4 py-6 lg:px-8 lg:py-10 max-w-3xl lg:mx-auto space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-amber-400">
          <BookOpen size={18} />
          <span className="text-xs uppercase tracking-wider font-semibold">Learn</span>
        </div>
        <h1 className="text-2xl lg:text-4xl font-semibold leading-tight tracking-tight">
          Options dealer positioning, gamma exposure, and the institutional edge.
        </h1>
        <p className="text-sm lg:text-base text-subtle leading-relaxed">
          Free explainers covering the mechanics, the metrics, and the
          strategies. Written by working traders, not affiliate sites.
        </p>
      </header>

      <ul className="space-y-3">
        {LEARN_ARTICLES.map((a, i) => (
          <li key={a.slug}>
            <Link
              to={`/learn/${a.slug}`}
              className="block bg-card border border-border rounded-xl p-4 lg:p-5 hover:border-amber-400/40 transition group"
            >
              <div className="flex items-start gap-3">
                <span className="text-muted text-xs font-mono-tab tabular-nums shrink-0 mt-1">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="flex-1 space-y-2">
                  <h2 className="text-base lg:text-lg font-semibold text-fg group-hover:text-amber-400 leading-snug">
                    {a.title}
                  </h2>
                  <p className="text-sm text-subtle leading-relaxed">{a.summary}</p>
                  <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={10} /> {a.minutes} min read
                    </span>
                    <span className="inline-flex items-center gap-1 text-amber-400">
                      Read <ArrowRight size={10} />
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <div className="bg-card border border-border rounded-xl p-5 text-sm text-subtle leading-relaxed">
        <p>
          More coming. If there's a topic you want covered — flow vs.
          GEX divergence, charm-driven afternoon drift, regime
          classification with futures breadth — open the contact link
          in <Link to="/settings" className="text-amber-400 underline">Settings</Link>.
        </p>
      </div>
    </div>
  )
}
