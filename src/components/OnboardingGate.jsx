import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Sends a signed-in user who hasn't finished the LEAPS questionnaire
// (risk answers in ldp_risk_profiles + tax details in
// leaps_tax_profiles) to /leaps/onboarding once per sign-in. "Skip for
// now" there lets them in; the next sign-in prompts again until both
// rows exist.
//
// Keyed on user.last_sign_in_at, which Supabase bumps on every sign-in
// but not on token refresh — so reloads don't re-prompt.

export const ONBOARDING_PATH = '/leaps/onboarding'

export function promptKey(user) {
  return user?.id ? `cm:onboarding-prompted:${user.id}:${user.last_sign_in_at ?? ''}` : null
}

function alreadyPrompted(key) {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}

export function markPrompted(user) {
  const key = promptKey(user)
  try { if (key) localStorage.setItem(key, '1') } catch { /* storage blocked — prompt again next load */ }
}

export default function OnboardingGate() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { pathname, search } = useLocation()

  useEffect(() => {
    const key = promptKey(user)
    if (!key || alreadyPrompted(key) || pathname.startsWith(ONBOARDING_PATH)) return
    let cancelled = false
    ;(async () => {
      const [risk, tax] = await Promise.all([
        supabase.from('ldp_risk_profiles').select('user_id').eq('user_id', user.id).maybeSingle(),
        supabase.from('leaps_tax_profiles').select('user_id').eq('user_id', user.id).maybeSingle(),
      ])
      if (cancelled) return
      // A failed lookup isn't a reason to block the app.
      if (risk.error || tax.error) return
      if (risk.data && tax.data) { markPrompted(user); return }
      const next = encodeURIComponent(pathname + search)
      navigate(`${ONBOARDING_PATH}?prompt=1&next=${next}`, { replace: true })
    })()
    return () => { cancelled = true }
    // Only re-check when the signed-in session changes, not on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.last_sign_in_at])

  return null
}
