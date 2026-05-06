import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { useDteMonitor } from './hooks/useDteMonitor'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import SignalDetail from './pages/SignalDetail'
import LogSignal from './pages/LogSignal'
import Calendar from './pages/Calendar'
import Layout from './components/Layout'

// Non-critical screens can pay their bytes lazily.
const TrackRecord = lazy(() => import('./pages/TrackRecord'))
const Rules = lazy(() => import('./pages/Rules'))
const Settings = lazy(() => import('./pages/Settings'))
const ScannerCandidates = lazy(() => import('./pages/ScannerCandidates'))
const OptionCalculator = lazy(() => import('./pages/OptionCalculator'))
const PublicRecord = lazy(() => import('./pages/PublicRecord'))
const Markets = lazy(() => import('./pages/Markets'))
const Glossary = lazy(() => import('./pages/Glossary'))
const PositionDetail = lazy(() => import('./pages/PositionDetail'))

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
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
  // Daily DTE check fires once per day per session for active real-money
  // signals. See src/hooks/useDteMonitor.js — the auto -50% stop-loss
  // trigger remains gated on a live option price feed.
  useDteMonitor()
  return <Layout />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/r/:slug"
            element={
              <Suspense fallback={<LoadingScreen />}>
                <PublicRecord />
              </Suspense>
            }
          />
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
            <Route path="log" element={<LogSignal />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="record" element={<TrackRecord />} />
            <Route path="rules" element={<Rules />} />
            <Route path="settings" element={<Settings />} />
            <Route path="scanner" element={<ScannerCandidates />} />
            <Route path="calculator" element={<OptionCalculator />} />
            <Route path="markets" element={<Markets />} />
            <Route path="glossary" element={<Glossary />} />
            <Route path="position/:id" element={<PositionDetail />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
