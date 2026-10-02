import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import SignalDetail from './pages/SignalDetail'
import LogSignal from './pages/LogSignal'
import Layout from './components/Layout'

// Non-critical screens can pay their bytes lazily.
const Settings = lazy(() => import('./pages/Settings'))
const Leaderboard = lazy(() => import('./pages/Leaderboard'))
const Markets = lazy(() => import('./pages/Markets'))
const PositionDetail = lazy(() => import('./pages/PositionDetail'))
const Flow = lazy(() => import('./pages/Flow'))
const Reasoning = lazy(() => import('./pages/Reasoning'))
const LearnIndex = lazy(() => import('./pages/LearnIndex'))
const DealerPositioningGuide = lazy(() => import('./pages/learn/DealerPositioningGuide'))
const GammaFlipTrading = lazy(() => import('./pages/learn/GammaFlipTrading'))
const ZeroDtePinningStrategy = lazy(() => import('./pages/learn/ZeroDtePinningStrategy'))
const VannaExposureExplained = lazy(() => import('./pages/learn/VannaExposureExplained'))
const BestGexTools = lazy(() => import('./pages/learn/BestGexTools'))
const Glossary = lazy(() => import('./pages/learn/Glossary'))
const CashMovesRules = lazy(() => import('./pages/learn/CashMovesRules'))
const Admin = lazy(() => import('./pages/Admin'))
const PlayDetail = lazy(() => import('./pages/PlayDetail'))
const Wheel = lazy(() => import('./pages/Wheel'))
const WheelWatchlist = lazy(() => import('./pages/WheelWatchlist'))
const KingBoard = lazy(() => import('./pages/KingBoard'))
const Leaps = lazy(() => import('./pages/Leaps'))
const LeapsOnboarding = lazy(() => import('./pages/LeapsOnboarding'))

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
  return children
}

// Admin-only route gate. Used for /flow (bot UI demoted to admin-only
// per the leaderboard focus audit 2026-05-12) and /admin. Falls back
// to the Tape for non-admins so the URL-typed visit goes somewhere
// sensible.
function AdminOnly({ children }) {
  const { profile, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!profile?.is_admin) return <Navigate to="/" replace />
  return children
}

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function ProtectedLayout() {
  return <Layout />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/leaderboard"
            element={
              <Suspense fallback={<LoadingScreen />}>
                <Leaderboard />
              </Suspense>
            }
          />
          {/* Public track-record profiles were cut from the MVP (2026-10-02).
              Old share links land on the app instead of a 404. */}
          <Route path="/u/:slug" element={<Navigate to="/" replace />} />
          <Route path="/r/:slug" element={<Navigate to="/" replace />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <ProtectedLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="signal/:id" element={<SignalDetail />} />
            <Route
              path="play/:claude_call_id"
              element={
                <Suspense fallback={<LoadingScreen />}>
                  <PlayDetail />
                </Suspense>
              }
            />
            <Route path="log" element={<LogSignal />} />
            <Route path="record" element={<Navigate to="/leaps" replace />} />
            <Route path="settings" element={<Settings />} />
            <Route path="markets" element={<Markets />} />
            <Route path="markets/king-board" element={<KingBoard />} />
            <Route path="wheel" element={<Wheel />} />
            <Route path="picks" element={<WheelWatchlist />} />
            <Route path="leaps" element={<Leaps />} />
            <Route path="leaps/onboarding" element={<LeapsOnboarding />} />
            <Route path="flow" element={<AdminOnly><Flow /></AdminOnly>} />
            <Route path="reasoning" element={<Reasoning />} />
            <Route path="learn" element={<LearnIndex />} />
            <Route path="learn/dealer-positioning-guide" element={<DealerPositioningGuide />} />
            <Route path="learn/gamma-flip-trading" element={<GammaFlipTrading />} />
            <Route path="learn/0dte-pinning-strategy" element={<ZeroDtePinningStrategy />} />
            <Route path="learn/vanna-exposure-explained" element={<VannaExposureExplained />} />
            <Route path="learn/best-gex-tools" element={<BestGexTools /> } />
            <Route path="learn/glossary" element={<Glossary />} />
            <Route path="learn/cash-moves-rules" element={<CashMovesRules />} />
            {/* Legacy route 301s — preserve cached deep links from
                the pre-focus-audit nav. Pointed at the new /learn/
                homes for content that moved; /calendar and
                /calculator deleted with no replacement. */}
            <Route path="glossary" element={<Navigate to="/learn/glossary" replace />} />
            <Route path="rules" element={<Navigate to="/learn/cash-moves-rules" replace />} />
            <Route path="calendar" element={<Navigate to="/" replace />} />
            <Route path="calculator" element={<Navigate to="/" replace />} />
            <Route path="position/:id" element={<PositionDetail />} />
            <Route path="admin" element={<AdminOnly><Admin /></AdminOnly>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
