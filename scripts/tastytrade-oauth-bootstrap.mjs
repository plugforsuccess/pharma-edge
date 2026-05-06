#!/usr/bin/env node
//
// One-shot Tastytrade prod OAuth bootstrap.
//
// Tastytrade prod doesn't expose a "mint refresh_token" button in the
// developer dashboard the way sandbox does — you have to do the
// authorization-code dance once. This script walks you through it:
//
//   1. Prints the authorize URL with your client_id + redirect_uri
//   2. You open it in a browser, log in, click Authorize
//   3. The browser redirects to your redirect_uri with ?code=XYZ
//      (the page may 404 — that's fine, you only need the URL)
//   4. Paste the URL (or just the code) back into this script
//   5. Script POSTs to /oauth/token, gets back access_token +
//      refresh_token, prints the secrets-set commands you need to run
//
// Usage:
//
//   TASTYTRADE_CLIENT_ID=...        \
//   TASTYTRADE_CLIENT_SECRET=...    \
//   TASTYTRADE_REDIRECT_URI=https://cashmoves.io/auth/tastytrade/callback \
//   node scripts/tastytrade-oauth-bootstrap.mjs
//
// Override the base URL for sandbox testing:
//   TASTYTRADE_BASE_URL=https://api.cert.tastyworks.com
//   TASTYTRADE_AUTH_URL=https://cert-my.staging-tasty.trade/auth.html

import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const CLIENT_ID = process.env.TASTYTRADE_CLIENT_ID
const CLIENT_SECRET = process.env.TASTYTRADE_CLIENT_SECRET
const REDIRECT_URI = process.env.TASTYTRADE_REDIRECT_URI
const API_BASE = process.env.TASTYTRADE_BASE_URL || 'https://api.tastyworks.com'
const AUTH_URL = process.env.TASTYTRADE_AUTH_URL || 'https://my.tastytrade.com/auth.html'

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  console.error('Missing env. Required: TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, TASTYTRADE_REDIRECT_URI')
  console.error('The redirect_uri MUST exactly match one registered on your OAuth app.')
  process.exit(1)
}

const state = `cm_${Math.random().toString(36).slice(2, 10)}`
const authorizeUrl = new URL(AUTH_URL)
authorizeUrl.searchParams.set('client_id', CLIENT_ID)
authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authorizeUrl.searchParams.set('response_type', 'code')
authorizeUrl.searchParams.set('scope', 'read trade openid')
authorizeUrl.searchParams.set('state', state)

console.log('\n────────────────────────────────────────────────────────')
console.log('STEP 1 — Open this URL in a browser, log in, approve:')
console.log('────────────────────────────────────────────────────────')
console.log(authorizeUrl.toString())
console.log('\nAfter approval Tastytrade redirects you to:')
console.log(`  ${REDIRECT_URI}?code=<long_string>&state=${state}`)
console.log('The page will probably 404 — that is expected.')
console.log('You only need the URL from your browser bar.\n')

const rl = readline.createInterface({ input, output })
const raw = (await rl.question('Paste the full redirect URL (or just the code): ')).trim()
rl.close()

let code
try {
  // Try parsing as URL first
  const u = new URL(raw)
  code = u.searchParams.get('code')
  const returnedState = u.searchParams.get('state')
  if (returnedState && returnedState !== state) {
    console.warn(`⚠ state mismatch: expected "${state}", got "${returnedState}". Continuing anyway.`)
  }
} catch {
  // Not a URL — treat as bare code
  code = raw
}

if (!code) {
  console.error('No code found in input. Aborting.')
  process.exit(1)
}

console.log('\n────────────────────────────────────────────────────────')
console.log('STEP 2 — Exchanging code for tokens...')
console.log('────────────────────────────────────────────────────────')

const form = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  redirect_uri: REDIRECT_URI,
})

const resp = await fetch(`${API_BASE}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form.toString(),
})

const body = await resp.text()
if (!resp.ok) {
  console.error(`❌ ${resp.status} ${resp.statusText}`)
  console.error(body)
  console.error('\nCommon causes:')
  console.error('  - code already used (they expire ~60s after issuance and are single-use)')
  console.error('  - redirect_uri mismatch (must be byte-identical to the one registered)')
  console.error('  - wrong client_secret')
  console.error('  - wrong base URL (sandbox vs prod)')
  process.exit(1)
}

let parsed
try {
  parsed = JSON.parse(body)
} catch {
  console.error('Response was not JSON:', body)
  process.exit(1)
}

const { access_token, refresh_token, expires_in, token_type, scope } = parsed
if (!refresh_token) {
  console.error('❌ Response had no refresh_token:')
  console.error(parsed)
  process.exit(1)
}

console.log('\n✅ Success.')
console.log(`   token_type:   ${token_type}`)
console.log(`   scope:        ${scope}`)
console.log(`   access_token: ${access_token.slice(0, 12)}…${access_token.slice(-4)} (${access_token.length} chars, expires in ${expires_in}s)`)
console.log(`   refresh_token: <copied below — keep it safe>`)

console.log('\n────────────────────────────────────────────────────────')
console.log('STEP 3 — Save the refresh_token. Run these commands:')
console.log('────────────────────────────────────────────────────────')
console.log()
console.log('# GitHub Actions secret (so the deploy-dxlink-worker workflow can sync to Fly):')
console.log('# Settings → Secrets and variables → Actions → New repository secret')
console.log(`#   Name:  TASTYTRADE_REFRESH_TOKEN`)
console.log(`#   Value: ${refresh_token}`)
console.log()
console.log('# Supabase (edge functions):')
console.log(`supabase secrets set \\`)
console.log(`  TASTYTRADE_REFRESH_TOKEN='${refresh_token}' \\`)
console.log(`  --project-ref rghoynbaykeyjbhqmaff`)
console.log()
console.log('# Fly (worker — only if you want to set directly instead of via the workflow):')
console.log(`fly secrets set TASTYTRADE_REFRESH_TOKEN='${refresh_token}' -a pharma-edge`)
console.log()
console.log('────────────────────────────────────────────────────────')
