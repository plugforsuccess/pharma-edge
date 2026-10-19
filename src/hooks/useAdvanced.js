import { useEffect, useState } from 'react'

// Advanced view (owner, 2026-10-19: "LEAPS can be the advanced section").
// Off by default: Leaders show the stock, its momentum and its risks. On:
// the option play, its exits and the option past results come back. Saved
// on this device (Settings → Advanced); every component using the hook
// follows a change at once.
const KEY = 'cm:advanced'
const subs = new Set()
const read = () => { try { return localStorage.getItem(KEY) === '1' } catch { return false } }

export function setAdvanced(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* this visit only */ }
  subs.forEach((f) => f(on))
}

export function useAdvanced() {
  const [on, setOn] = useState(read)
  useEffect(() => { subs.add(setOn); return () => { subs.delete(setOn) } }, [])
  return [on, setAdvanced]
}
