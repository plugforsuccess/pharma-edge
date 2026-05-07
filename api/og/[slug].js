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

    // Pull profile + public_record rows in parallel. We don't use
    // the supabase-js client in edge runtime to avoid the bundle
    // hit; raw fetch against PostgREST works fine.
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    }
    const [profileResp, signalsResp] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/profiles?public_slug=eq.${encodeURIComponent(slug)}&is_public=eq.true&select=display_name,public_slug`,
        { headers },
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/public_record?public_slug=eq.${encodeURIComponent(slug)}&select=thesis_correct,trade_type,pnl_percent,entry_pop_bp&limit=500`,
        { headers },
      ),
    ])

    if (!profileResp.ok) return errorImage('Profile not found')
    const profiles = await profileResp.json()
    const profile = profiles?.[0]
    if (!profile) return errorImage('Profile not public')

    const signals = signalsResp.ok ? await signalsResp.json() : []
    const stats = computeStats(signals)
    const displayName = profile.display_name || slug

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

function computeStats(rows) {
  if (!rows || rows.length === 0) {
    return {
      total: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgPredictedPop: null,
      calibrationDelta: null,
      avgPnl: null,
    }
  }
  const resolved = rows.filter(
    (s) => s.thesis_correct !== null && s.thesis_correct !== undefined,
  )
  const wins = resolved.filter((s) => s.thesis_correct).length
  const losses = resolved.length - wins
  const winRate = resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : 0

  const withPop = rows.filter(
    (s) => s.entry_pop_bp != null && Number.isFinite(Number(s.entry_pop_bp)),
  )
  const avgPredictedPop = withPop.length
    ? Math.round(
        withPop.reduce((sum, s) => sum + Number(s.entry_pop_bp), 0) / withPop.length / 100,
      )
    : null
  // Calibration delta: average predicted PoP minus actual win rate.
  // Positive = overconfident; negative = underconfident; near zero
  // = well-calibrated.
  const calibrationDelta =
    avgPredictedPop != null && resolved.length > 0
      ? avgPredictedPop - winRate
      : null

  const withPnl = resolved.filter((s) => s.pnl_percent != null)
  const avgPnl = withPnl.length
    ? Math.round(
        withPnl.reduce((sum, s) => sum + Number(s.pnl_percent), 0) / withPnl.length,
      )
    : null

  return {
    total: rows.length,
    resolved: resolved.length,
    wins,
    losses,
    winRate,
    avgPredictedPop,
    calibrationDelta,
    avgPnl,
  }
}

function cardJsx({ displayName, slug, stats }) {
  const hasResolved = stats.resolved > 0
  const calibrationLabel =
    stats.calibrationDelta == null
      ? '—'
      : stats.calibrationDelta === 0
        ? '0 pts'
        : `${stats.calibrationDelta > 0 ? '+' : ''}${stats.calibrationDelta} pts`
  const calibrationColor =
    stats.calibrationDelta == null
      ? '#6b6b8a'
      : Math.abs(stats.calibrationDelta) <= 5
        ? '#22c55e'
        : Math.abs(stats.calibrationDelta) <= 15
          ? '#eab308'
          : '#ef4444'

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
                  children: `cashmoves.io/r/${slug}`,
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
            children: hasResolved ? 'Public Track Record' : 'New Trader',
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
                label: 'CALIBRATION',
                value: calibrationLabel,
                color: calibrationColor,
                sub: 'predicted vs actual',
              }),
              statCell({
                label: 'WIN RATE',
                value: hasResolved ? `${stats.winRate}%` : '—',
                color: hasResolved && stats.winRate >= 55 ? '#22c55e' : '#e8e8f0',
                sub: hasResolved ? `${stats.wins}W / ${stats.losses}L` : 'no resolved moves',
              }),
              statCell({
                label: 'AVG P/L',
                value: stats.avgPnl != null ? `${stats.avgPnl > 0 ? '+' : ''}${stats.avgPnl}%` : '—',
                color:
                  stats.avgPnl == null
                    ? '#e8e8f0'
                    : stats.avgPnl > 0
                      ? '#22c55e'
                      : '#ef4444',
                sub: 'per closed move',
              }),
              statCell({
                label: 'TOTAL',
                value: String(stats.total),
                color: '#e8e8f0',
                sub: stats.total === 1 ? 'logged move' : 'logged moves',
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
