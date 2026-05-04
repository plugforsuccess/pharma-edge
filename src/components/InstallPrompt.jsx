import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'

// `beforeinstallprompt` fires on Chromium-based browsers only.
// iOS Safari uses a manual Add-to-Home-Screen flow with no JS hook —
// users on iOS will simply not see this prompt.

const STORAGE_KEY = 'pharmaEdge:installPromptDismissed'

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return

    function handler(event) {
      event.preventDefault()
      setDeferredPrompt(event)
      setShow(true)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function install() {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    try {
      await deferredPrompt.userChoice
    } catch {
      /* noop */
    }
    setDeferredPrompt(null)
    setShow(false)
  }

  function dismiss() {
    setShow(false)
    localStorage.setItem(STORAGE_KEY, '1')
  }

  if (!show) return null

  return (
    <div className="fixed left-4 right-4 max-w-md mx-auto z-40"
      style={{ bottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
    >
      <div className="bg-card border border-red-900/40 rounded-2xl p-4 shadow-2xl">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-xs">PE</span>
            </div>
            <div>
              <p className="text-white text-sm font-semibold">Install Pharma Edge</p>
              <p className="text-subtle text-xs">Add to your home screen</p>
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss install prompt"
            className="text-muted hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
        <p className="text-subtle text-xs mb-3">
          Get instant alerts when catalysts are approaching. Works offline. No App Store
          required.
        </p>
        <button
          type="button"
          onClick={install}
          className="w-full flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 text-white font-semibold rounded-xl py-2.5 text-sm transition-colors"
        >
          <Download size={14} />
          Add to Home Screen
        </button>
      </div>
    </div>
  )
}
