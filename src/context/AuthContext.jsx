import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext({})

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return
      handleSession(session)
      setLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return
      handleSession(session)
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleSession(session) {
    const nextUser = session?.user ?? null
    setUser(nextUser)
    if (nextUser) {
      void fetchProfile(nextUser.id)
    } else {
      setProfile(null)
      setProfileLoaded(true)
    }
  }

  async function fetchProfile(userId) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
    if (error) {
      console.error('[auth] fetchProfile failed:', error.message, error)
    } else if (!data) {
      console.warn('[auth] fetchProfile returned no row for user', userId)
    }
    setProfile(data ?? null)
    setProfileLoaded(true)
  }

  async function signIn(email, password) {
    return supabase.auth.signInWithPassword({ email, password })
  }

  async function signUp(email, password) {
    return supabase.auth.signUp({ email, password })
  }

  async function signOut() {
    return supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider
      value={{ user, profile, profileLoaded, loading, signIn, signUp, signOut, fetchProfile }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
