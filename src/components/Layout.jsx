import { Suspense } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import {
  Activity,
  BarChart2,
  Flame,
  Home,
  Sparkles,
  Settings,
} from 'lucide-react'
import InstallPrompt from './InstallPrompt'
import clsx from 'clsx'

// Bottom nav. Calendar moved off-nav (still at /calendar route, linked
// from Home) so we can promote Flow — the dedicated options-prints
// stream — to a first-class destination next to Markets.
//   Home (today's view) | Markets (GEX) | Flow (prints) |
//   Scanner (biotech queue) | Record (track record) | Settings
const nav = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/markets', icon: Activity, label: 'Markets' },
  { to: '/flow', icon: Flame, label: 'Flow' },
  { to: '/scanner', icon: Sparkles, label: 'Scanner' },
  { to: '/record', icon: BarChart2, label: 'Record' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col max-w-md mx-auto relative">
      {/* Edge sheen — subtle vertical gradient framing the column */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -left-px w-px bg-gradient-to-b from-transparent via-white/5 to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -right-px w-px bg-gradient-to-b from-transparent via-white/5 to-transparent"
      />

      <main
        className="flex-1 overflow-y-auto pt-safe"
        style={{ paddingBottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
      >
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>

      <InstallPrompt />

      <nav
        className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md
                   glass border-t border-border/80 px-2 pt-2 z-50"
        style={{ paddingBottom: 'calc(0.6rem + env(safe-area-inset-bottom))' }}
        aria-label="Primary"
      >
        <div className="flex justify-around relative">
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                clsx(
                  'group relative flex flex-col items-center gap-1 px-2 py-1.5 rounded-lg transition-all min-w-11',
                  isActive
                    ? 'text-fg'
                    : 'text-muted hover:text-subtle',
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
          ))}
        </div>
      </nav>
    </div>
  )
}

function PageLoader() {
  return (
    <div className="min-h-[40vh] flex items-center justify-center">
      <div className="relative w-8 h-8">
        <div className="absolute inset-0 rounded-full border border-border" />
        <div
          className="absolute inset-0 rounded-full border-2 border-transparent animate-spin"
          style={{ borderTopColor: '#e8b558' }}
        />
      </div>
    </div>
  )
}
