import { ImageResponse } from '@vercel/og'

// Server-side OG image generation for /r/:slug Public Record pages.
//
// Returns a 1200×630 PNG (Twitter / Discord / iMessage / Slack
// share-card standard size) showing the user's track record as a
// scannable hero. Cached aggressively at the CDN edge so re-shares
// don't slam Supabase.
//
// Auth model: this endpoint reads only data already exposed on the
// public PublicRecord view (security_invoker=true with anon-safe
// columns), so we use the anon key and skip JWT — the data shown
// is the same data anyone can already see by visiting /r/:slug
// directly.
//
// Why a serverless function and not a static asset: stats change
// every time a signal is logged or an outcome resolves. A static
// PNG would go stale within hours. The 5-min CDN cache below is
// the right freshness/cost tradeoff for a share preview.

export const config = {
  runtime: 'edge',
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

export default async function handler(req) {
  try {
    const url = new URL(req.url)
    // Vercel routes /api/og/[slug] → query.slug; if a deploy switches
    // to a flat /api/og.js, we also accept ?slug=xxx as a fallback.
    const slug =
      url.pathname.split('/').filter(Boolean).pop() ||
      url.searchParams.get('slug') ||
      ''
    if (!slug || !/^[a-z0-9\-]+$/i.test(slug)) {
      return errorImage('Invalid slug')
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return errorImage('Service misconfigured')
    }

    // Single round-trip to profile-public-data — same source the
    // /u/:slug page and middleware.js use, so the OG preview agrees
    // with the page it links to.
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/profile-public-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ slug }),
    })
    if (!resp.ok) return errorImage('Profile not found')
    const body = await resp.json()
    if (!body?.success || !body?.data) return errorImage('Profile not found')

    const profile = body.data.profile
    const apiStats = body.data.stats
    const displayName = profile.display_name || slug
    const stats = {
      total: apiStats.trades,
      wins: apiStats.wins,
      losses: apiStats.losses,
      winRate: apiStats.win_rate_pct != null ? Math.round(apiStats.win_rate_pct) : 0,
      totalPnl: Number(apiStats.total_pnl || 0),
      biggestWin: Number(apiStats.biggest_win || 0),
      hasTrades: apiStats.trades > 0,
    }

    return new ImageResponse(
      cardJsx({ displayName, slug, stats }),
      {
        width: 1200,
        height: 630,
        headers: {
          // 5-min CDN cache + 1-hour SWR — share previews stay fresh
          // without slamming Supabase on every retweet.
          'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
        },
      },
    )
  } catch (e) {
    return errorImage(e?.message || 'render failed')
  }
}

// computeStats removed 2026-05-12 — data now comes pre-aggregated
// from the profile-public-data edge function; see handler() above.

function cardJsx({ displayName, slug, stats }) {
  const pnlSigned = `${stats.totalPnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(stats.totalPnl)).toLocaleString()}`
  const pnlColor =
    !stats.hasTrades ? '#6b6b8a' : stats.totalPnl >= 0 ? '#22c55e' : '#ef4444'

  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0a0a0f',
        backgroundImage:
          'radial-gradient(circle at 80% 0%, rgba(251,191,36,0.08), transparent 40%), radial-gradient(circle at 0% 100%, rgba(124,58,237,0.06), transparent 50%)',
        padding: '64px 80px',
        fontFamily: 'sans-serif',
      },
      children: [
        // Header: brand mark + slug
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '12px',
                  },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '32px',
                          fontWeight: 700,
                          color: '#fbbf24',
                          letterSpacing: '-0.02em',
                        },
                        children: 'Cash',
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: '32px',
                          fontWeight: 300,
                          color: '#e8e8f0',
                          letterSpacing: '-0.02em',
                        },
                        children: 'Moves',
                      },
                    },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '18px',
                    color: '#6b6b8a',
                    fontFamily: 'monospace',
                  },
                  children: `pharma-edge.vercel.app/u/${slug}`,
                },
              },
            ],
          },
        },
        // Display name
        {
          type: 'div',
          props: {
            style: {
              marginTop: '64px',
              fontSize: '64px',
              fontWeight: 700,
              color: '#e8e8f0',
              letterSpacing: '-0.03em',
              lineHeight: 1.05,
            },
            children: displayName,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              marginTop: '8px',
              fontSize: '20px',
              color: '#6b6b8a',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
            },
            children: stats.hasTrades ? 'Verified Track Record' : 'New Trader',
          },
        },
        // Stats row
        {
          type: 'div',
          props: {
            style: {
              marginTop: 'auto',
              display: 'flex',
              gap: '32px',
              alignItems: 'flex-end',
            },
            children: [
              statCell({
                label: 'VERIFIED P&L',
                value: stats.hasTrades ? pnlSigned : '—',
                color: pnlColor,
                sub: 'hash-locked',
              }),
              statCell({
                label: 'WIN RATE',
                value: stats.hasTrades && stats.total >= 10 ? `${stats.winRate}%` : '—',
                color: stats.hasTrades && stats.winRate >= 55 ? '#22c55e' : '#e8e8f0',
                sub: stats.hasTrades ? `${stats.wins}W / ${stats.losses}L` : 'no trades yet',
              }),
              statCell({
                label: 'BIGGEST WIN',
                value: stats.biggestWin > 0
                  ? `$${Math.round(stats.biggestWin).toLocaleString()}`
                  : '—',
                color: stats.biggestWin > 0 ? '#22c55e' : '#e8e8f0',
                sub: 'best single trade',
              }),
              statCell({
                label: 'TRADES',
                value: String(stats.total),
                color: '#e8e8f0',
                sub: stats.total === 1 ? 'closed' : 'closed',
              }),
            ],
          },
        },
      ],
    },
  }
}

function statCell({ label, value, color, sub }) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              fontSize: '13px',
              color: '#6b6b8a',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              marginBottom: '8px',
            },
            children: label,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: '64px',
              fontWeight: 700,
              color,
              letterSpacing: '-0.02em',
              lineHeight: 1,
              fontFamily: 'monospace',
            },
            children: value,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              fontSize: '14px',
              color: '#6b6b8a',
              marginTop: '6px',
            },
            children: sub,
          },
        },
      ],
    },
  }
}

function errorImage(msg) {
  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0a0a0f',
          color: '#6b6b8a',
          fontSize: '40px',
          fontFamily: 'sans-serif',
        },
        children: msg,
      },
    },
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, max-age=60',
      },
    },
  )
}
