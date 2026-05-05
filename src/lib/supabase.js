import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
      'Copy .env.local.example to .env.local and fill in values from your Supabase project (Settings -> API).'
  )
}

export const supabase = createClient(url, anonKey)

// Exported so callers that need raw fetch (SSE streaming) can build
// their own request. supabase-js's `functions.invoke` doesn't support
// streaming responses — callers like AnalyzeFilingPanel use this.
export const SUPABASE_URL = url
export const SUPABASE_ANON_KEY = anonKey
