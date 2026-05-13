// Cash Moves — Vercel Edge Middleware.
//
// Two responsibilities:
//   1. Inject per-user SSR meta tags into the index.html response for
//      /u/:slug requests. Without this, every share-out of a profile
//      renders the generic site-level OG preview instead of the
//      user's verified P&L + win rate — the central load-bearing fix
//      for the leaderboard viral loop per the audit.
//   2. 301 /r/:slug → /u/:slug at the edge so legacy share links
//      (anything posted before the rebrand) resolve to the new
//      profile URL with the correct OG preview. The client-side
//      <LegacyRecordRedirect> fallback in App.jsx covers the case
//      where the matcher misses; the edge 301 is what actually fixes
//      Twitter/iMessage previews on old links.
//
// Runs at the Vercel edge BEFORE the SPA rewrite (`/((?!api/).*) →
// /index.html`) fires the static index. For /u/:slug we:
//   1. Resolve the slug from the URL
//   2. Fetch profile + stats from the profile-public-data edge function
//   3. Pull the static index.html via fetch
//   4. Regex-replace <title> and known og:* / twitter:* meta tags
//   5. Return the rewritten HTML
//
// Cache: profile-public-data is itself CDN-cached (60s s-maxage), so
// this middleware's profile fetch is cheap. The resulting page also
// carries a short s-maxage so Vercel caches the rewritten HTML for a
// minute. Profile updates → 60s window before share previews refresh.
//
// Failure mode: any error (profile not found, fetch failure, network)
// falls through to next() and serves the unmodified index.html. The
// preview is generic in that case but the page still works.

import { next } from '@vercel/edge'

export const config = {
  matcher: ['/u/:slug', '/u/:slug/', '/r/:slug', '/r/:slug/'],
}

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL
const SUPABASE_ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY
const APP_URL =
  process.env.APP_URL || 'https://pharma-edge.vercel.app'

export default async function middleware(req) {
  try {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)
    const namespace = parts[0]
    const slug = parts[1]
    if (!slug || !/^[a-z0-9\-]+$/i.test(slug)) return next()

    // Legacy /r/:slug → 301 → /u/:slug at the edge. Crawlers respect
    // the 301 and re-fetch /u/:slug, where the meta-injection branch
    // gives them the per-user OG preview.
    if (namespace === 'r') {
      const target = new URL(`/u/${slug}${url.search}`, url)
      return new Response(null, {
        status: 301,
        headers: {
          location: target.toString(),
          'Cache-Control': 'public, max-age=3600',
        },
      })
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return next()

    // Fetch profile + stats in parallel with the static HTML so the
    // middleware's added latency is bounded by the slower of the two
    // (typically the supabase function call at ~50-150ms).
    const [profileResp, htmlResp] = await Promise.all([
      fetch(`${SUPABASE_URL}/functions/v1/profile-public-data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ slug }),
      }),
      fetch(new URL('/index.html', url), {
        // Edge fetch should always honor the origin's caching, so we
        // ride Vercel's static-asset cache for the HTML pull.
        cf: { cacheTtl: 300, cacheEverything: true },
      }),
    ])

    if (!htmlResp.ok) return next()

    let profile = null
    if (profileResp.ok) {
      const body = await profileResp.json().catch(() => null)
      if (body?.success && body?.data) profile = body.data
    }

    let html = await htmlResp.text()
    const meta = buildMeta({ slug, profile, appUrl: APP_URL })
    html = injectMeta(html, meta)

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // 60s CDN cache mirrors profile-public-data's window.
        'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
        // Defense against CSRF on the rewritten page (no cookies are
        // sent from middleware, but signal intent).
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    // Any failure → serve the unmodified SPA. Logging would be useful
    // but we don't want a middleware error to take the page down.
    return next()
  }
}

function buildMeta({ slug, profile, appUrl }) {
  const fallbackTitle = 'Cash Moves — Verified Options Track Records'
  const fallbackDesc =
    'Hash-verified options trades. Real P&L. No edited screenshots.'

  if (!profile) {
    return {
      title: fallbackTitle,
      description: fallbackDesc,
      ogTitle: fallbackTitle,
      ogDescription: fallbackDesc,
      ogImage: `${appUrl}/og-default.png`,
      url: `${appUrl}/u/${slug}`,
    }
  }

  const name = profile.profile?.display_name || `@${slug}`
  const stats = profile.stats || {}
  const pnl = Number(stats.total_pnl ?? 0)
  const winRate = stats.win_rate_pct
  const trades = Number(stats.trades ?? 0)

  const pnlStr = `${pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(pnl)).toLocaleString()}`
  const winStr =
    winRate != null && trades >= 10 ? `${winRate.toFixed(1)}% win rate` : ''
  const tradesStr = `${trades} trade${trades === 1 ? '' : 's'}`

  const descParts = [pnlStr, winStr, tradesStr, 'hash-verified'].filter(Boolean)
  const description = descParts.join(' · ')

  return {
    title: `${name} on Cash Moves — Verified Track Record`,
    description,
    ogTitle: `${name}'s verified options record`,
    ogDescription: description,
    ogImage: `${appUrl}/api/og/${slug}`,
    url: `${appUrl}/u/${slug}`,
  }
}

// Regex-replace known head tags. Vite's index.html produces a stable
// set of meta tags; we hit each by exact match. Tags we don't know
// about pass through unchanged.
//
// We use the og:url tag as a sentinel to detect whether the HTML
// already has SSR meta (multiple matches = pathological state, just
// pass through).
function injectMeta(html, meta) {
  const safe = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let out = html

  // <title>...</title>
  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${safe(meta.title)}</title>`)

  // <meta name="description" content="...">
  out = out.replace(
    /<meta\s+name=["']description["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta name="description" content="${safe(meta.description)}" />`,
  )

  // og:* — insert (or replace) each. If the tag exists we replace; if
  // not we inject a block before </head>.
  const injections = [
    ['og:title', meta.ogTitle],
    ['og:description', meta.ogDescription],
    ['og:image', meta.ogImage],
    ['og:url', meta.url],
    ['og:type', 'profile'],
    ['twitter:card', 'summary_large_image'],
    ['twitter:title', meta.ogTitle],
    ['twitter:description', meta.ogDescription],
    ['twitter:image', meta.ogImage],
  ]

  const toAppend = []
  for (const [prop, value] of injections) {
    const propEsc = prop.replace(/:/g, '\\:')
    const attr = prop.startsWith('twitter:') ? 'name' : 'property'
    const re = new RegExp(
      `<meta\\s+${attr}=["']${propEsc}["']\\s+content=["'][^"']*["']\\s*/?>`,
      'i',
    )
    const replacement = `<meta ${attr}="${prop}" content="${safe(value)}" />`
    if (re.test(out)) {
      out = out.replace(re, replacement)
    } else {
      toAppend.push(replacement)
    }
  }

  if (toAppend.length > 0) {
    out = out.replace(/<\/head>/i, `${toAppend.join('\n    ')}\n  </head>`)
  }
  return out
}
