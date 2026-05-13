// PublicHeader — minimal top bar for unauth-accessible pages
// (/leaderboard, /u/:slug). Solves two problems:
//
//   1. Safe-area inset. These routes render OUTSIDE <ProtectedRoute>,
//      so the app's <Layout> with its built-in pt-safe doesn't wrap
//      them. Without this header the page content slides under the
//      iOS status bar / dynamic island.
//
//   2. Nav-out. Logged-out users landing on a leaderboard or profile
//      link have no way back to the rest of the app without typing a
//      URL. The right-side CTA is "Open app →" when logged in (just
//      a link to /) and "Sign in" when not.

import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function PublicHeader() {
  const { user } = useAuth()
  return (
    <header className="sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-border pt-safe">
      <div className="mx-auto lg:max-w-5xl w-full px-4 lg:px-6 py-3 flex items-center justify-between">
        <Link
          to="/"
          className="text-base font-display tracking-tight text-white hover:text-zinc-200"
        >
          Cash Moves
        </Link>
        {user ? (
          <Link
            to="/"
            className="text-xs text-zinc-400 hover:text-white transition-colors"
          >
            Open app →
          </Link>
        ) : (
          <Link
            to="/login"
            className="text-xs bg-red-600 hover:bg-red-500 text-white font-medium px-3 py-1.5 rounded-lg transition-colors"
          >
            Sign in
          </Link>
        )}
      </div>
    </header>
  )
}
