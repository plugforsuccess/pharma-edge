import { Suspense } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  Activity,
  Bot,
  Calculator,
  ChartLine,
  Flame,
  Home,
  Plus,
  Receipt,
  Settings,
  Shield,
  Wallet,
  Waves,
} from 'lucide-react'
import InstallPrompt from './InstallPrompt'
import OnboardingGate from './OnboardingGate'
import Spinner from './Spinner'
import { useAuth } from '../context/AuthContext'
import clsx from 'clsx'
import { FEATURES } from '../lib/features'

// Bottom nav (mobile) + sidebar nav (desktop). LEAPS-first structure
// (owner, 2026-10-03, see CLAUDE.md "Product tiers & page plan"):
//   /           → "Home"       (LEAPS dashboard)
//   /leaps      → "Portfolio"  (after-tax value + Exit Targets)
//   /charts     → "Charts"     (holdings over time, after tax)
//   /markets    → "Pulse"      (HeatPulse™ + King Board — Elite)
//   /taxes      → "Taxes"      (tax if sold, long-term timing, losses)
//   /settings   → "Settings"   (desktop rail; mobile via the Home header)
//
// Mobile: five equal tabs — Charts sits in the middle as a normal tab,
// not a raised button. The Simulator and the LEAPS bot (/bot) are reached
// from Home and the desktop rail.
//
// Hidden indefinitely (src/lib/features.js): Wheel, Picks, Log a Move,
// signal / play detail, Flow, Leaderboard.
const navTabs = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/leaps', icon: Wallet, label: 'Portfolio' },
  { to: '/charts', icon: ChartLine, label: 'Charts' },
  { to: '/markets', icon: Activity, label: 'Pulse' },
  { to: '/taxes', icon: Receipt, label: 'Taxes' },
]
// Desktop sidebar — the tabs plus the tools.
const navFull = [
  ...navTabs,
  { to: '/bot', icon: Bot, label: 'LEAPS bot' },
  { to: '/orderflow', icon: Waves, label: 'NIGHTFLOW' },
  { to: '/simulator', icon: Calculator, label: 'Simulator' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  // Owner-only Admin link (profiles.is_admin). Mobile admins reach
  // /admin by URL — it's a low-frequency surface.
  const sidebarNav = profile?.is_admin
    ? [
        ...navFull,
        ...(FEATURES.flow ? [{ to: '/flow', icon: Flame, label: 'Flow' }] : []),
        { to: '/admin', icon: Shield, label: 'Admin' },
      ]
    : navFull
  return (
    <div className="min-h-screen flex">
      {/* Desktop sidebar — visible at lg: and up. Mirrors the bottom-nav
          items as a vertical rail. Hidden on mobile where the bottom
          nav takes over. */}
      <aside
        className="hidden lg:flex flex-col w-56 shrink-0 border-r border-border/80 px-3 py-5 sticky top-0 h-screen"
        aria-label="Primary"
      >
        <div className="px-3 mb-6">
          <div className="text-lg font-display tracking-tight">Cash Moves</div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-muted mt-0.5">
            cashmoves.io
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {/* Primary CTA: add a position so its after-tax Exit Targets
              generate. (Log a Move is hidden — see lib/features.js.) */}
          <button
            type="button"
            onClick={() => navigate('/leaps?add=1')}
            className="tap-spring mb-2 inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-bg font-semibold text-sm"
          >
            <Plus size={15} strokeWidth={2.5} />
            Add a holding
          </button>
          {sidebarNav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                clsx(
                  'group relative flex items-center gap-3 px-3 py-2 rounded-lg transition',
                  isActive
                    ? 'bg-bg-elev text-fg'
                    : 'text-muted hover:text-fg hover:bg-bg-elev/60',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-5 rounded-r-full"
                      style={{
                        background: '#f0b44c',
                        boxShadow: '0 0 10px rgba(240, 180, 76,0.55)',
                      }}
                    />
                  )}
                  <Icon
                    size={17}
                    strokeWidth={isActive ? 2.2 : 1.7}
                    className={clsx(
                      'shrink-0 transition-transform',
                      isActive && 'drop-shadow-[0_0_6px_rgba(240, 180, 76,0.35)]',
                    )}
                  />
                  <span className="text-sm font-medium tracking-tight">
                    {label}
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-3 text-[10px] text-muted leading-relaxed">
          What you actually keep, after tax.
        </div>
      </aside>

      {/* Edge sheen — kept as subtle column framing on mobile only.
          On desktop the sidebar provides the visual separation. */}
      <div
        aria-hidden
        className="lg:hidden pointer-events-none fixed inset-y-0 left-1/2 -translate-x-[calc(50%+14rem)] w-px bg-gradient-to-b from-transparent via-white/5 to-transparent max-w-md"
      />

      <div className="flex-1 flex flex-col min-w-0" style={{ WebkitTransform: 'translate3d(0, 0, 0)' }}>
        <main
          className="flex-1 overflow-y-auto pt-safe pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-6"
          style={{ WebkitTransform: 'translate3d(0, 0, 0)' }}
        >
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* Solid strip under the status bar (owner, 2026-10-07): page content
          scrolled up behind the clock and battery on phones. */}
      <div aria-hidden className="lg:hidden fixed inset-x-0 top-0 z-40 bg-bg pointer-events-none" style={{ height: 'env(safe-area-inset-top)' }} />

      <InstallPrompt />
      <OnboardingGate />

      {/* Mobile-only bottom nav: five equal tabs, pinned to the bottom
          edge. Anchored with insets, not a centering transform — a
          transform on a fixed, blurred bar makes iOS Safari let it drift
          while scrolling. Solid, so page text never shows through the
          labels. The bar spans the screen; the tabs stay in the 448px
          column. iOS fix: -webkit-transform: translate3d(0,0,0) forces
          GPU rendering and prevents drift during momentum scroll. */}
      <nav
        className="lg:hidden fixed inset-x-0 bottom-0 z-50 bg-bg border-t border-border/80"
        style={{
          paddingBottom: 'calc(0.6rem + env(safe-area-inset-bottom))',
          WebkitTransform: 'translate3d(0, 0, 0)',
          WebkitBackfaceVisibility: 'hidden',
        }}
        aria-label="Primary"
      >
        <div className="mx-auto max-w-md px-2 pt-2 grid grid-cols-5 items-end">
          {navTabs.map(({ to, icon: Icon, label }) => (
            <BottomTab key={to} to={to} icon={Icon} label={label} />
          ))}
        </div>
      </nav>
    </div>
  )
}

function BottomTab({ to, icon: Icon, label }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        clsx(
          'group relative flex flex-col items-center gap-1 px-1 py-1.5 rounded-lg transition-all',
          isActive ? 'text-fg' : 'text-muted hover:text-subtle',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden
              className="absolute -top-2 left-1/2 -translate-x-1/2 w-7 h-[2px] rounded-full"
              style={{
                background:
                  'linear-gradient(90deg, transparent, #f0b44c 50%, transparent)',
                boxShadow: '0 0 12px rgba(240, 180, 76,0.65)',
              }}
            />
          )}
          <Icon
            size={19}
            strokeWidth={isActive ? 2.2 : 1.7}
            className={clsx(
              'transition-transform',
              isActive && 'drop-shadow-[0_0_8px_rgba(240, 180, 76,0.35)]',
            )}
          />
          <span
            className={clsx(
              'text-[10px] font-medium tracking-wide',
              isActive ? 'text-fg' : 'text-muted',
            )}
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  )
}

function PageLoader() {
  return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <Spinner size="lg" tone="amber" label="Loading page" />
    </div>
  )
}
