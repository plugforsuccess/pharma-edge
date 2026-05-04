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
      <Shell>
        <div className="max-w-sm text-center space-y-4">
          <BrandMark />
          <h1 className="font-display text-3xl text-fg">Check your email</h1>
          <p className="text-subtle text-sm leading-relaxed">
            We sent a confirmation link to{' '}
            <span className="text-fg font-medium">{email}</span>. Click it to
            finish creating your account, then sign in.
          </p>
          <button
            onClick={() => {
              setPendingConfirm(false)
              setMode('signin')
              setPassword('')
            }}
            className="text-sm font-medium tracking-wide hover:text-fg transition-colors"
            style={{ color: '#e8b558' }}
          >
            ← Back to sign in
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="w-full max-w-sm">
        {/* Hero */}
        <div className="mb-10 text-center">
          <BrandMark />
          <p className="eyebrow mt-5">Biotech Catalyst Intelligence</p>
          <h1 className="font-display text-[2.5rem] leading-[1.05] mt-2">
            <span className="brand-text">Pharma</span>{' '}
            <span className="text-fg italic">Edge</span>
          </h1>
          <p className="text-subtle text-sm mt-3 leading-relaxed max-w-xs mx-auto">
            Read the public record better than the market.
            Trade with a tamper-proof thesis.
          </p>
        </div>

        <div className="hairline mb-8" />

        <form onSubmit={handleSubmit} className="space-y-3">
          <Field
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@firm.com"
          />
          <Field
            label="Password"
            type="password"
            name="password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />

          {error && (
            <div
              className="text-sm rounded-lg px-3 py-2 border"
              style={{
                color: '#f25068',
                background: 'rgba(224,52,76,0.08)',
                borderColor: 'rgba(224,52,76,0.25)',
              }}
              role="alert"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full font-semibold rounded-xl py-3.5 text-sm tracking-wide mt-2"
          >
            {loading
              ? 'Working…'
              : mode === 'signin'
                ? 'Sign In'
                : 'Create Account'}
          </button>

          <button
            type="button"
            onClick={() => {
              setError('')
              setMode(mode === 'signin' ? 'signup' : 'signin')
            }}
            className="w-full text-subtle text-xs tracking-wide hover:text-fg transition-colors pt-2"
          >
            {mode === 'signin'
              ? 'No account yet? Create one →'
              : 'Already a member? Sign in →'}
          </button>
        </form>

        <p className="eyebrow text-center mt-10 opacity-60">
          SHA-256 anchored · CFTC-compliant · v1
        </p>
      </div>
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 relative overflow-hidden">
      {/* Soft brand aura */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[520px] h-[520px] rounded-full opacity-50 blur-3xl"
        style={{
          background:
            'radial-gradient(closest-side, rgba(232,181,88,0.18), transparent)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 left-1/2 -translate-x-1/2 w-[520px] h-[520px] rounded-full opacity-40 blur-3xl"
        style={{
          background:
            'radial-gradient(closest-side, rgba(224,52,76,0.14), transparent)',
        }}
      />
      {children}
    </div>
  )
}

function BrandMark() {
  return (
    <div className="relative inline-flex items-center justify-center">
      <div className="brand-mark w-14 h-14 rounded-2xl flex items-center justify-center">
        <span
          className="font-display text-2xl font-semibold"
          style={{ color: '#1a1208' }}
        >
          PE
        </span>
      </div>
      <span
        aria-hidden
        className="absolute inset-0 rounded-2xl ring-1 ring-white/10"
      />
    </div>
  )
}

function Field({ label, ...rest }) {
  return (
    <label className="block">
      <span className="eyebrow block mb-1.5">{label}</span>
      <input
        {...rest}
        className="input-premium w-full rounded-xl px-4 py-3 text-sm font-medium"
      />
    </label>
  )
}
