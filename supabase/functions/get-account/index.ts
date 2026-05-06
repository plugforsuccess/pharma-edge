// Cash Moves — get-account edge function.
//
// Returns the Tastytrade accounts the bot's credentials have access to,
// with balances. Scoped to the configured TASTYTRADE_USERNAME — for now
// that's a single bot user, so any signed-in app user sees the same set.
// When multi-broker / multi-tenant arrives, this becomes the place to
// scope by mapping table.
//
// Auth: requires a real user JWT (verify_jwt=true at the platform level
// + auth.getUser() check here). We don't trust user_id from the body;
// we only require that *some* authenticated user is asking.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tastytradeFetch, TastytradeError } from './tastytrade.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const TASTYTRADE_BASE_URL =
  Deno.env.get('TASTYTRADE_BASE_URL') || 'https://api.cert.tastyworks.com'
const IS_SANDBOX = TASTYTRADE_BASE_URL.includes('cert.tastyworks.com')

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ success: false, error: 'edge function misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) {
    return json({ success: false, error: 'unauthorized' }, 401)
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  let accountsResp: Response
  try {
    accountsResp = await tastytradeFetch(adminClient, '/customers/me/accounts')
  } catch (err) {
    const reason = err instanceof TastytradeError ? err.message : String(err)
    return json({ success: false, error: reason }, 502)
  }
  if (!accountsResp.ok) {
    const detail = await accountsResp.text().catch(() => '')
    return json(
      {
        success: false,
        error: `tastytrade ${accountsResp.status}`,
        detail: detail.slice(0, 500),
      },
      502,
    )
  }
  const accountsBody = await accountsResp.json().catch(() => ({}))
  const items = accountsBody?.data?.items ?? []

  const accounts = await Promise.all(
    items.map(async (item: Record<string, unknown>) => {
      const acc = (item as { account?: Record<string, unknown> }).account ?? {}
      const number = String(acc['account-number'] ?? '')
      let balance: Record<string, unknown> | null = null
      try {
        const bResp = await tastytradeFetch(
          adminClient,
          `/accounts/${encodeURIComponent(number)}/balances`,
        )
        if (bResp.ok) {
          const bBody = await bResp.json()
          balance = (bBody?.data as Record<string, unknown>) ?? null
        }
      } catch {
        balance = null
      }
      // Sandbox (cert) is itself a paper environment — everything in it is
      // simulated. Tastytrade's is-test-drive flag describes paper
      // subaccounts within the LIVE system, so it's false on sandbox even
      // though no real money is at risk. Treat all sandbox accounts as
      // paper for UX-warning purposes.
      const isPaper = IS_SANDBOX || Boolean(acc['is-test-drive'])
      return {
        account_number: number,
        account_type: acc['account-type-name'] ?? null,
        is_paper: isPaper,
        is_sandbox: IS_SANDBOX,
        net_liquidating_value: balance?.['net-liquidating-value'] ?? null,
        cash_balance: balance?.['cash-balance'] ?? null,
        buying_power: balance?.['derivative-buying-power'] ?? null,
      }
    }),
  )

  return json({ success: true, accounts })
})
