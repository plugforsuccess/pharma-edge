import { useAuth } from '../context/AuthContext'

// Single source of truth for tier-based gating limits. Components that
// need to know "is this user gated?" call this hook rather than reading
// `profile.subscription_tier` directly — that way when we add tiers,
// limits, or grandfathering rules later, only this file changes.
//
// Limits are deliberately conservative on free; the funnel goal is for
// free to feel useful for ~5 minutes and then naturally hit a wall.

export const FREE_TIER_LIMITS = {
  // /markets ticker pickable count (curated list trimmed to this)
  marketsTickerCap: 3,
  // Tastytrade place-order is gated on free
  brokerExecutionEnabled: false,
  // suggest-plays per-hour cap surfaced in the UI. The edge function
  // enforces its own absolute cap (CLAUDE_RATE_LIMIT_PER_HOUR) on top.
  claudeAnalysesPerHour: 3,
}

export const PRO_TIER_LIMITS = {
  marketsTickerCap: Infinity,
  brokerExecutionEnabled: true,
  claudeAnalysesPerHour: 30,
}

export function useSubscription() {
  const { profile, loading } = useAuth()
  const tier = profile?.subscription_tier ?? 'free'
  const isPro = tier === 'pro'
  const limits = isPro ? PRO_TIER_LIMITS : FREE_TIER_LIMITS
  return { tier, isPro, limits, loading }
}
