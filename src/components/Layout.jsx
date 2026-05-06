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

// Bottom nav (mobile) + sidebar nav (desktop). Naming conventions per
// the Cash Moves brand:
//   /        → "Tape"   (the home dashboard, "The Tape")
//   /markets → "Gamma"  (the GEX dashboard, "Gamma Map")
//   /flow    → "Flow"
//   /scanner → "Scanner"
//   /record  → "Record"
//   /settings→ "Settings"
const nav = [
  { to: '/', icon: Home, label: 'Tape' },
  { to: '/markets', icon: Activity, label: 'Gamma' },
  { to: '/flow', icon: Flame, label: 'Flow' },
  { to: '/scanner', icon: Sparkles, label: 'Scanner' },
  { to: '/record', icon: BarChart2, label: 'Record' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
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
          {nav.map(({ to, icon: Icon, label }) => (
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

      {/* Mobile-only bottom nav. Hidden on lg+ where the sidebar covers
          navigation. */}
      <nav
        className="lg:hidden fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md
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
