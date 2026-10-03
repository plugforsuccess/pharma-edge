// Daily bars for the Actions jobs (confluence ranking, universe replay).
//
// Yahoo answers GitHub's runners with 429 unless the request carries a
// session: the same cookie + crumb pair the edge functions use
// (supabase/functions/_shared/yahoo.ts) — fc.yahoo.com sets the cookies,
// /v1/test/getcrumb trades them for a crumb. When Yahoo still refuses, the
// bars come from our own `leaps-entry` edge function (5 years of daily
// bars, cached 15 min), called with the service-role key.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms))

let auth = null
let pending = null
async function bootstrap() {
  const r = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'manual', signal: AbortSignal.timeout(10000) })
  await r.body?.cancel().catch(() => {})
  const set = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : (r.headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z][A-Za-z0-9_-]*=)/)
  const cookie = set.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ')
  if (!cookie) throw new Error('no session cookies')
  for (const host of HOSTS) {
    const c = await fetch(`https://${host}/v1/test/getcrumb`, { headers: { 'User-Agent': UA, Cookie: cookie, Accept: '*/*' }, signal: AbortSignal.timeout(10000) })
    if (!c.ok) continue
    const crumb = (await c.text()).trim()
    if (crumb && crumb.length <= 64 && !crumb.includes('<')) return { cookie, crumb, at: Date.now() }
  }
  throw new Error('no crumb')
}
async function getAuth(force = false) {
  if (!force && auth && Date.now() - auth.at < 20 * 60 * 1000) return auth
  pending ??= bootstrap().then((a) => { auth = a; return a }).catch(() => { auth = null; return null }).finally(() => { pending = null })
  return pending
}

function parseChart(body) {
  const r = body?.chart?.result?.[0]
  const ts = r?.timestamp ?? []
  const q = r?.indicators?.quote?.[0] ?? {}
  const out = []
  ts.forEach((s, i) => {
    const c = Number(q.close?.[i])
    if (!Number.isFinite(c) || c <= 0) return
    const b = { t: etDay(s * 1000), c, o: Number(q.open?.[i]) || c, h: Number(q.high?.[i]) || c, l: Number(q.low?.[i]) || c, v: Number(q.volume?.[i]) || 0 }
    // Yahoo can repeat today's date as a live bar; keep the last.
    if (out.length && out[out.length - 1].t === b.t) out[out.length - 1] = b
    else out.push(b)
  })
  return out
}

async function fromYahoo(ticker, range, attempts = 3) {
  const symbol = ticker.replace(/\./g, '-')
  let last = 'no response'
  for (let attempt = 0; attempt < attempts; attempt++) {
    const a = await getAuth(attempt > 0)
    for (const host of HOSTS) {
      const crumb = a ? `&crumb=${encodeURIComponent(a.crumb)}` : ''
      try {
        const resp = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false${crumb}`, {
          headers: { 'User-Agent': UA, Accept: 'application/json', ...(a ? { Cookie: a.cookie } : {}) },
          signal: AbortSignal.timeout(10000),
        })
        if (resp.status === 404) return { bars: null, error: 'not found' }
        if (!resp.ok) { last = String(resp.status); continue }
        const bars = parseChart(await resp.json())
        if (bars.length) return { bars }
        last = 'empty'
      } catch (e) { last = e.message }
    }
    if (attempt < attempts - 1) await sleep(1500 * 2 ** attempt)
  }
  return { bars: null, error: last }
}

async function fromEdge(ticker) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return { bars: null, error: 'no edge fallback' }
  try {
    const resp = await fetch(`${url}/functions/v1/leaps-entry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker }),
      signal: AbortSignal.timeout(45000),
    })
    const body = await resp.json().catch(() => null)
    if (!resp.ok || !body?.success) return { bars: null, error: `edge ${resp.status} ${body?.error ?? ''}`.trim() }
    return { bars: body.bars.map((b) => ({ t: String(b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 })) }
  } catch (e) { return { bars: null, error: `edge ${e.message}` } }
}

export const sources = { yahoo: 0, edge: 0, blocked: false }
// Once Yahoo refuses a few tickers in a row the runner is rate-limited for
// the rest of the job: retrying every ticker three times would take hours,
// so from then on the edge function goes first and Yahoo is skipped.
let refusals = 0

// 5 years of daily bars: Yahoo with a session, else the edge function.
export async function dailyBars(ticker, { range = '5y' } = {}) {
  if (!sources.blocked) {
    const y = await fromYahoo(ticker, range, refusals >= 2 ? 1 : 3)
    if (y.bars) { sources.yahoo++; refusals = 0; return y.bars }
    if (y.error === 'not found') throw new Error(`${ticker}: not found`)
    if (/^(429|403|401)$/.test(y.error ?? '')) {
      refusals++
      if (refusals >= 4 && !sources.blocked) { sources.blocked = true; console.log('  Yahoo is refusing this runner — using the edge function for the rest.') }
    }
    const e = await fromEdge(ticker)
    if (e.bars) { sources.edge++; return e.bars }
    throw new Error(`${ticker}: yahoo ${y.error}; ${e.error}`)
  }
  const e = await fromEdge(ticker)
  if (e.bars) { sources.edge++; return e.bars }
  if (/not found|404/.test(e.error ?? '')) throw new Error(`${ticker}: not found`)
  throw new Error(`${ticker}: ${e.error}`)
}

// Run fn over items with `limit` workers and a pause between calls.
export async function mapLimit(items, limit, fn, pauseMs = 250) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const k = next++
      out[k] = await fn(items[k], k)
      await sleep(pauseMs)
    }
  }))
  return out
}
