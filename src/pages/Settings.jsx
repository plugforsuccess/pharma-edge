import { LogOut } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function Settings() {
  const { user, profile, signOut } = useAuth()

  return (
    <div className="px-4 pt-6 space-y-4">
      <h1 className="text-white text-xl font-bold tracking-tight">Settings</h1>

      <div className="bg-card border border-border rounded-xl p-4">
        <p className="text-muted text-[10px] uppercase tracking-wider">Account</p>
        <p className="text-white text-sm font-medium mt-1 break-all">{user?.email}</p>
        {profile?.public_slug && (
          <p className="text-subtle text-xs mt-2 font-mono">/r/{profile.public_slug}</p>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-4">
        <p className="text-muted text-[10px] uppercase tracking-wider mb-2">Status</p>
        <p className="text-subtle text-xs">
          Profile editing, public toggle, account size, and risk-setting controls arrive in
          Week 2.5.
        </p>
      </div>

      <button
        onClick={() => signOut()}
        className="w-full flex items-center justify-center gap-2 bg-card border border-border
                   hover:border-red-500 text-white font-semibold rounded-xl py-3 text-sm
                   transition-colors"
      >
        <LogOut size={14} />
        Sign Out
      </button>
    </div>
  )
}
