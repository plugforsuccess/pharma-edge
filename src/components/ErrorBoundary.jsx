import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('App crashed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-bg p-6">
          <div className="max-w-sm text-center">
            <p className="text-red-400 font-semibold mb-2">Something went wrong</p>
            <p className="text-subtle text-sm mb-4">
              The app hit an unexpected error. Reload to recover.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-red-600 hover:bg-red-500 text-white text-sm font-semibold rounded-xl px-4 py-2"
            >
              Reload
            </button>
            {import.meta.env.DEV && (
              <pre className="text-muted text-xs mt-4 text-left overflow-auto">
                {String(this.state.error?.stack || this.state.error)}
              </pre>
            )}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
