import { Suspense } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import { Home, Calendar, BarChart2, BookOpen, Settings } from 'lucide-react'
import InstallPrompt from './InstallPrompt'
import clsx from 'clsx'

const nav = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/calendar', icon: Calendar, label: 'Calendar' },
  { to: '/record', icon: BarChart2, label: 'Record' },
  { to: '/rules', icon: BookOpen, label: 'Rules' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
  return (
    <div className="min-h-screen bg-bg flex flex-col max-w-md mx-auto relative">
      <main
        className="flex-1 overflow-y-auto pt-safe"
        style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
      >
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>

      <InstallPrompt />

      <nav
        className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md
                   bg-bg border-t border-border px-2 pt-2 z-50"
        style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
        aria-label="Primary"
      >
        <div className="flex justify-around">
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                clsx(
                  'flex flex-col items-center gap-1 px-3 py-1 rounded-lg transition-colors min-w-11',
                  isActive ? 'text-red-400' : 'text-zinc-600 hover:text-zinc-400'
                )
              }
            >
              <Icon size={20} />
              <span className="text-[10px] font-medium">{label}</span>
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
      <div className="w-6 h-6 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
