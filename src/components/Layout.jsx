import { Suspense } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  Activity,
  BarChart2,
  Briefcase,
  Flame,
  Home,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Shield,
  Trophy,
} from 'lucide-react'
import InstallPrompt from './InstallPrompt'
import Spinner from './Spinner'
import { useAuth } from '../context/AuthContext'
import clsx from 'clsx'

// Bottom nav (mobile) + sidebar nav (desktop). Naming conventions per
// the Cash Moves brand:
//   /        → "Tape"    (the home dashboard, "The Tape")
//   /markets → "Pulse"   (HeatPulse™ — GEX/VEX/CEX/DEX/Velocity/Trinity)
//   /flow    → "Flow"
//   /record  → "Record"
//   /settings→ "Settings"
//
// "Pulse" replaces the older "Gamma" label — /markets has grown beyond
// gamma-only into all five Greek exposures plus the Trinity multi-
// ticker comparison, so the single-Greek name was misleading. We
// don't use "Dashboard" here because The Tape is already the
// dashboard; double-labeling would collide.
//
// Mobile bottom nav has 4 tabs split 2/2 around a center FAB. Per the
// leaderboard focus-audit (2026-05-12), Flow demotes to an
// admin-only surface (it's a bot UI, not a user product), and
// Positions takes its slot since active-position management is the
// thing a user opens the app to check. Final shape:
//   [Tape] [Pulse] (LOG FAB) [Record] [Leaderboard]
// Record links to the user's own /record dashboard; Leaderboard is
// the public discovery surface. Settings still lives in the desktop
// sidebar + tape header avatar (mobile reaches it via avatar tap).
const navLeft = [
  { to: '/', icon: Home, label: 'Tape' },
  { to: '/markets', icon: Activity, label: 'Pulse' },
]
const navRight = [
  { to: '/record', icon: BarChart2, label: 'Record' },
  { to: '/leaderboard', icon: Trophy, label: 'Top' },
]
// Desktop sidebar. /flow lives here ONLY for is_admin users (gated
// in Layout(); regular users don't see it). /leaderboard added as a
// first-class tab. /reasoning kept between the visualization tabs
// and operational tabs as a desktop-only quick-access (mobile reaches
// it from the Markets page header).
// /wheel is desktop-sidebar + direct-URL only — the mobile bottom nav
// is full at 5 slots, and the wheel is a lower-frequency analysis
// surface than the Tape/Pulse/Record/Top primaries.
const navFull = [
  ...navLeft,
  ...navRight,
  { to: '/wheel', icon: RefreshCw, label: 'Wheel' },
  { to: '/reasoning', icon: Sparkles, label: 'Reasoning' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  // Owner-only Admin link; appended to the desktop sidebar nav when
  // the signed-in user has profiles.is_admin = true. Mobile users
  // reach /admin by typing the URL — it's a low-frequency surface.
  // /flow is admin-only per the focus audit (bot UI, not a user
  // product). Admins also get the /admin sidebar shortcut.
  const sidebarNav = profile?.is_admin
    ? [
        ...navFull,
        { to: '/flow', icon: Flame, label: 'Flow' },
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
            pharma-edge.vercel.app
          </div>
        </div>
        <nav className="flex flex-col gap-1">
          {/* Desktop: surface a primary "Log a Move" CTA at the top so
              the most-frequent action is always one click away,
              matching the mobile FAB pattern. */}
          <button
            type="button"
            onClick={() => navigate('/log')}
            className="tap-spring mb-2 inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-bg font-semibold text-sm"
          >
            <Plus size={15} strokeWidth={2.5} />
            Log a Move
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
                        background: '#e8b558',
                        boxShadow: '0 0 10px rgba(232,181,88,0.55)',
                      }}
                    />
                  )}
                  <Icon
                    size={17}
                    strokeWidth={isActive ? 2.2 : 1.7}
                    className={clsx(
                      'shrink-0 transition-transform',
                      isActive && 'drop-shadow-[0_0_6px_rgba(232,181,88,0.35)]',
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
          Dealer flow, suggested plays, immutable record.
        </div>
      </aside>

      {/* Edge sheen — kept as subtle column framing on mobile only.
          On desktop the sidebar provides the visual separation. */}
      <div
        aria-hidden
        className="lg:hidden pointer-events-none fixed inset-y-0 left-1/2 -translate-x-[calc(50%+14rem)] w-px bg-gradient-to-b from-transparent via-white/5 to-transparent max-w-md"
      />

      <div className="flex-1 flex flex-col min-w-0">
        <main
          className="flex-1 overflow-y-auto pt-safe pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-6"
        >
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <InstallPrompt />

      {/* Mobile-only bottom nav. 4 tabs split 2/2 around a center FAB
          that routes to /log. Settings moves to the desktop sidebar
          (still reachable via direct URL or from the Tape avatar
          area) — frees up bottom real estate so the primary action
          (writing a signal) gets the visual prominence it deserves. */}
      <nav
        className="lg:hidden fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md
                   glass border-t border-border/80 px-2 pt-2 z-50"
        style={{ paddingBottom: 'calc(0.6rem + env(safe-area-inset-bottom))' }}
        aria-label="Primary"
      >
        <div className="grid grid-cols-5 items-end relative">
          {navLeft.map(({ to, icon: Icon, label }) => (
            <BottomTab key={to} to={to} icon={Icon} label={label} />
          ))}
          <div className="flex justify-center relative">
            <button
              type="button"
              onClick={() => navigate('/log')}
              aria-label="Log a Move"
              className="tap-bounce absolute -top-7 w-14 h-14 rounded-full bg-amber-400 hover:bg-amber-300 text-bg shadow-[0_4px_16px_rgba(232,181,88,0.45)] hover:shadow-[0_6px_22px_rgba(232,181,88,0.55)] flex items-center justify-center"
            >
              <Plus size={22} strokeWidth={2.5} />
            </button>
            <span className="text-[10px] font-medium tracking-wide text-muted mt-7">
              Log
            </span>
          </div>
          {navRight.map(({ to, icon: Icon, label }) => (
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
                  'linear-gradient(90deg, transparent, #e8b558 50%, transparent)',
                boxShadow: '0 0 12px rgba(232,181,88,0.65)',
              }}
            />
          )}
          <Icon
            size={19}
            strokeWidth={isActive ? 2.2 : 1.7}
            className={clsx(
              'transition-transform',
              isActive && 'drop-shadow-[0_0_8px_rgba(232,181,88,0.35)]',
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
