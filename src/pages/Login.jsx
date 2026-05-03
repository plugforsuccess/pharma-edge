import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('signin')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState(false)
  const { signIn, signUp } = useAuth()
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      if (mode === 'signin') {
        const { error } = await signIn(email, password)
        if (error) setError(error.message)
        else navigate('/', { replace: true })
      } else {
        const { data, error } = await signUp(email, password)
        if (error) {
          setError(error.message)
        } else if (!data.session) {
          // Email confirmation required; user must verify before they can sign in.
          setPendingConfirm(true)
        } else {
          navigate('/', { replace: true })
        }
      }
    } catch {
      setError('Something went wrong. Try again.')
    }
    setLoading(false)
  }

  if (pendingConfirm) {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-3">
          <h1 className="text-white text-xl font-bold">Check your email</h1>
          <p className="text-subtle text-sm">
            We sent a confirmation link to <span className="text-white">{email}</span>. Click it to
            finish creating your account, then sign in.
          </p>
          <button
            onClick={() => {
              setPendingConfirm(false)
              setMode('signin')
              setPassword('')
            }}
            className="text-red-400 text-sm hover:text-red-300"
          >
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-6">
      <div className="mb-12 text-center">
        <div className="w-12 h-12 bg-red-500 rounded-xl flex items-center justify-center mx-auto mb-4">
          <span className="text-white font-bold text-xl">PE</span>
        </div>
        <h1 className="text-white text-2xl font-bold tracking-tight">Pharma Edge</h1>
        <p className="text-subtle text-sm mt-1">Biotech catalyst intelligence</p>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-card border border-border text-white
                     placeholder-zinc-600 rounded-xl px-4 py-3 text-sm
                     focus:outline-none focus:border-red-500 transition-colors"
        />
        <input
          type="password"
          name="password"
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          required
          minLength={6}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-card border border-border text-white
                     placeholder-zinc-600 rounded-xl px-4 py-3 text-sm
                     focus:outline-none focus:border-red-500 transition-colors"
        />

        {error && (
          <p className="text-red-400 text-sm" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-red-600 hover:bg-red-500 disabled:bg-red-900
                     text-white font-semibold rounded-xl py-3 text-sm transition-colors"
        >
          {loading ? 'Loading…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
        </button>

        <button
          type="button"
          onClick={() => {
            setError('')
            setMode(mode === 'signin' ? 'signup' : 'signin')
          }}
          className="w-full text-subtle text-sm hover:text-zinc-300 transition-colors"
        >
          {mode === 'signin'
            ? "Don't have an account? Sign up"
            : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  )
}
